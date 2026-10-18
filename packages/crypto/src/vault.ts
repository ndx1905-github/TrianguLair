import { verifySharingCert, type SharingCert } from './certs';
import {
  arr,
  asObject,
  bytesEqual,
  canonicalize,
  checkByteVersion,
  checkFields,
  checkStructure,
  concat,
  deepFreeze,
  fromB64Url,
  fromUtf8,
  isoDate,
  parseJsonObject,
  parseKey,
  readU32be,
  sortedUnique,
  str,
  toB64Url,
  u32be,
  utf8,
  type JsonObject,
} from './encoding';
import { DecryptionError, FormatError, SignatureError } from './errors';
import type { OwnerInvitation } from './invitation';
import { paddedLength } from './pack';
import { indexAnchor, verifyIndexAnchor, type IndexAnchor, type SignedIndex } from './signed-index';
import { S } from './sodium';

/*
 * Recovery vault records (spec "Recovery kit", V3-10): the owner's private state that the security
 * rules depend on, encrypted with the random VAULT DATA KEY (SharingKey.vaultDataKey), which every
 * device of the owner holds (TLSK) and the phrase-protected TLSK copy keeps. Renew it when a device
 * is declared lost: generateVaultDataKey(), sealVault() again, sealSharingKey() to each remaining
 * device and to the identity.
 *
 * Envelope, big-endian:
 *   0  4   magic "TLVD"
 *   4  1   version (= 1)
 *   5  24  nonce
 *   29 ..  XChaCha20-Poly1305(plaintext, AD = bytes[0..5) || owner master public key 32 || nonce,
 *          key = vault data key)
 *   plaintext = u32 length || canonical JSON records || zero padding (Padmé, at least 256 bytes)
 *
 * Records (canonical JSON, versioned like every JSON structure: "minor" / "crit"):
 * {"app":{…},                               // optional, free-form app data (storage credentials, groups, settings)
 *  "contacts":[{"anchor":<index-anchor>,     // last index accepted for this contact (rollback protection), if they publish
 *               "owner":"ed25519:…",
 *               "sharing_cert":<sharing cert>, // their current key, and their certified read address
 *               "verified":true}],          // the user's "verified" mark (local declaration)
 *  "invitations":[{"accepted":"ed25519:…",   // optional: the responder accepted so far
 *                  "answers":["<b64url return link>"], // every answer received (max 16)
 *                  "created":"…","expires":"…","id":"<16B>","secret":"<32B invitation key>"}],
 *  "owner":"ed25519:…",
 *  "retired_owners":["ed25519:…"],          // identities that moved away (never trusted again)
 *  "type":"vault-records","version":1}
 * Lists are sorted (contacts by owner, invitations by id) and unique. An invitation record is kept
 * until expiry + INVITATION_ANSWER_GRACE_MS, so any device can collect late answers and run the
 * expiry sweep (retireInvitationKey).
 */

export const VAULT_VERSION = 1;
const MAGIC = utf8('TLVD');
const MAX_CONTACTS = 10_000;
const MAX_INVITATIONS = 256;
const MAX_ANSWERS = 16;
const MAX_RETIRED = 256;
const MAX_ANSWER_CHARS = 13_000;
const W = 'vault-records';

export interface VaultContact {
  owner: string;
  sharing_cert: SharingCert;
  anchor?: IndexAnchor;
  verified: boolean;
}

export interface VaultInvitation {
  id: string;
  /** Invitation X25519 secret key (b64url). */
  secret: string;
  created: string;
  expires: string;
  accepted?: string;
  /** Every return link received for it (b64url of the bytes). */
  answers: string[];
}

export interface VaultRecords {
  type: 'vault-records';
  version: number;
  owner: string;
  contacts: VaultContact[];
  invitations: VaultInvitation[];
  retired_owners: string[];
  app?: JsonObject;
}

