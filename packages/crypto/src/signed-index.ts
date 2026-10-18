import {
  checkSharingCertNotOlder,
  SHARING_CERT_VERSION,
  DEVICE_CERT_VERSION,
  verifyDeviceCert,
  verifySharingCert,
  type DeviceCert,
  type SharingCert,
  type TrustOptions,
} from './certs';
import {
  arr,
  canonicalize,
  checkKeys,
  checkVersion,
  deepFreeze,
  fromB64Url,
  isoDate,
  nowMs,
  obj,
  ownerString,
  parseJsonObject,
  parseKey,
  str,
  int,
  type JsonObject,
} from './encoding';
import { DecryptionError, FormatError, IdentityMovedError, RollbackError, SignatureError } from './errors';
import { checkNotRetired, verifyIdentityMove, type DeviceKeys, type IdentityMove } from './identity';
import { signBody, verifyBody } from './sign';
import { packHash } from './pack';
import { isVerified, markVerified } from './verified';

/*
 * Signed index (one per owner, published next to the packs), canonical JSON:
 * {
 *   "version": 3,
 *   "seq": 42,                                   // publication counter, orders indexes WITHIN a rotation
 *   "owner": "ed25519:<master>",
 *   "updated": "2026-10-13T15:10:00.000Z",       // informational; > 24 h in the future is refused
 *   "sharing_cert": {"key":"x25519:…","rotation":3,"signature":"<master sig>"}, // rotation orders first
 *   "revoked_devices": ["ed25519:…"],            // covered by the sharing_cert master signature
 *   "reads": ["3"],                              // format versions the owner's app can read
 *   "device_cert": {"box":"x25519:…","device":"ed25519:…","signature":"<master sig>"},
 *   "packs": [{"file":"packs/b2b256-<b64url>.bin","hash":"b2b256:<b64url 32B>"}],
 *   "public": {"file":"public/lists.geojson","hash":"b2b256:…"}, // optional, plaintext public lists
 *   "move": {<identity-move>},                   // optional, after an identity change
 *   "signature": "<Ed25519 by the device key of device_cert>"
 * }
 * The index is signed by a DEVICE key, certified by the master key (device_cert). The sharing
 * cert and the revoked-device list are master-signed and embedded, so they inherit the index's
 * rollback protection: a reader needs one freshness anchor per owner (its last accepted index).
 *
 * Ordering (R-01): indexes are ordered by (sharing_cert.rotation, seq), lexicographically. Only the
 * master can raise the rotation, so a master-signed rotation that revokes a device supersedes every
 * index that device signed, whatever their seq. Within one rotation, seq may not jump by more than
 * MAX_SEQ_STEP over the last seen index; a new rotation may restart seq freely.
 */

export const INDEX_VERSION = 3;
/** Largest accepted increase of `seq` over the last seen index within one rotation (2^20). */
export const MAX_SEQ_STEP = 2 ** 20;
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
  seq: number;
  owner: string;
  updated: string;
  sharing_cert: { key: string; rotation: number; signature: string };
  revoked_devices: string[];
  reads: string[];
  device_cert: { device: string; box: string; signature: string };
  packs: IndexPackEntry[];
  public?: IndexPublicEntry;
  move?: IdentityMove;
  signature: string;
}

/** A device that may publish: its keys and its master-signed certificate. */
export interface DeviceSigner {
  keys: DeviceKeys;
  cert: DeviceCert;
}

export interface IndexContent {
  seq: number;
  /** Current master-signed sharing certificate (carries the revoked devices). */
  sharingCert: SharingCert;
  /** Entries from packEntry(bytes). */
  packs: IndexPackEntry[];
  /** Readable format versions. Default: [String(INDEX_VERSION)]. */
  reads?: string[];
  /** Entry from publicEntry(bytes, name). */
  public?: IndexPublicEntry;
  move?: IdentityMove;
  now?: Date;
}

export function signIndex(signer: DeviceSigner, content: IndexContent): SignedIndex {
  const cert = verifySharingCert(content.sharingCert).cert;
  const dc = verifyDeviceCert(signer.cert, { expectedOwner: cert.owner });
  if (dc.device !== signer.keys.id) throw new FormatError('index: device keys do not match the device certificate');
  const now = nowMs(content.now, 'index');
  const body: JsonObject = {
    version: INDEX_VERSION,
    seq: content.seq,
    owner: cert.owner,
    updated: new Date(now).toISOString(),
    sharing_cert: { key: cert.key, rotation: cert.rotation, signature: cert.signature },
    revoked_devices: [...cert.revoked_devices],
    reads: [...(content.reads ?? [String(INDEX_VERSION)])],
    device_cert: { device: dc.device, box: dc.box, signature: dc.signature },
    packs: content.packs.map((p) => ({ file: p.file, hash: p.hash })),
  };
  if (content.public !== undefined) body['public'] = { file: content.public.file, hash: content.public.hash };
  if (content.move !== undefined) body['move'] = { ...content.move };
  const signed = signBody('index', body, signer.keys.sign.secretKey);
  // Round-trip through the verifier so we never publish something we would reject.
  return verifyIndex(signed, { now: new Date(now) });
}

