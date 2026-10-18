import {
  checkSharingCertNotOlder,
  compactDeviceCert,
  compactSharingCert,
  expandDeviceCert,
  expandSharingCert,
  verifyDeviceCert,
  verifySharingCert,
  type DeviceCert,
  type SharingCert,
  type TrustOptions,
} from './certs';
import {
  arr,
  asObject,
  b2b256,
  canonicalize,
  checkFields,
  checkStructure,
  deepFreeze,
  fromB64Url,
  int,
  isoDate,
  nowMs,
  obj,
  ownerString,
  parseJsonObject,
  parseKey,
  parseTransported,
  str,
  utf8,
  type JsonObject,
} from './encoding';
import { DecryptionError, FormatError, IdentityMovedError, RollbackError, SignatureError, StorageMovedError } from './errors';
import { checkNotRetired, verifyIdentityMove, type DeviceKeys, type IdentityMove } from './identity';
import { signBody, verifyBody } from './sign';
import { packHash } from './pack';
import { isVerified, markVerified, verifiedInfo } from './verified';

/*
 * Signed index (one per owner, published next to the packs), canonical JSON:
 * {
 *   "version": 4,                                // MAJOR version; optional "minor" (>= 1) and "crit" (V3-03)
 *   "seq": 42,                                   // publication counter, orders indexes WITHIN a rotation
 *   "owner": "ed25519:<master>",
 *   "updated": "2026-10-13T15:10:00.000Z",       // informational; > 24 h in the future is refused
 *   "sharing_cert": {"key":"x25519:…","location":"https://…","rotation":3,"signature":"<master sig>"},
 *   "revoked_devices": ["ed25519:…"],            // covered by the sharing_cert master signature
 *   "reads": ["4"],                              // format versions the owner's app can read
 *   "device_cert": {"box":"x25519:…","device":"ed25519:…","signature":"<master sig>"},
 *   "packs": [{"file":"packs/b2b256-<b64url>.bin","hash":"b2b256:<b64url 32B>"}],
 *   "public": {"file":"public/lists.geojson","hash":"b2b256:…"}, // optional, plaintext public lists
 *   "move": {<identity-move>},                   // optional, after an identity change
 *   "signature": "<Ed25519 by the device key of device_cert>"
 * }
 * The index is signed by a DEVICE key, certified by the master key (device_cert). The sharing
 * cert (with the master-certified read address, V3-01) and the revoked-device list are
 * master-signed and embedded, so they inherit the index's rollback protection: a reader needs one
 * freshness anchor per owner (its last accepted index, or an IndexAnchor of it).
 *
 * Ordering (R-01): indexes are ordered by (sharing_cert.rotation, seq), lexicographically. Only the
 * master can raise the rotation, so a master-signed rotation that revokes a device supersedes every
 * index that device signed, whatever their seq. Within one rotation, seq may not jump by more than
 * MAX_SEQ_STEP over the last seen index; a new rotation may restart seq freely.
 *
 * Extension (V3-03): unknown top-level fields, and unknown fields in the compact certificates and
 * in pack / public entries, are accepted only when "minor" is higher than INDEX_MINOR; they are
 * covered by the device signature (canonical form of the whole document). Fields listed in "crit"
 * must be understood. A new MAJOR version is published under its own file name next to the old one
 * during the transition (spec "Format versions").
 */

export const INDEX_VERSION = 4;
/** Minor version of the index this library writes and fully understands. */
export const INDEX_MINOR = 0;
/** Largest accepted increase of `seq` over the last seen index within one rotation (2^20). */
export const MAX_SEQ_STEP = 2 ** 20;
/** Largest accepted index, in bytes (N-2). */
export const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_PACKS = 100_000;
const SKEW_MS = 24 * 60 * 60 * 1000;
const HASH_RE = /^b2b256:([A-Za-z0-9_-]{43})$/;
const PUBLIC_RE = /^public\/[A-Za-z0-9_-]{1,64}\.geojson$/;
const READS_RE = /^[1-9][0-9]{0,3}(\.[0-9]{1,4})?$/;

