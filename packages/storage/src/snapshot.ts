import { NotFound } from './errors.ts';
import { INDEX_PATH, PUBLIC_LISTS_PATH, packPath } from './layout.ts';
import type { ETag, StorageAdapter } from './types.ts';

export interface PublishInput {
  /** Serialized signed index (bytes produced by @triangulair/crypto). */
  index: Uint8Array;
  /** New or changed packs to upload, keyed by pack id. */
  packs: Record<string, Uint8Array> | Iterable<[string, Uint8Array]>;
  /**
   * ETag of the index this publish is based on (from the last publish or
   * fetch). `null` means "first publish": the index must not exist yet.
   */
  previousIndexEtag: ETag | null;
  /** Optional public GeoJSON lists, written unconditionally after the index. */
  publicLists?: Uint8Array;
  /** Max parallel pack uploads (default 4). */
  concurrency?: number;
}

export interface PublishResult {
  indexEtag: ETag;
  packEtags: Record<string, ETag>;
}

/**
 * Publish a snapshot: upload packs first, then swap the index with a
 * conditional write (If-Match previous ETag, or If-None-Match: * on first
 * publish). If another device published meanwhile, the index write throws
 * `PreconditionFailed`: the caller must fetch, merge, and retry. Packs already
 * uploaded are harmless (unreferenced until an index points at them); pack ids
 * should be unique/content-derived so they never overwrite a pack referenced
 * by the live index.
 *
 * Readers therefore never see an index referencing a pack that is not there yet.
 * Garbage collection of unreferenced packs is the caller's job (after the index commit).
 */
export async function publishSnapshot(adapter: StorageAdapter, input: PublishInput): Promise<PublishResult> {
  const entries = Symbol.iterator in input.packs
    ? Array.from(input.packs as Iterable<[string, Uint8Array]>)
    : Object.entries(input.packs);
  const packEtags: Record<string, ETag> = {};
  const queue = entries.map(([id, data]) => ({ id, path: packPath(id), data }));
  const workers = Array.from({ length: Math.max(1, Math.min(input.concurrency ?? 4, queue.length)) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      packEtags[job.id] = (await adapter.put(job.path, job.data)).etag;
    }
  });
  await Promise.all(workers);

  const { etag: indexEtag } = await adapter.put(
    INDEX_PATH,
    input.index,
    input.previousIndexEtag === null
      ? { ifNoneMatch: '*', contentType: 'application/json' }
      : { ifMatch: input.previousIndexEtag, contentType: 'application/json' },
  );

  if (input.publicLists) {
    await adapter.put(PUBLIC_LISTS_PATH, input.publicLists, { contentType: 'application/geo+json' });
  }
  return { indexEtag, packEtags };
}

export type FetchSnapshotResult =
  | { changed: false; etag: ETag }
  | { changed: true; etag: ETag; index: Uint8Array };

/**
 * Fetch the index if its ETag differs from `lastEtag`. One HEAD when
 * unchanged, HEAD + GET otherwise. Throws `NotFound` if there is no index.
 * Packs are fetched separately with `fetchPack` once the index is verified
 * and parsed by @triangulair/crypto.
 */
export async function fetchSnapshot(adapter: StorageAdapter, lastEtag: ETag | null): Promise<FetchSnapshotResult> {
  if (lastEtag !== null) {
    const h = await adapter.head(INDEX_PATH);
    if (!h) throw new NotFound(INDEX_PATH);
    if (h.etag === lastEtag) return { changed: false, etag: h.etag };
  }
  const g = await adapter.get(INDEX_PATH);
  if (!g) throw new NotFound(INDEX_PATH);
  if (lastEtag !== null && g.etag === lastEtag) return { changed: false, etag: g.etag };
  return { changed: true, etag: g.etag, index: g.data };
}

export async function fetchPack(adapter: StorageAdapter, id: string): Promise<Uint8Array> {
  const path = packPath(id);
  const g = await adapter.get(path);
  if (!g) throw new NotFound(path);
  return g.data;
}
