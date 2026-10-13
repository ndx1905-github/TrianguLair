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
import { FormatError, IdentityMovedError, RollbackError, SignatureError } from './errors';
import { checkNotRetired, verifyIdentityMove, type DeviceKeys, type IdentityMove } from './identity';
import { signBody, verifyBody } from './sign';
import { markVerified } from './verified';

/*
 * Signed index (one per owner, published next to the packs), canonical JSON:
 * {
 *   "version": 2,
 *   "seq": 42,                                   // publication counter: the ONLY ordering criterion
 *   "owner": "ed25519:<master>",
 *   "updated": "2026-10-13T15:10:00.000Z",       // informational; > 24 h in the future is refused
 *   "sharing_cert": {"key":"x25519:…","rotation":3,"signature":"<master sig>"},
 *   "revoked_devices": ["ed25519:…"],            // covered by the sharing_cert master signature
 *   "reads": ["2"],                              // format versions the owner's app can read
 *   "device_cert": {"box":"x25519:…","device":"ed25519:…","signature":"<master sig>"},
 *   "packs": [{"file":"packs/b2b256-<b64url>.bin","hash":"b2b256:<b64url 32B>"}],
 *   "public": "public/lists.geojson",           // optional
 *   "move": {<identity-move>},                   // optional, after an identity change
 *   "signature": "<Ed25519 by the device key of device_cert>"
 * }
 * The index is signed by a DEVICE key, certified by the master key (device_cert). The sharing
 * cert and the revoked-device list are master-signed and embedded, so they inherit `seq`
 * rollback protection: a reader needs one freshness anchor per owner (its last accepted index).
 */

export const INDEX_VERSION = 2;
const MAX_PACKS = 100_000;
const SKEW_MS = 24 * 60 * 60 * 1000;
const HASH_RE = /^b2b256:([A-Za-z0-9_-]{43})$/;
const PUBLIC_RE = /^public\/[A-Za-z0-9_-]{1,64}\.geojson$/;
const READS_RE = /^[1-9][0-9]{0,3}(\.[0-9]{1,4})?$/;

export interface IndexPackEntry {
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
  public?: string;
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
  /** Readable format versions. Default: ["2"]. */
  reads?: string[];
  public?: string;
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
  if (content.public !== undefined) body['public'] = content.public;
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
  if ('public' in doc && !PUBLIC_RE.test(str(doc, 'public', W))) throw new FormatError(`${W}: public must be "public/<name>.geojson"`);

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
      throw new SignatureError(`${W}: owner does not match expected owner`, 'OWNER_MISMATCH');
    }
  }
  const idx = markVerified(deepFreeze(doc as unknown as SignedIndex));
  if (opts.lastSeen) checkNoRollback(idx, opts.lastSeen);
  return idx;
}

/**
 * Rejects `next` if it is older than `lastSeen` (both already verified). `seq` is the only
 * ordering criterion (`updated` is ignored): lower seq => RollbackError; same seq with different
 * content => RollbackError with fork = true (report it; accept the next higher seq). The embedded
 * sharing certificate must not go back either (lower rotation, or un-revoking a device).
 * Re-delivery of the identical index is accepted.
 */
export function checkNoRollback(next: SignedIndex, lastSeen: SignedIndex): void {
  if (next.owner !== lastSeen.owner) throw new SignatureError('index: lastSeen belongs to another owner', 'OWNER_MISMATCH');
  if (next.version < lastSeen.version) throw new RollbackError(`index: format version ${next.version} < last seen ${lastSeen.version}`);
  if (next.seq < lastSeen.seq) throw new RollbackError(`index: seq ${next.seq} < last seen ${lastSeen.seq}`);
  if (next.seq === lastSeen.seq) {
    if (canonicalize(next) !== canonicalize(lastSeen)) throw new RollbackError(`index: two different indexes with seq ${next.seq} (fork)`, true);
    return;
  }
  checkSharingCertNotOlder(sharingCertOf(next), sharingCertOf(lastSeen));
}