export interface IndexPackEntry {
  file: string;
  hash: string;
}

/** Content-addressed entry of the plaintext public-list file. */
export interface IndexPublicEntry {
  file: string;
  hash: string;
}

export interface SignedIndex {
  version: number;
  minor?: number;
  crit?: string[];
  seq: number;
  owner: string;
  updated: string;
  sharing_cert: { key: string; location: string; rotation: number; signature: string };
  revoked_devices: string[];
  reads: string[];
  device_cert: { device: string; box: string; signature: string };
  packs: IndexPackEntry[];
  public?: IndexPublicEntry;
  move?: IdentityMove;
  signature: string;
}

/**
 * Compact freshness anchor for an owner: what checkNoRollback needs from the last accepted index
 * (its version, seq, full sharing certificate and the hash of its canonical form), so the recovery
 * vault does not have to keep whole indexes. Build it with indexAnchor().
 */
export interface IndexAnchor {
  type: 'index-anchor';
  version: number;
  owner: string;
  seq: number;
  sharing_cert: SharingCert;
  /** "b2b256:<b64url>" of the canonical index. */
  hash: string;
}

/** A device that may publish: its keys and its master-signed certificate. */
export interface DeviceSigner {
  keys: DeviceKeys;
  cert: DeviceCert;
}

export interface IndexContent {
  seq: number;
  /** Current master-signed sharing certificate (carries the read address and the revoked devices). */
  sharingCert: SharingCert;
  /** Entries from packEntry(bytes). */
  packs: IndexPackEntry[];
  /** Readable format versions. Default: [String(INDEX_VERSION)]. */
  reads?: string[];
  /** Entry from publicEntry(bytes, name). */
  public?: IndexPublicEntry;
  move?: IdentityMove;
  /**
   * The index currently on the storage (or its anchor). When given, the new index must not be older
   * (checkNoRollback) and, within the same rotation, must use seq = previous.seq + 1 (V3-13).
   */
  previous?: SignedIndex | IndexAnchor;
  now?: Date;
}

export function signIndex(signer: DeviceSigner, content: IndexContent): SignedIndex {
  const cert = verifySharingCert(content.sharingCert).cert;
  if (cert.location === undefined) throw new FormatError('index: the sharing certificate has no read address (location)');
  const dc = verifyDeviceCert(signer.cert, { expectedOwner: cert.owner });
  if (dc.device !== signer.keys.id) throw new FormatError('index: device keys do not match the device certificate');
  if (cert.revoked_devices.includes(dc.device)) throw new SignatureError('index: the device is revoked by this certificate', 'REVOKED');
  const now = nowMs(content.now, 'index');
  const body: JsonObject = {
    version: INDEX_VERSION,
    seq: content.seq,
    owner: cert.owner,
    updated: new Date(now).toISOString(),
    sharing_cert: compactSharingCert(cert),
    revoked_devices: [...cert.revoked_devices],
    reads: [...(content.reads ?? [String(INDEX_VERSION)])],
    device_cert: compactDeviceCert(dc),
    packs: content.packs.map((p) => ({ file: p.file, hash: p.hash })),
  };
  if (content.public !== undefined) body['public'] = { file: content.public.file, hash: content.public.hash };
  if (content.move !== undefined) body['move'] = { ...content.move };
  const signed = signBody('index', body, signer.keys.sign.secretKey);
  // Round-trip through the verifier so we never publish something we would reject.
  const idx = verifyIndex(canonicalize(signed), { expectedOwner: cert.owner, location: cert.location, now: new Date(now) });
  if (content.previous !== undefined) {
    const prev = toAnchor(content.previous);
    checkNoRollback(idx, prev);
    if (idx.sharing_cert.rotation === prev.sharing_cert.rotation && idx.seq !== prev.seq + 1) {
      throw new RollbackError(`index: seq must be ${prev.seq + 1} within the current rotation (got ${idx.seq})`);
    }
  }
  return idx;
}

/** Serializes any signed document (index, cert, ...) as canonical JSON (the only accepted transport form). */
export function serialize(doc: object): string {
  return canonicalize(doc);
}