/** Serializes any signed document (index, cert, ...) as canonical JSON (the only accepted transport form). */
export function serialize(doc: object): string {
  return canonicalize(doc);
}

export interface VerifyIndexOptions extends TrustOptions {
  /** Last index accepted for this owner (persist it, also in the recovery vault): rollback protection. */
  lastSeen?: SignedIndex;
  /** Reader's clock, for the 24 h future-skew limit on `updated`. Default: now. */
  now?: Date;
}

/** Full sharing certificate embedded in a verified index. */
export function sharingCertOf(index: SignedIndex): SharingCert {
  return {
    type: 'sharing-cert',
    version: SHARING_CERT_VERSION,
    owner: index.owner,
    key: index.sharing_cert.key,
    rotation: index.sharing_cert.rotation,
    revoked_devices: [...index.revoked_devices],
    signature: index.sharing_cert.signature,
  };
}

function deviceCertOf(owner: string, dc: JsonObject): DeviceCert {
  return { type: 'device-cert', version: DEVICE_CERT_VERSION, owner, device: dc['device'], box: dc['box'], signature: dc['signature'] } as DeviceCert;
}

/**
 * Verifies an index: canonical form, structure, master-signed sharing and device certs, device
 * signature, signer not revoked, `updated` not more than 24 h ahead, file names / hashes, and
 * (options) expected owner, retired owners and rollback against `lastSeen`.
 * If the index belongs to a new identity with a valid move from `expectedOwner`, throws
 * IdentityMovedError (nothing is accepted automatically).
 * Returns a frozen object; only such objects can be used to open packs.
 */
