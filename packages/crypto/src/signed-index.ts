import { canonicalize, checkKeys, checkVersion, int, isoDate, parseJsonObject, parseKey, str, type JsonObject } from './encoding';
import { FormatError, RollbackError, SignatureError } from './errors';
import { ownerString, type Identity } from './identity';
import { signBody, verifyBody } from './sign';

/*
 * Signed index (one per owner, published next to the packs):
 * {
 *   "version": 1,                         // format version
 *   "owner": "ed25519:<b64url>",          // master public key
 *   "seq": 42,                            // monotonic counter, +1 on every publication
 *   "updated": "2026-10-13T12:00:00.000Z",
 *   "packs": [{"file":"packs/7c1e.bin","etag":"<packEtag(bytes)>"}],
 *   "public": "public/listes.geojson",    // optional
 *   "signature": "<b64url Ed25519>"
 * }
 * Signature: see sign.ts (domain "index", canonical JSON without "signature").
 */

export const INDEX_VERSION = 1;

export interface IndexPackEntry {
  file: string;
  etag: string;
}

export interface SignedIndex {
  version: number;
  owner: string;
  seq: number;
  updated: string;
  packs: IndexPackEntry[];
  public?: string;
  signature: string;
}

export interface IndexContent {
  seq: number;
  packs: IndexPackEntry[];
  public?: string;
  now?: Date;
}

export function signIndex(identity: Identity, content: IndexContent): SignedIndex {
  const body: JsonObject = {
    version: INDEX_VERSION,
    owner: identity.owner,
    seq: content.seq,
    updated: (content.now ?? new Date()).toISOString(),
    packs: content.packs.map((p) => ({ file: p.file, etag: p.etag })),
  };
  if (content.public !== undefined) body['public'] = content.public;
  const signed = signBody('index', body, identity.master.secretKey);
  // Round-trip through the verifier so we never publish something we would reject.
  return verifyIndex(signed);
}

/** Serializes any signed document (index, cert, ...) as canonical JSON. */
export function serialize(doc: object): string {
  return canonicalize(doc);
}

export interface VerifyIndexOptions {
  /** Master public key (or "ed25519:..." string) the index must belong to. */
  expectedOwner?: Uint8Array | string;
  /** Last index accepted for this owner; used for rollback protection. */
  lastSeen?: SignedIndex;
}

export function verifyIndex(input: string | SignedIndex | JsonObject, opts: VerifyIndexOptions = {}): SignedIndex {
  const W = 'index';
  const doc = parseJsonObject(input as string | JsonObject, W);
  checkVersion(doc, W, INDEX_VERSION);
  checkKeys(doc, W, ['version', 'owner', 'seq', 'updated', 'packs', 'signature'], ['public']);
  const ownerPk = parseKey('ed25519', doc['owner'], `${W}.owner`);
  int(doc, 'seq', W);
  isoDate(doc, 'updated', W);
  if ('public' in doc) str(doc, 'public', W);
  const packs = doc['packs'];
  if (!Array.isArray(packs)) throw new FormatError(`${W}: packs must be an array`);
  for (const p of packs) {
    const e = parseJsonObject(p as JsonObject, `${W}.packs[]`);
    checkKeys(e, `${W}.packs[]`, ['file', 'etag']);
    str(e, 'file', `${W}.packs[]`);
    str(e, 'etag', `${W}.packs[]`);
  }
  verifyBody('index', doc, ownerPk);
  const idx = doc as unknown as SignedIndex;
  if (opts.expectedOwner !== undefined && ownerString(opts.expectedOwner) !== idx.owner) {
    throw new SignatureError(`${W}: owner does not match expected owner`, 'OWNER_MISMATCH');
  }
  if (opts.lastSeen) checkNoRollback(idx, opts.lastSeen);
  return idx;
}

/**
 * Rejects `next` if it is older than `lastSeen` (both must already be verified):
 * lower format version, lower seq, older `updated`, or same seq with different content
 * (equivocation / fork). Re-delivery of the identical index is accepted.
 */
export function checkNoRollback(next: SignedIndex, lastSeen: SignedIndex): void {
  if (next.owner !== lastSeen.owner) throw new SignatureError('index: lastSeen belongs to another owner', 'OWNER_MISMATCH');
  if (next.version < lastSeen.version) throw new RollbackError(`index: format version ${next.version} < last seen ${lastSeen.version}`);
  if (next.seq < lastSeen.seq) throw new RollbackError(`index: seq ${next.seq} < last seen ${lastSeen.seq}`);
  if (Date.parse(next.updated) < Date.parse(lastSeen.updated)) {
    throw new RollbackError(`index: updated ${next.updated} is older than last seen ${lastSeen.updated}`);
  }
  if (next.seq === lastSeen.seq && canonicalize(next) !== canonicalize(lastSeen)) {
    throw new RollbackError(`index: two different indexes with seq ${next.seq} (fork)`);
  }
}
