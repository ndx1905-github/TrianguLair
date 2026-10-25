/*
 * Operations of the known-answer vectors (docs/format/vectors/*.json, docs/format/README.md
 * "Vector files"). Each vector names an `op` and gives its `input`; `run(op, input)` returns
 *   {"ok": <summary>}  or  {"error": <ErrorCode>, ...details}
 * and the vector's `expect` must be exactly that. The same table is implemented by the Python
 * reference reader (docs/format/reference-reader/) for the ops it supports.
 * Binary values are lowercase hex in fields ending with `_hex`; JSON documents are their exact text.
 */
import {
  canonicalize,
  checkInvitationIndex,
  checkLocation,
  collectInvitationAnswers,
  decodeKeyExport,
  decodePrimaryIdentity,
  decryptTransfer,
  formatKey,
  identityFromPhrase,
  IdentityMovedError,
  indexAnchor,
  invitationFromRecord,
  invitationStatus,
  invitationToken,
  mergeVaults,
  normalizeTransferCode,
  openGroupKey,
  openInvitationResponse,
  openPack,
  openSharingKey,
  openVault,
  paddedLength,
  parseInvitationLink,
  parseKey,
  readPackHeader,
  RollbackError,
  safetyCode,
  safetyQrPayload,
  StorageMovedError,
  TLCryptoError,
  UnsupportedVersionError,
  verifyDeviceCert,
  verifyIdentityMove,
  verifyIndex,
  verifySharingCert,
  type DeviceKeys,
  type IndexAnchor,
  type InvitationResponse,
  type KeyPair,
  type OwnerInvitation,
  type SharingCert,
  type SignedIndex,
  type VaultInvitation,
  type VerifyIndexOptions,
} from '../../src/index';
import { parseJsonObject } from '../../src/encoding';
import { listingPadKey, padListing } from '../../src/invitation-listing';
import { verifyBinary, type SignatureDomain } from '../../src/sign';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObj = { [k: string]: Json };

export function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

/** A fresh plain Uint8Array (never a Buffer view: the library wipes some of its inputs' copies). */
export function unhex(h: Json | undefined): Uint8Array {
  if (typeof h !== 'string' || !/^([0-9a-f]{2})*$/.test(h)) throw new Error(`vector: bad hex ${String(h)}`);
  return new Uint8Array(Buffer.from(h, 'hex'));
}

function s(v: Json | undefined, what: string): string {
  if (typeof v !== 'string') throw new Error(`vector: ${what} must be a string`);
  return v;
}

function o(v: Json | undefined, what: string): JsonObj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`vector: ${what} must be an object`);
  return v;
}

function date(v: Json | undefined): Date {
  return new Date(s(v, 'now'));
}

function keyPair(k: Json): KeyPair {
  const x = o(k, 'key');
  return { publicKey: unhex(x['public_hex']), secretKey: unhex(x['secret_hex']) };
}

function cert(text: Json | undefined): SharingCert {
  return verifySharingCert(s(text, 'cert')).cert;
}

/** Index verification options of a vector: {expectedOwner?, retiredOwners?, lastSeen? (index text), lastSeenAnchor? (anchor JSON text), location?, now}. */
function indexOptions(v: Json | undefined): VerifyIndexOptions {
  const x = v === undefined ? {} : o(v, 'options');
  const out: VerifyIndexOptions = { now: date(x['now']) };
  if (x['expectedOwner'] !== undefined) out.expectedOwner = s(x['expectedOwner'], 'expectedOwner');
  if (x['retiredOwners'] !== undefined) out.retiredOwners = (x['retiredOwners'] as Json[]).map((r) => s(r, 'retired'));
  if (x['location'] !== undefined) out.location = s(x['location'], 'location');
  if (x['lastSeen'] !== undefined) out.lastSeen = verifyIndex(s(x['lastSeen'], 'lastSeen'), { now: date(x['now']) });
  if (x['lastSeenAnchor'] !== undefined) out.lastSeen = JSON.parse(s(x['lastSeenAnchor'], 'anchor')) as IndexAnchor;
  return out;
}

function indexSummary(idx: SignedIndex): JsonObj {
  const out: JsonObj = {
    owner: idx.owner,
    seq: idx.seq,
    rotation: idx.sharing_cert.rotation,
    location: idx.sharing_cert.location,
    device: idx.device_cert.device,
    revoked_devices: [...idx.revoked_devices],
    packs: idx.packs.map((p) => p.hash),
    invitations: [...(idx.invitations ?? [])],
  };
  if (idx.public) out['public'] = idx.public.hash;
  if (idx.move) out['move_from'] = idx.move.from;
  if (idx.minor !== undefined) out['minor'] = idx.minor;
  return out;
}