export function verifyIndex(input: string | SignedIndex | JsonObject, opts: VerifyIndexOptions = {}): SignedIndex {
  const W = 'index';
  const retired = opts.retiredOwners ? [...opts.retiredOwners] : [];
  const parsed = parseJsonObject(input as string | JsonObject, W);
  // Work on a private deep copy (the result is frozen; never freeze the caller's objects).
  const doc = JSON.parse(canonicalize(parsed)) as JsonObject;
  checkVersion(doc, W, INDEX_VERSION);
  checkKeys(doc, W, ['version', 'seq', 'owner', 'updated', 'sharing_cert', 'revoked_devices', 'reads', 'device_cert', 'packs', 'signature'], ['public', 'move']);
  parseKey('ed25519', doc['owner'], `${W}.owner`);
  const owner = str(doc, 'owner', W);
  int(doc, 'seq', W);
  const updated = isoDate(doc, 'updated', W);
  if (updated > nowMs(opts.now, W) + SKEW_MS) throw new FormatError(`${W}: "updated" is more than 24 h in the future (retry later)`);

  const sc = obj(doc, 'sharing_cert', W);
  checkKeys(sc, `${W}.sharing_cert`, ['key', 'rotation', 'signature']);
  const revoked = arr(doc, 'revoked_devices', W, 256) as string[];
  const fullCert = verifySharingCert(
    { type: 'sharing-cert', version: SHARING_CERT_VERSION, owner, key: sc['key'], rotation: sc['rotation'], revoked_devices: revoked, signature: sc['signature'] },
    { retiredOwners: retired },
  ).cert;

  const dcObj = obj(doc, 'device_cert', W);
  checkKeys(dcObj, `${W}.device_cert`, ['device', 'box', 'signature']);
  const dc = verifyDeviceCert(deviceCertOf(owner, dcObj));
  if (fullCert.revoked_devices.includes(dc.device)) throw new SignatureError(`${W}: signed by a revoked device`, 'REVOKED');

  const reads = arr(doc, 'reads', W, 32);
  if (reads.length === 0 || reads.some((r) => typeof r !== 'string' || !READS_RE.test(r)) || new Set(reads).size !== reads.length) {
    throw new FormatError(`${W}: reads must be a non-empty list of unique version strings`);
  }

  const packs = arr(doc, 'packs', W, MAX_PACKS);
  const seen = new Set<string>();
  for (const p of packs) {
    const e = parseJsonObject(p as JsonObject, `${W}.packs[]`);
    checkKeys(e, `${W}.packs[]`, ['file', 'hash']);
    const hash = str(e, 'hash', `${W}.packs[]`);
    const m = HASH_RE.exec(hash);
    if (!m) throw new FormatError(`${W}.packs[]: hash must be "b2b256:<base64url 32 bytes>"`);
    fromB64Url(m[1] as string, `${W}.packs[].hash`, 32);
    const file = str(e, 'file', `${W}.packs[]`);
    if (file !== `packs/b2b256-${m[1]}.bin` && file !== `media/b2b256-${m[1]}.bin`) {
      throw new FormatError(`${W}.packs[]: file must be "packs|media/b2b256-<hash>.bin" matching its hash`);
    }
    if (seen.has(hash)) throw new FormatError(`${W}.packs[]: duplicate entry`);
    seen.add(hash);
  }
  if ('public' in doc) {
    const pub = obj(doc, 'public', W);
    checkKeys(pub, `${W}.public`, ['file', 'hash']);
    if (!PUBLIC_RE.test(str(pub, 'file', `${W}.public`))) throw new FormatError(`${W}.public: file must be "public/<name>.geojson"`);
    const m = HASH_RE.exec(str(pub, 'hash', `${W}.public`));
    if (!m) throw new FormatError(`${W}.public: hash must be "b2b256:<base64url 32 bytes>"`);
    fromB64Url(m[1] as string, `${W}.public.hash`, 32);
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
  const idx = markVerified(deepFreeze(doc as unknown as SignedIndex));
  if (opts.lastSeen) checkNoRollback(idx, opts.lastSeen);
  return idx;
}

/**
 * Rejects `next` if it is older than `lastSeen` (both already verified). Indexes are ordered by
 * (sharing_cert.rotation, seq) lexicographically; `updated` is ignored.
 * - The embedded sharing certificate is compared first: a lower rotation is a RollbackError, the
 *   same rotation with another certificate is a fork, and a higher rotation that un-revokes a
 *   device is refused. A higher rotation is otherwise accepted WHATEVER its seq: only the master
 *   raises the rotation, so a device cannot outrank its own revocation (R-01).
 * - Within one rotation: lower seq => RollbackError; same seq with different content =>
 *   RollbackError with fork = true (report it; accept the next higher seq); a seq more than
 *   MAX_SEQ_STEP above the last seen one => RollbackError (keep lastSeen; report it).
 * Re-delivery of the identical index is accepted.
 */
export function checkNoRollback(next: SignedIndex, lastSeen: SignedIndex): void {
  if (next.owner !== lastSeen.owner) throw new SignatureError('index: lastSeen belongs to another owner', 'OWNER_MISMATCH');
  if (next.version < lastSeen.version) throw new RollbackError(`index: format version ${next.version} < last seen ${lastSeen.version}`);
  checkSharingCertNotOlder(sharingCertOf(next), sharingCertOf(lastSeen));
  if (next.sharing_cert.rotation > lastSeen.sharing_cert.rotation) return;
  if (next.seq < lastSeen.seq) throw new RollbackError(`index: seq ${next.seq} < last seen ${lastSeen.seq}`);
  if (next.seq === lastSeen.seq) {
    if (canonicalize(next) !== canonicalize(lastSeen)) throw new RollbackError(`index: two different indexes with seq ${next.seq} (fork)`, true);
    return;
  }
  if (next.seq - lastSeen.seq > MAX_SEQ_STEP) throw new RollbackError('index: seq jumps too far ahead within one rotation');
}

/** Index entry for the plaintext public-list file: `public/<name>.geojson` and its content hash. */
export function publicEntry(bytes: Uint8Array, name: string): IndexPublicEntry {
  const file = `public/${name}.geojson`;
  if (!PUBLIC_RE.test(file)) throw new FormatError('public: name must be 1-64 characters [A-Za-z0-9_-]');
  return { file, hash: packHash(bytes) };
}

/** Checks the public-list file read from the storage against a VERIFIED index (NOT_INDEXED otherwise). */
export function verifyPublicFile(bytes: Uint8Array, index: SignedIndex): void {
  if (!isVerified(index)) throw new DecryptionError('public: the index must come from verifyIndex or signIndex', 'NOT_INDEXED');
  if (!index.public || !(bytes instanceof Uint8Array) || packHash(bytes) !== index.public.hash) {
    throw new DecryptionError('public: file does not match the signed index', 'NOT_INDEXED');
  }
}