/** Empty records for `owner`. */
export function emptyVault(owner: string): VaultRecords {
  parseKey('ed25519', owner, 'vault.owner');
  return { type: W, version: VAULT_VERSION, owner, contacts: [], invitations: [], retired_owners: [] };
}

/** Vault contact from the last index accepted for a friend (verified) and the "verified" mark. */
export function contactRecord(index: SignedIndex, verified = false): VaultContact {
  const anchor = indexAnchor(index);
  return { owner: anchor.owner, sharing_cert: anchor.sharing_cert, anchor, verified };
}

/** Vault record of an open invitation, with every answer received so far and the accepted responder. */
export function invitationRecord(inv: OwnerInvitation, opts: { answers?: Uint8Array[]; accepted?: string } = {}): VaultInvitation {
  const rec: VaultInvitation = {
    id: inv.id,
    secret: toB64Url(inv.keyPair.secretKey),
    created: inv.created,
    expires: inv.expires,
    answers: [...new Set((opts.answers ?? []).map(toB64Url))],
  };
  if (opts.accepted !== undefined) rec.accepted = opts.accepted;
  return rec;
}

/** The OwnerInvitation (for collectInvitationAnswers / retireInvitationKey) and the answers kept in a record. */
export function invitationFromRecord(rec: VaultInvitation, owner: string): { invitation: OwnerInvitation; answers: Uint8Array[]; accepted?: string } {
  const secretKey = fromB64Url(rec.secret, 'vault.invitation.secret', 32);
  const invitation: OwnerInvitation = {
    id: rec.id,
    owner,
    keyPair: { publicKey: S().crypto_scalarmult_base(secretKey), secretKey },
    created: rec.created,
    expires: rec.expires,
  };
  const out: { invitation: OwnerInvitation; answers: Uint8Array[]; accepted?: string } = { invitation, answers: rec.answers.map((a) => fromB64Url(a, 'vault.invitation.answers[]')) };
  if (rec.accepted !== undefined) out.accepted = rec.accepted;
  return out;
}