export interface VerifyIndexOptions extends TrustOptions {
  /** Last index accepted for this owner, or its anchor (persist it in the recovery vault): rollback protection. */
  lastSeen?: SignedIndex | IndexAnchor;
  /**
   * Address the index was read from. If the index's master-signed certificate names another read
   * address, the index is still fully verified, then StorageMovedError gives the new address (the
   * owner moved storage; read only there). Required by checkInvitationIndex.
   */
  location?: string;
  /** Reader's clock, for the 24 h future-skew limit on `updated`. Default: now. */
  now?: Date;
}

/** Full sharing certificate embedded in a verified index (with its read address). */
export function sharingCertOf(index: SignedIndex): SharingCert {
  return expandSharingCert(index.owner, [...index.revoked_devices], index.sharing_cert as unknown as JsonObject) as unknown as SharingCert;
}

/** Compact freshness anchor of a verified index (for the recovery vault). */
export function indexAnchor(index: SignedIndex): IndexAnchor {
  if (!isVerified(index)) throw new FormatError('index-anchor: the index must come from verifyIndex or signIndex');
  return deepFreeze({
    type: 'index-anchor',
    version: index.version,
    owner: index.owner,
    seq: index.seq,
    sharing_cert: sharingCertOf(index),
    hash: b2b256(utf8(canonicalize(index))),
  });
}

/** @internal Validates an anchor read back from the vault (master signature of its certificate included). */
export function verifyIndexAnchor(input: JsonObject, opts: TrustOptions = {}): IndexAnchor {
  const W = 'index-anchor';
  const doc = asObject(input, W);
  checkFields(doc, W, ['type', 'version', 'owner', 'seq', 'sharing_cert', 'hash'], [], false);
  if (doc['type'] !== W) throw new FormatError(`${W}: wrong type`);
  const version = int(doc, 'version', W);
  if (version < 1) throw new FormatError(`${W}: bad version`);
  const owner = str(doc, 'owner', W);
  parseKey('ed25519', owner, `${W}.owner`);
  const seq = int(doc, 'seq', W);
  const m = HASH_RE.exec(str(doc, 'hash', W));
  if (!m) throw new FormatError(`${W}: bad hash`);
  fromB64Url(m[1] as string, `${W}.hash`, 32);
  const cert = verifySharingCert(obj(doc, 'sharing_cert', W), { ...opts, expectedOwner: owner }).cert;
  if (opts.expectedOwner !== undefined && ownerString(opts.expectedOwner) !== owner) throw new SignatureError(`${W}: another owner`, 'OWNER_MISMATCH');
  return deepFreeze({ type: W, version, owner, seq, sharing_cert: cert, hash: str(doc, 'hash', W) });
}

function toAnchor(x: SignedIndex | IndexAnchor): IndexAnchor {
  if ((x as IndexAnchor).type === 'index-anchor') return x as IndexAnchor;
  const idx = x as SignedIndex;
  return { type: 'index-anchor', version: idx.version, owner: idx.owner, seq: idx.seq, sharing_cert: sharingCertOf(idx), hash: b2b256(utf8(canonicalize(idx))) };
}

function checkEntry(e: JsonObject, W: string, extensible: boolean): string {
  checkFields(e, W, ['file', 'hash'], [], extensible);
  const hash = str(e, 'hash', W);
  const m = HASH_RE.exec(hash);
  if (!m) throw new FormatError(`${W}: hash must be "b2b256:<base64url 32 bytes>"`);
  fromB64Url(m[1] as string, `${W}.hash`, 32);
  return m[1] as string;
}

/**
 * Verifies an index: canonical form, structure and versioning, master-signed sharing and device
 * certs, device signature, signer not revoked, `updated` not more than 24 h ahead, file names /
 * hashes, and (options) expected owner, retired owners, rollback against `lastSeen` and the
 * certified read address against `location`.
 * `input` is the transported text or bytes (V3-12); an object is accepted only if it was itself
 * returned by verifyIndex or signIndex.
 * If the index belongs to a new identity with a valid move from `expectedOwner`, throws
 * IdentityMovedError (nothing is accepted automatically).
 * Returns a frozen object. Only an index verified with `expectedOwner` (or made by signIndex) can
 * be used to open packs (V3-11).
 */
