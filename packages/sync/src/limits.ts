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
  /** Same, for all the friends and followed lists read in one sync pass (the rest waits for the next pass). Default 128 MiB. */
  passBytes: number;
  /**
   * Lists followed by link (review L-07: following is much cheaper to trigger than befriending, so
   * their bounds are smaller). One pack download while looking for a list's pack (a link-only list
   * pack holds at most 500 places, about 100 KB; a bigger file is skipped). Default 1 MiB.
   */
  listPackBytes: number;
  /** Bytes downloaded plus decompressed for one followed list in one read (its index aside). Default 8 MiB. */
  listReadBytes: number;
  /** Same, for the preview of a list before "Follow this list". Default 4 MiB. */
  listPreviewBytes: number;
  /**
   * One photo (T-111b): the largest image accepted when adding it, and the largest full-size photo
   * file downloaded (a recompressed 1,600 px WebP is 150–600 KB). Default 8 MiB.
   */
  photoBytes: number;
  /** One thumbnail file download (about 20 KB). Default 512 KiB. */
  thumbBytes: number;
  /** Friends' thumbnails fetched with their places in one pass (new photos only; the rest on demand). Default 8 MiB. */
  thumbPrefetchBytes: number;
  /** My photos downloaded by one of my devices in one pass (own devices sync photos; the rest next pass). Default 64 MiB. */
  ownPhotoPassBytes: number;
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
  listPackBytes: 1 * MiB,
  listReadBytes: 8 * MiB,
  listPreviewBytes: 4 * MiB,
  photoBytes: 8 * MiB,
  thumbBytes: 512 * 1024,
  thumbPrefetchBytes: 8 * MiB,
  ownPhotoPassBytes: 64 * MiB,
});

export function resolveLimits(l: Partial<SyncLimits> | undefined): SyncLimits {
  const out = { ...DEFAULT_LIMITS, ...(l ?? {}) };
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new RangeError(`limits.${k} must be a positive integer`);
  }
  return out;
}
