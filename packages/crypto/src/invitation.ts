import {
  bytesEqual,
  canonicalize,
  checkKeys,
  checkVersion,
  concat,
  formatKey,
  fromB64Url,
  fromUtf8,
  isoDate,
  parseJsonObject,
  parseKey,
  str,
  toB64Url,
  utf8,
  type JsonObject,
} from './encoding';
import { DecryptionError, ExpiredError, FormatError, SignatureError, UnsupportedVersionError } from './errors';
import { generateX25519KeyPair, verifySharingCert, type Identity, type KeyPair, type SharingCert } from './identity';
import { signBody, verifyBody } from './sign';
import { S } from './sodium';

/*
 * Invitation flow
 * 1. Owner: createInvitation() -> temporary X25519 key pair valid <= 7 days, and a link
 *    fragment = base64url(canonicalJSON({type:"invitation-link",version:1,invitation:<signed doc>,secret:<b64url sk>})).
 *    The owner can immediately wrap content to invitation.keyPair.publicKey.
 * 2. Invitee: parseInvitationLink() -> verifies owner signature + expiry, gets the key pair,
 *    opens the content.
 * 3. Invitee: createInvitationResponse() ("lien retour") -> a document signed by the
 *    invitee's master key carrying their sharing-key certificate, sealed (crypto_box_seal)
 *    to the invitation public key so only the owner (and link holders) can read it.
 *    Binary: "TLIR" | version u8 | sealed box.
 * 4. Owner: openInvitationResponse() -> verified friend sharing key; then rewrapPack()
 *    the packs to the friend's key and without the invitation key.
 */

export const INVITATION_VERSION = 1;
export const INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESPONSE_MAGIC = utf8('TLIR');

export interface InvitationDoc {
  type: 'invitation';
  version: number;
  id: string;
  owner: string;
  key: string; // x25519 public key of the invitation
  created: string;
  expires: string;
  location?: string;
  signature: string;
}

/** Kept privately by the owner. */
export interface OwnerInvitation {
  id: string;
  keyPair: KeyPair;
  expires: string;
  doc: InvitationDoc;
}

/** What the invitee obtains from the link. */
export interface ReceivedInvitation {
  id: string;
  owner: string;
  ownerPublicKey: Uint8Array;
  keyPair: KeyPair;
  expires: string;
  location?: string;
}

export function createInvitation(
  identity: Identity,
  opts: { now?: Date; ttlMs?: number; location?: string } = {},
): { invitation: OwnerInvitation; fragment: string } {
  const now = opts.now ?? new Date();
  const ttl = opts.ttlMs ?? INVITATION_MAX_TTL_MS;
  if (!(ttl > 0 && ttl <= INVITATION_MAX_TTL_MS)) throw new FormatError('invitation: ttl must be in (0, 7 days]');
  const keyPair = generateX25519KeyPair();
  const body: JsonObject = {
    type: 'invitation',
    version: INVITATION_VERSION,
    id: toB64Url(S().randombytes_buf(16)),
    owner: identity.owner,
    key: formatKey('x25519', keyPair.publicKey),
    created: now.toISOString(),
    expires: new Date(now.getTime() + ttl).toISOString(),
  };
  if (opts.location !== undefined) body['location'] = opts.location;
  const doc = signBody('invitation', body, identity.master.secretKey) as unknown as InvitationDoc;
  const link = { type: 'invitation-link', version: INVITATION_VERSION, invitation: doc, secret: toB64Url(keyPair.secretKey) };
  return {
    invitation: { id: doc.id, keyPair, expires: doc.expires, doc },
    fragment: toB64Url(utf8(canonicalize(link))),
  };
}

export function isInvitationExpired(inv: { expires: string }, now: Date = new Date()): boolean {
  return now.getTime() >= Date.parse(inv.expires);
}

export function assertInvitationActive(inv: { expires: string }, now: Date = new Date()): void {
  if (isInvitationExpired(inv, now)) throw new ExpiredError(`invitation expired at ${inv.expires}`);
}

function verifyInvitationDoc(input: unknown): { doc: InvitationDoc; ownerPublicKey: Uint8Array; invPk: Uint8Array } {
  const W = 'invitation';
  const doc = parseJsonObject(input as JsonObject, W);
  checkVersion(doc, W, INVITATION_VERSION);
  checkKeys(doc, W, ['type', 'version', 'id', 'owner', 'key', 'created', 'expires', 'signature'], ['location']);
  if (doc['type'] !== 'invitation') throw new FormatError(`${W}: wrong type`);
  fromB64Url(doc['id'], `${W}.id`, 16);
  const ownerPublicKey = parseKey('ed25519', doc['owner'], `${W}.owner`);
  const invPk = parseKey('x25519', doc['key'], `${W}.key`);
  const created = isoDate(doc, 'created', W);
  const expires = isoDate(doc, 'expires', W);
  if (expires <= created || expires - created > INVITATION_MAX_TTL_MS) throw new FormatError(`${W}: validity must be at most 7 days`);
  if ('location' in doc) str(doc, 'location', W);
  verifyBody('invitation', doc, ownerPublicKey);
  return { doc: doc as unknown as InvitationDoc, ownerPublicKey, invPk };
}