export function verifyIndex(input: string | Uint8Array | SignedIndex, opts: VerifyIndexOptions = {}): SignedIndex {
  const W = 'index';
  const retired = opts.retiredOwners ? [...opts.retiredOwners] : [];
  const parsed = isVerified(input) ? parseJsonObject(canonicalize(input), W) : parseTransported(input, W, MAX_INDEX_BYTES);
  // Work on a private deep copy (the result is frozen; never freeze the caller's objects).
  const doc = JSON.parse(canonicalize(parsed)) as JsonObject;
  const { extensible } = checkStructure(
    doc,
    W,
    INDEX_VERSION,
    ['version', 'seq', 'owner', 'updated', 'sharing_cert', 'revoked_devices', 'reads', 'device_cert', 'packs', 'signature'],
    ['public', 'move'],
    INDEX_MINOR,
  );
  parseKey('ed25519', doc['owner'], `${W}.owner`);
  const owner = str(doc, 'owner', W);
  int(doc, 'seq', W);
  const updated = isoDate(doc, 'updated', W);
  if (updated > nowMs(opts.now, W) + SKEW_MS) throw new FormatError(`${W}: "updated" is more than 24 h in the future (retry later)`);

  // The compact certificates follow their own versioning rules (verified as full certificates).
  const revoked = arr(doc, 'revoked_devices', W, 256);
  const fullCert = verifySharingCert(expandSharingCert(owner, revoked, obj(doc, 'sharing_cert', W)), { retiredOwners: retired }).cert;
  if (fullCert.location === undefined) throw new FormatError(`${W}.sharing_cert: missing field "location"`);
  const certified = fullCert.location;

  const dcObj = obj(doc, 'device_cert', W);
  const dc = verifyDeviceCert(expandDeviceCert(owner, dcObj));
  if (fullCert.revoked_devices.includes(dc.device)) throw new SignatureError(`${W}: signed by a revoked device`, 'REVOKED');

  const reads = arr(doc, 'reads', W, 32);
  if (reads.length === 0 || reads.some((r) => typeof r !== 'string' || !READS_RE.test(r)) || new Set(reads).size !== reads.length) {
    throw new FormatError(`${W}: reads must be a non-empty list of unique version strings`);
  }

  const packs = arr(doc, 'packs', W, MAX_PACKS);
  const seen = new Set<string>();
  for (const p of packs) {
    // V3-05: each entry must be a JSON object (a string is never parsed as JSON here).
    const e = asObject(p, `${W}.packs[]`);
    const h = checkEntry(e, `${W}.packs[]`, extensible);
    const file = str(e, 'file', `${W}.packs[]`);
    if (file !== `packs/b2b256-${h}.bin` && file !== `media/b2b256-${h}.bin`) {
      throw new FormatError(`${W}.packs[]: file must be "packs|media/b2b256-<hash>.bin" matching its hash`);
    }
    if (seen.has(h)) throw new FormatError(`${W}.packs[]: duplicate entry`);
    seen.add(h);
  }
  if ('public' in doc) {
    const pub = obj(doc, 'public', W);
    checkEntry(pub, `${W}.public`, extensible);
    if (!PUBLIC_RE.test(str(pub, 'file', `${W}.public`))) throw new FormatError(`${W}.public: file must be "public/<name>.geojson"`);
  }

  let move: IdentityMove | undefined;
  if ('move' in doc) {
    move = verifyIdentityMove(obj(doc, 'move', W));
    if (move.to !== owner) throw new FormatError(`${W}: move does not lead to this owner`);
  }

  verifyBody('index', doc, parseKey('ed25519', dc.device, `${W}.device_cert.device`));

  checkNotRetired(owner, retired, W);
  if (opts.expectedOwner !== undefined) {
    const expected = ownerString(opts.expectedOwner);
    if (expected !== owner) {
      if (move && move.from === expected) throw new IdentityMovedError(move.from, move.to);
      // R-11: a second, different successor of an identity this reader already left behind.
      if (move && retired.includes(move.from)) throw new IdentityMovedError(move.from, move.to, true);
      throw new SignatureError(`${W}: owner does not match expected owner`, 'OWNER_MISMATCH');
    }
  }
  const idx = deepFreeze(doc as unknown as SignedIndex);
  if (opts.lastSeen) checkNoRollback(idx, opts.lastSeen);
  // V3-01: read only from the master-certified address; a valid newer index left at an old
  // address is a redirect.
  if (opts.location !== undefined && opts.location !== certified) throw new StorageMovedError(certified);
  const info = { ownerBound: opts.expectedOwner !== undefined, lastSeenChecked: opts.lastSeen !== undefined };
  return markVerified(idx, opts.location !== undefined ? { ...info, readFrom: opts.location } : info);
}

