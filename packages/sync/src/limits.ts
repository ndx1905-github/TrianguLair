// SPDX-License-Identifier: MPL-2.0
/**
 * Size limits (T-204 review R-06). Every download is bounded BEFORE its hash
 * is checked (a friend's storage host is untrusted and could stream an
 * endless body at any listed path), and every decompression is bounded per
 * payload kind. Friends' reads are also bounded per friend and per sync
 * pass, and their pack work shares one concurrency limit.
 *
 * Orders of magnitude (README "Measurements"): a 200-place pack is about
 * 20 KB on the storage and 70 KB of JSON; my 10,000-place index is 7 KB and
 * my whole Yjs document 3.8 MB raw.
 */
export interface SyncLimits {
  /** `index.json` (mine or a friend's) download. Crypto refuses more than 16 MiB anyway. Default 4 MiB. */
  indexBytes: number;
  /** One places pack download (`packs/`). Default 8 MiB. */
  packBytes: number;
  /** One file of my own under `media/` (own document, manifest). My own data: default 96 MiB. */
  ownFileBytes: number;
  /** Decompressed places payload (one pack). Default 4 MiB. */
  placesPayloadBytes: number;
  /** Decompressed manifest payload. Default 1 MiB. */
  manifestPayloadBytes: number;
  /** Decompressed own-document payload (one full snapshot or delta). Default 64 MiB. */
  ownDocPayloadBytes: number;
  /** Bytes downloaded plus bytes decompressed for one friend in one read. Default 32 MiB. */
  friendReadBytes: number;
  /** Same, for all the friends read in one sync pass (the rest waits for the next pass). Default 128 MiB. */
  passBytes: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS: Readonly<SyncLimits> = Object.freeze({
  indexBytes: 4 * MiB,
  packBytes: 8 * MiB,
  ownFileBytes: 96 * MiB,
  placesPayloadBytes: 4 * MiB,
  manifestPayloadBytes: 1 * MiB,
  ownDocPayloadBytes: 64 * MiB,
  friendReadBytes: 32 * MiB,
  passBytes: 128 * MiB,
});

export function resolveLimits(l: Partial<SyncLimits> | undefined): SyncLimits {
  const out = { ...DEFAULT_LIMITS, ...(l ?? {}) };
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new RangeError(`limits.${k} must be a positive integer`);
  }
  return out;
}