function certSummary(c: SharingCert): JsonObj {
  const out: JsonObj = { owner: c.owner, key: c.key, rotation: c.rotation, revoked_devices: [...c.revoked_devices] };
  if (c.location !== undefined) out['location'] = c.location;
  return out;
}

function responseSummary(r: InvitationResponse): JsonObj {
  const out: JsonObj = { owner: r.owner, device: r.device, created: r.created, rotation: r.cert.rotation, openedAfterExpiry: r.openedAfterExpiry };
  if (r.location !== undefined) out['location'] = r.location;
  return out;
}

/** OwnerInvitation from a vector's vault-record form {record (JSON text), owner}, checked like invitationFromRecord. */
function ownerInvitation(v: Json | undefined): OwnerInvitation {
  const x = o(v, 'invitation');
  return invitationFromRecord(JSON.parse(s(x['record'], 'record')) as VaultInvitation, s(x['owner'], 'owner')).invitation;
}

function sharingKeyResult(k: { keyPair: KeyPair; cert: SharingCert; vaultDataKey: Uint8Array }): JsonObj {
  return { cert: canonicalize(k.cert), secret_hex: hex(k.keyPair.secretKey), public_hex: hex(k.keyPair.publicKey), vault_key_hex: hex(k.vaultDataKey) };
}

type Op = (i: JsonObj) => JsonObj;