/**
 * Rejects `next` if it is older than `lastSeen` (`next` verified; `lastSeen` a verified index or an
 * anchor). Indexes are ordered by (sharing_cert.rotation, seq) lexicographically; `updated` is ignored.
 * - The embedded sharing certificate is compared first: a lower rotation is a RollbackError, the
 *   same rotation with another certificate is a fork, and a higher rotation that un-revokes a
 *   device is refused. A higher rotation is otherwise accepted WHATEVER its seq: only the master
 *   raises the rotation, so a device cannot outrank its own revocation (R-01).
 * - Within one rotation: lower seq => RollbackError; same seq with different content =>
 *   RollbackError with fork = true (report it; accept the next higher seq); a seq more than
 *   MAX_SEQ_STEP above the last seen one => RollbackError (keep lastSeen; report it).
 * Re-delivery of the identical index is accepted.
 */
export function checkNoRollback(next: SignedIndex, lastSeen: SignedIndex | IndexAnchor): void {
  const last = toAnchor(lastSeen);
  if (next.owner !== last.owner) throw new SignatureError('index: lastSeen belongs to another owner', 'OWNER_MISMATCH');
  if (next.version < last.version) throw new RollbackError(`index: format version ${next.version} < last seen ${last.version}`);
  checkSharingCertNotOlder(sharingCertOf(next), last.sharing_cert);
  if (next.sharing_cert.rotation > last.sharing_cert.rotation) return;
  if (next.seq < last.seq) throw new RollbackError(`index: seq ${next.seq} < last seen ${last.seq}`);
  if (next.seq === last.seq) {
    if (b2b256(utf8(canonicalize(next))) !== last.hash) throw new RollbackError(`index: two different indexes with seq ${next.seq} (fork)`, true);
    return;
  }
  if (next.seq - last.seq > MAX_SEQ_STEP) throw new RollbackError('index: seq jumps too far ahead within one rotation');
}

/** @internal True if `index` was verified for a known owner (expectedOwner, or signIndex). */
export function isOwnerBound(index: unknown): boolean {
  return verifiedInfo(index)?.ownerBound === true;
}

/** Index entry for the plaintext public-list file: `public/<name>.geojson` and its content hash. */
export function publicEntry(bytes: Uint8Array, name: string): IndexPublicEntry {
  const file = `public/${name}.geojson`;
  if (!PUBLIC_RE.test(file)) throw new FormatError('public: name must be 1-64 characters [A-Za-z0-9_-]');
  return { file, hash: packHash(bytes) };
}

/** Checks the public-list file read from the storage against a VERIFIED index (NOT_INDEXED otherwise). */
export function verifyPublicFile(bytes: Uint8Array, index: SignedIndex): void {
  if (!isOwnerBound(index)) throw new DecryptionError('public: the index must come from verifyIndex (with expectedOwner) or signIndex', 'NOT_INDEXED');
  if (!index.public || !(bytes instanceof Uint8Array) || packHash(bytes) !== index.public.hash) {
    throw new DecryptionError('public: file does not match the signed index', 'NOT_INDEXED');
  }
}