function sorted<T>(list: readonly T[], key: (t: T) => string): T[] {
  return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function checkSortedBy(list: unknown[], key: (o: JsonObject) => string, what: string): void {
  for (let i = 1; i < list.length; i++) {
    if (!(key(list[i - 1] as JsonObject) < key(list[i] as JsonObject))) throw new FormatError(`${W}: ${what} must be sorted and unique`);
  }
}

/** Validates parsed records (structure, versioning, master signatures of the certificates inside). */
function validate(doc: JsonObject, owner: string): VaultRecords {
  const { extensible } = checkStructure(doc, W, VAULT_VERSION, ['type', 'version', 'owner', 'contacts', 'invitations', 'retired_owners'], ['app']);
  if (doc['type'] !== W) throw new FormatError(`${W}: wrong type`);
  if (str(doc, 'owner', W) !== owner) throw new SignatureError(`${W}: belongs to another owner`, 'OWNER_MISMATCH');
  if ('app' in doc) asObject(doc['app'], `${W}.app`);

  const contacts = arr(doc, 'contacts', W, MAX_CONTACTS);
  for (const c of contacts) {
    const o = asObject(c, `${W}.contacts[]`);
    checkFields(o, `${W}.contacts[]`, ['owner', 'sharing_cert', 'verified'], ['anchor'], extensible);
    const who = str(o, 'owner', `${W}.contacts[]`);
    parseKey('ed25519', who, `${W}.contacts[].owner`);
    if (typeof o['verified'] !== 'boolean') throw new FormatError(`${W}.contacts[]: verified must be a boolean`);
    verifySharingCert(asObject(o['sharing_cert'], `${W}.contacts[].sharing_cert`), { expectedOwner: who });
    if ('anchor' in o) verifyIndexAnchor(asObject(o['anchor'], `${W}.contacts[].anchor`), { expectedOwner: who });
  }
  checkSortedBy(contacts, (o) => o['owner'] as string, 'contacts');

  const invitations = arr(doc, 'invitations', W, MAX_INVITATIONS);
  for (const i of invitations) {
    const o = asObject(i, `${W}.invitations[]`);
    const X = `${W}.invitations[]`;
    checkFields(o, X, ['id', 'secret', 'created', 'expires', 'answers'], ['accepted'], extensible);
    fromB64Url(o['id'], `${X}.id`, 16);
    fromB64Url(o['secret'], `${X}.secret`, 32);
    if (isoDate(o, 'expires', X) <= isoDate(o, 'created', X)) throw new FormatError(`${X}: expires must follow created`);
    if ('accepted' in o) parseKey('ed25519', o['accepted'], `${X}.accepted`);
    const answers = arr(o, 'answers', X, MAX_ANSWERS);
    for (const a of answers) {
      if (typeof a !== 'string' || a.length > MAX_ANSWER_CHARS) throw new FormatError(`${X}: bad answer`);
      fromB64Url(a, `${X}.answers[]`);
    }
    sortedUnique(answers, X, 'answers');
  }
  checkSortedBy(invitations, (o) => o['id'] as string, 'invitations');

  const retired = arr(doc, 'retired_owners', W, MAX_RETIRED);
  for (const r of sortedUnique(retired, W, 'retired_owners')) parseKey('ed25519', r, `${W}.retired_owners[]`);

  // Return the verified (frozen) certificates and anchors in place of the raw objects.
  const out = JSON.parse(canonicalize(doc)) as JsonObject;
  out['contacts'] = (out['contacts'] as JsonObject[]).map((c) => {
    const who = c['owner'] as string;
    const v: JsonObject = { ...c, sharing_cert: verifySharingCert(c['sharing_cert'] as JsonObject, { expectedOwner: who }).cert };
    if ('anchor' in c) v['anchor'] = verifyIndexAnchor(c['anchor'] as JsonObject, { expectedOwner: who });
    return v;
  });
  return deepFreeze(out as unknown as VaultRecords);
}

function normalize(records: VaultRecords): JsonObject {
  const doc = JSON.parse(canonicalize(records)) as JsonObject;
  doc['contacts'] = sorted(doc['contacts'] as JsonObject[], (c) => String(c['owner']));
  doc['invitations'] = sorted(
    (doc['invitations'] as JsonObject[]).map((i): JsonObject => ({ ...i, answers: [...new Set(i['answers'] as string[])].sort() })),
    (i) => String(i['id']),
  );
  doc['retired_owners'] = [...new Set(doc['retired_owners'] as string[])].sort();
  return doc;
}

/** Encrypts the records with the vault data key (lists are sorted and de-duplicated first). */
export function sealVault(records: VaultRecords, vaultDataKey: Uint8Array): Uint8Array {
  const s = S();
  if (!(vaultDataKey instanceof Uint8Array) || vaultDataKey.length !== 32) throw new FormatError('vault: vault data key must be 32 bytes');
  const doc = normalize(records);
  validate(doc, records.owner);
  const json = utf8(canonicalize(doc));
  if (json.length > 0xffffffff - 4) throw new FormatError('vault: too large');
  const pt = new Uint8Array(paddedLength(4 + json.length));
  pt.set(u32be(json.length), 0);
  pt.set(json, 4);
  const head = concat(MAGIC, Uint8Array.of(VAULT_VERSION));
  const nonce = s.randombytes_buf(24);
  try {
    const ad = concat(head, parseKey('ed25519', records.owner, 'vault.owner'), nonce);
    return concat(head, nonce, s.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, ad, null, nonce, vaultDataKey));
  } finally {
    s.memzero(pt);
    s.memzero(json);
  }
}