/** Accepts the full link (anything after '#') or the bare fragment. Throws ExpiredError after expiry. */
export function parseInvitationLink(linkOrFragment: string, opts: { now?: Date } = {}): ReceivedInvitation {
  const W = 'invitation-link';
  const hash = linkOrFragment.indexOf('#');
  const fragment = hash >= 0 ? linkOrFragment.slice(hash + 1) : linkOrFragment;
  const link = parseJsonObject(fromUtf8(fromB64Url(fragment, W), W), W);
  checkVersion(link, W, INVITATION_VERSION);
  checkKeys(link, W, ['type', 'version', 'invitation', 'secret']);
  if (link['type'] !== 'invitation-link') throw new FormatError(`${W}: wrong type`);
  const { doc, ownerPublicKey, invPk } = verifyInvitationDoc(link['invitation']);
  const secretKey = fromB64Url(link['secret'], `${W}.secret`, 32);
  if (!bytesEqual(S().crypto_scalarmult_base(secretKey), invPk)) throw new FormatError(`${W}: secret does not match invitation key`);
  assertInvitationActive(doc, opts.now);
  const out: ReceivedInvitation = { id: doc.id, owner: doc.owner, ownerPublicKey, keyPair: { publicKey: invPk, secretKey }, expires: doc.expires };
  if (doc.location !== undefined) out.location = doc.location;
  return out;
}

// ---------------------------------------------------------------------------
// Return request ("lien retour")
// ---------------------------------------------------------------------------

export interface InvitationResponse {
  /** Invitee owner id "ed25519:..." */
  owner: string;
  ownerPublicKey: Uint8Array;
  sharingPublicKey: Uint8Array;
  cert: SharingCert;
}

export function createInvitationResponse(
  invitation: ReceivedInvitation,
  invitee: Identity,
  sharingCert: SharingCert,
  opts: { now?: Date } = {},
): Uint8Array {
  const now = opts.now ?? new Date();
  assertInvitationActive(invitation, now);
  verifySharingCert(sharingCert, { expectedOwner: invitee.owner });
  const doc = signBody(
    'invitation-response',
    {
      type: 'invitation-response',
      version: INVITATION_VERSION,
      invitation: invitation.id,
      owner: invitee.owner,
      cert: sharingCert as unknown as JsonObject,
      created: now.toISOString(),
    },
    invitee.master.secretKey,
  );
  const sealed = S().crypto_box_seal(utf8(canonicalize(doc)), invitation.keyPair.publicKey);
  return concat(RESPONSE_MAGIC, Uint8Array.of(INVITATION_VERSION), sealed);
}

/** Owner side. Rejects if the owner's invitation has expired (at `now`) or anything fails to verify. */
export function openInvitationResponse(bytes: Uint8Array, invitation: OwnerInvitation, opts: { now?: Date } = {}): InvitationResponse {
  const W = 'invitation-response';
  if (bytes.length < 5) throw new FormatError(`${W}: too short`);
  for (let i = 0; i < 4; i++) if (bytes[i] !== RESPONSE_MAGIC[i]) throw new FormatError(`${W}: bad magic`);
  const ver = bytes[4] as number;
  if (ver > INVITATION_VERSION) throw new UnsupportedVersionError(W, ver, INVITATION_VERSION);
  if (ver < 1) throw new FormatError(`${W}: bad version`);
  assertInvitationActive(invitation, opts.now);
  let plain: Uint8Array;
  try {
    plain = S().crypto_box_seal_open(bytes.subarray(5), invitation.keyPair.publicKey, invitation.keyPair.secretKey);
  } catch {
    throw new DecryptionError(`${W}: cannot open (not for this invitation or tampered)`);
  }
  const doc = parseJsonObject(fromUtf8(plain, W), W);
  checkVersion(doc, W, INVITATION_VERSION);
  checkKeys(doc, W, ['type', 'version', 'invitation', 'owner', 'cert', 'created', 'signature']);
  if (doc['type'] !== 'invitation-response') throw new FormatError(`${W}: wrong type`);
  if (doc['invitation'] !== invitation.id) throw new FormatError(`${W}: answers another invitation`);
  isoDate(doc, 'created', W);
  const ownerPublicKey = parseKey('ed25519', doc['owner'], `${W}.owner`);
  verifyBody('invitation-response', doc, ownerPublicKey);
  const owner = str(doc, 'owner', W);
  const v = verifySharingCert(doc['cert'] as JsonObject, { expectedOwner: owner });
  if (v.cert.owner !== owner) throw new SignatureError(`${W}: certificate owner mismatch`, 'OWNER_MISMATCH');
  return { owner, ownerPublicKey, sharingPublicKey: v.sharingPublicKey, cert: v.cert };
}