const OPS: Record<string, Op> = {
  canonical_json: (i) => ({ canonical: canonicalize(parseJsonObject(s(i['text'], 'text'), 'doc')) }),

  parse_key: (i) => ({ hex: hex(parseKey(s(i['kind'], 'kind') as 'ed25519' | 'x25519', i['value'] as string, 'key')) }),

  check_location: (i) => {
    checkLocation(s(i['location'], 'location'));
    return {};
  },

  signature: (i) => {
    verifyBinary(s(i['domain'], 'domain') as SignatureDomain, unhex(i['signature_hex']), unhex(i['message_hex']), unhex(i['public_key_hex']));
    return {};
  },

  identity_from_phrase: (i) => {
    const id = identityFromPhrase(s(i['phrase'], 'phrase'));
    return { owner: id.owner, master_seed_hex: hex(id.master.secretKey.subarray(0, 32)), vault_key_hex: hex(id.vaultKey) };
  },

  decode_primary_identity: (i) => {
    const id = decodePrimaryIdentity(unhex(i['bytes_hex']));
    return { owner: id.owner, vault_key_hex: hex(id.vaultKey) };
  },

  open_sharing_key: (i) => {
    const h = o(i['holder'], 'holder');
    let holder;
    if (h['phrase'] !== undefined) holder = identityFromPhrase(s(h['phrase'], 'phrase'));
    else {
      const box = { publicKey: unhex(h['box_public_hex']), secretKey: unhex(h['box_secret_hex']) };
      holder = { id: s(h['device'], 'device'), box, sign: box } as DeviceKeys;
    }
    const x = i['options'] === undefined ? {} : o(i['options'], 'options');
    const opts: { expectedOwner?: string; lastSeen?: SharingCert } = {};
    if (x['expectedOwner'] !== undefined) opts.expectedOwner = s(x['expectedOwner'], 'expectedOwner');
    if (x['lastSeen'] !== undefined) opts.lastSeen = cert(x['lastSeen']);
    return sharingKeyResult(openSharingKey(unhex(i['bytes_hex']), holder, opts));
  },

  verify_sharing_cert: (i) => {
    const x = i['options'] === undefined ? {} : o(i['options'], 'options');
    const opts: { expectedOwner?: string; retiredOwners?: string[]; lastSeen?: SharingCert } = {};
    if (x['expectedOwner'] !== undefined) opts.expectedOwner = s(x['expectedOwner'], 'expectedOwner');
    if (x['retiredOwners'] !== undefined) opts.retiredOwners = (x['retiredOwners'] as Json[]).map((r) => s(r, 'retired'));
    if (x['lastSeen'] !== undefined) opts.lastSeen = cert(x['lastSeen']);
    return certSummary(verifySharingCert(s(i['text'], 'text'), opts).cert);
  },

  verify_device_cert: (i) => {
    const x = i['options'] === undefined ? {} : o(i['options'], 'options');
    const opts: { expectedOwner?: string; retiredOwners?: string[] } = {};
    if (x['expectedOwner'] !== undefined) opts.expectedOwner = s(x['expectedOwner'], 'expectedOwner');
    if (x['retiredOwners'] !== undefined) opts.retiredOwners = (x['retiredOwners'] as Json[]).map((r) => s(r, 'retired'));
    const dc = verifyDeviceCert(s(i['text'], 'text'), opts);
    return { owner: dc.owner, device: dc.device, box: dc.box };
  },

  verify_identity_move: (i) => {
    const x = i['options'] === undefined ? {} : o(i['options'], 'options');
    const m = verifyIdentityMove(s(i['text'], 'text'), x['expectedFrom'] !== undefined ? { expectedFrom: s(x['expectedFrom'], 'expectedFrom') } : {});
    return { from: m.from, to: m.to, issued: m.issued };
  },

  /** `text` (the transported string) or `bytes_hex` (the transported bytes). */
  verify_index: (i) => indexSummary(verifyIndex(i['bytes_hex'] !== undefined ? unhex(i['bytes_hex']) : s(i['text'], 'text'), indexOptions(i['options']))),

  index_anchor: (i) => ({ anchor: canonicalize(indexAnchor(verifyIndex(s(i['text'], 'text'), indexOptions(i['options'])))) }),

  listing_padding: (i) => {
    const key = unhex(i['vault_key_hex']);
    const tokens = (i['tokens'] as Json[]).map((t) => s(t, 'token'));
    return { pad_key_hex: hex(listingPadKey(key)), list: padListing(tokens, listingPadKey(key), date(i['now']).getTime()) };
  },

  invitation_token: (i) => ({
    token: invitationToken(unhex(i['owner_public_hex']), unhex(i['invitation_public_hex']), i['rotation'] as number, i['expires'] as number, s(i['location'], 'location')),
  }),

  padded_length: (i) => ({ length: paddedLength(i['n'] as number) }),

  read_pack_header: (i) => {
    const h = readPackHeader(unhex(i['bytes_hex']));
    return { nonce: h.nonce, pad: h.pad, wraps: h.wraps.length };
  },

  open_pack: (i) => {
    const ix = o(i['index'], 'index');
    const index = verifyIndex(s(ix['text'], 'index.text'), indexOptions(ix['options']));
    const p = openPack(unhex(i['bytes_hex']), index, (i['keys'] as Json[]).map(keyPair));
    return { id: p.id, type: p.type, file: p.file, payload_hex: hex(p.payload) };
  },

  open_group_key: (i) => {
    const ix = o(i['index'], 'index');
    const index = verifyIndex(s(ix['text'], 'index.text'), indexOptions(ix['options']));
    const g = openGroupKey(unhex(i['bytes_hex']), index, (i['keys'] as Json[]).map(keyPair));
    return { owner: g.owner, group: g.id, generation: g.generation, secret_hex: hex(g.keyPair.secretKey), public_hex: hex(g.keyPair.publicKey) };
  },

  parse_invitation_link: (i) => {
    const r = parseInvitationLink(s(i['link'], 'link'), { now: date(i['now']) });
    return {
      id: r.id,
      owner: r.owner,
      location: r.location,
      rotation: r.rotation,
      expires: r.expires,
      invitation_public_hex: hex(r.keyPair.publicKey),
      invitation_secret_hex: hex(r.keyPair.secretKey),
      token: r.token,
    };
  },

  /** parseInvitationLink, verifyIndex at `read_from` (default: the link's address), checkInvitationIndex. */
  accept_invitation: (i) => {
    const now = date(i['now']);
    const received = parseInvitationLink(s(i['link'], 'link'), { now });
    const opts: VerifyIndexOptions = { expectedOwner: received.owner, location: i['read_from'] !== undefined ? s(i['read_from'], 'read_from') : received.location, now };
    const lastSeen = i['lastSeen'] !== undefined ? verifyIndex(s(i['lastSeen'], 'lastSeen'), { now }) : undefined;
    if (lastSeen) opts.lastSeen = lastSeen;
    const idx = verifyIndex(s(i['index'], 'index'), opts);
    checkInvitationIndex(received, idx, lastSeen ? { now, lastSeen } : { now });
    return { owner: received.owner, token: received.token, rotation: idx.sharing_cert.rotation, seq: idx.seq };
  },

  open_invitation_response: (i) => responseSummary(openInvitationResponse(unhex(i['bytes_hex']), ownerInvitation(i['invitation']), { now: date(i['now']) })),

  /** openInvitationResponse, then verifyIndex of the responder's index at its certified address, then checkInvitationIndex. */
  check_answer_index: (i) => {
    const now = date(i['now']);
    const r = openInvitationResponse(unhex(i['bytes_hex']), ownerInvitation(i['invitation']), { now });
    const opts: VerifyIndexOptions = { expectedOwner: r.owner, now };
    if (r.location !== undefined) opts.location = r.location;
    const idx = verifyIndex(s(i['index'], 'index'), opts);
    checkInvitationIndex(r, idx, { now });
    return { owner: r.owner, device: r.device };
  },

  collect_answers: (i) => {
    const opts: { now: Date; acceptedOwner?: string } = { now: date(i['now']) };
    if (i['acceptedOwner'] !== undefined) opts.acceptedOwner = s(i['acceptedOwner'], 'acceptedOwner');
    const a = collectInvitationAnswers(ownerInvitation(i['invitation']), (i['responses_hex'] as Json[]).map(unhex), opts);
    return {
      answers: a.answers.map((x) => x.owner),
      rejected: a.rejected,
      multiple: a.multiple,
      accepted: a.accepted ? a.accepted.owner : null,
      late: a.late.map((x) => x.owner),
    };
  },

  /** invitationStatus of a vault record (its device certificate and signature are checked by invitationStatus itself). */
  invitation_status: (i) => {
    const rec = JSON.parse(s(i['record'], 'record')) as VaultInvitation;
    const owner = s(i['owner'], 'owner');
    let inv: OwnerInvitation;
    try {
      inv = invitationFromRecord(rec, owner).invitation;
    } catch (e) {
      if (e instanceof TLCryptoError) return { status: 'invalid' };
      throw e;
    }
    return { status: invitationStatus(inv, cert(i['sharing_cert']), date(i['now'])) };
  },

  open_vault: (i) => ({ records: canonicalize(openVault(unhex(i['bytes_hex']), s(i['owner'], 'owner'), unhex(i['vault_key_hex']))) }),

  merge_vaults: (i) => {
    const owner = s(i['owner'], 'owner');
    const key = unhex(i['vault_key_hex']);
    return { records: canonicalize(mergeVaults(openVault(unhex(i['a_hex']), owner, key), openVault(unhex(i['b_hex']), owner, key))) };
  },

  decrypt_transfer: (i) => ({ payload_hex: hex(decryptTransfer(unhex(i['blob_hex']), s(i['code'], 'code'), { now: date(i['now']) })) }),

  normalize_transfer_code: (i) => ({ code: normalizeTransferCode(s(i['code'], 'code')) }),

  decode_key_export: (i) => {
    const x = i['options'] === undefined ? {} : o(i['options'], 'options');
    const opts: { expectedOwner?: string; lastSeen?: SharingCert } = {};
    if (x['expectedOwner'] !== undefined) opts.expectedOwner = s(x['expectedOwner'], 'expectedOwner');
    if (x['lastSeen'] !== undefined) opts.lastSeen = cert(x['lastSeen']);
    return sharingKeyResult(decodeKeyExport(unhex(i['bytes_hex']), opts));
  },

  safety_code: (i) => {
    const a = s(i['a'], 'a');
    const b = s(i['b'], 'b');
    return { groups: safetyCode(a, b), qr: safetyQrPayload(a, b) };
  },
};

export const OP_NAMES = Object.keys(OPS);

/** Error details that a vector records (beyond the code). */
function errorResult(e: TLCryptoError): JsonObj {
  const out: JsonObj = { error: e.code };
  if (e instanceof RollbackError) out['fork'] = e.fork;
  if (e instanceof StorageMovedError) out['location'] = e.location;
  if (e instanceof IdentityMovedError) {
    out['from'] = e.from;
    out['to'] = e.to;
    out['conflict'] = e.conflict;
  }
  if (e instanceof UnsupportedVersionError && e.critical !== undefined) out['critical'] = e.critical;
  return out;
}

/** Runs one vector operation. Anything thrown that is not a TLCryptoError propagates (a test failure). */
export function run(op: string, input: JsonObj): JsonObj {
  const f = OPS[op];
  if (!f) throw new Error(`vector: unknown op ${op}`);
  try {
    return { ok: f(input) };
  } catch (e) {
    if (e instanceof TLCryptoError) return errorResult(e);
    throw e;
  }
}

/** Re-export for the generator. */
export { formatKey };