/** Decrypts and validates the records of `owner` (frozen; certificates and anchors verified). */
export function openVault(bytes: Uint8Array, owner: string, vaultDataKey: Uint8Array): VaultRecords {
  const s = S();
  if (!(bytes instanceof Uint8Array) || bytes.length < 5 + 24 + 16) throw new FormatError('vault: too short');
  if (!bytesEqual(bytes.subarray(0, 4), MAGIC)) throw new FormatError('vault: bad magic');
  checkByteVersion(bytes[4] as number, 'vault', VAULT_VERSION);
  const nonce = bytes.subarray(5, 29);
  const ad = concat(bytes.subarray(0, 5), parseKey('ed25519', owner, 'vault.owner'), nonce);
  let pt: Uint8Array;
  try {
    pt = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes.subarray(29), ad, nonce, vaultDataKey);
  } catch {
    throw new DecryptionError('vault: cannot open (another key or owner, or tampered)');
  }
  try {
    if (pt.length < 4) throw new FormatError('vault: plaintext too short');
    const len = readU32be(pt, 0);
    if (len > pt.length - 4 || pt.length !== paddedLength(4 + len)) throw new FormatError('vault: bad padding length');
    for (let i = 4 + len; i < pt.length; i++) if (pt[i] !== 0) throw new FormatError('vault: non-zero padding');
    return validate(parseJsonObject(fromUtf8(pt.subarray(4, 4 + len), W), W), owner);
  } finally {
    s.memzero(pt);
  }
}

function later(a: IndexAnchor | undefined, b: IndexAnchor | undefined): IndexAnchor | undefined {
  if (!a || !b) return a ?? b;
  const ra = a.sharing_cert.rotation;
  const rb = b.sharing_cert.rotation;
  return rb > ra || (rb === ra && b.seq > a.seq) ? b : a;
}

/**
 * Merges two versions of the records of the same owner (two devices wrote concurrently): union of
 * contacts (the later certificate and anchor by rotation then seq; on a tie, `a` wins; "verified"
 * if either says so), of invitations (answers united, `a`'s accepted responder first) and of retired
 * owners; `app` is taken from `a` (merging app data is the app's job). Re-seal the result.
 */
export function mergeVaults(a: VaultRecords, b: VaultRecords): VaultRecords {
  if (a.owner !== b.owner) throw new SignatureError('vault: records of two different owners', 'OWNER_MISMATCH');
  const contacts = new Map<string, VaultContact>();
  for (const c of a.contacts) contacts.set(c.owner, c);
  for (const c of b.contacts) {
    const x = contacts.get(c.owner);
    if (!x) {
      contacts.set(c.owner, c);
      continue;
    }
    const merged: VaultContact = {
      owner: c.owner,
      sharing_cert: c.sharing_cert.rotation > x.sharing_cert.rotation ? c.sharing_cert : x.sharing_cert,
      verified: x.verified || c.verified,
    };
    const anchor = later(x.anchor, c.anchor);
    if (anchor) merged.anchor = anchor;
    contacts.set(c.owner, merged);
  }
  const invitations = new Map<string, VaultInvitation>();
  for (const i of a.invitations) invitations.set(i.id, i);
  for (const i of b.invitations) {
    const x = invitations.get(i.id);
    if (!x) {
      invitations.set(i.id, i);
      continue;
    }
    const merged: VaultInvitation = { ...x, answers: [...new Set([...x.answers, ...i.answers])].sort().slice(0, MAX_ANSWERS) };
    const accepted = x.accepted ?? i.accepted;
    if (accepted !== undefined) merged.accepted = accepted;
    invitations.set(i.id, merged);
  }
  const out: VaultRecords = {
    type: W,
    version: VAULT_VERSION,
    owner: a.owner,
    contacts: sorted([...contacts.values()], (c) => c.owner),
    invitations: sorted([...invitations.values()], (i) => i.id),
    retired_owners: [...new Set([...a.retired_owners, ...b.retired_owners])].sort(),
  };
  const app = a.app ?? b.app;
  if (app !== undefined) out.app = app;
  return out;
}
