import { NotFound } from './errors.ts';
import { INDEX_PATH, PUBLIC_LISTS_PATH, indexPath, packPath } from './layout.ts';
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
  /**
   * Indexes of newer major versions written next to `index.json` during a
   * major format transition (`index.v<N>.json`), each with its own
   * conditional write. They are written BEFORE `index.json`, so a failed
   * transition write leaves the old index untouched.
   */
  newerIndexes?: { major: number; index: Uint8Array; previousEtag: ETag | null }[];
}

export interface PublishResult {
  indexEtag: ETag;
  packEtags: Record<string, ETag>;
  /** ETags of the `newerIndexes`, keyed by major. */
  newerIndexEtags: Record<number, ETag>;
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

  const newerIndexEtags: Record<number, ETag> = {};
  for (const n of input.newerIndexes ?? []) {
    const path = indexPath(n.major);
    if (path === INDEX_PATH) throw new Error('newerIndexes: use `index` for index.json');
    newerIndexEtags[n.major] = (
      await adapter.put(
        path,
        n.index,
        n.previousEtag === null
          ? { ifNoneMatch: '*', contentType: 'application/json' }
          : { ifMatch: n.previousEtag, contentType: 'application/json' },
      )
    ).etag;
  }

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
  return { indexEtag, packEtags, newerIndexEtags };
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
export async function fetchSnapshot(
  adapter: StorageAdapter,
  lastEtag: ETag | null,
  opts: { path?: string; maxBytes?: number } = {},
): Promise<FetchSnapshotResult> {
  const path = opts.path ?? INDEX_PATH;
  const getOpts = opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {};
  if (lastEtag !== null) {
    const h = await adapter.head(path);
    if (!h) throw new NotFound(path);
    if (h.etag === lastEtag) return { changed: false, etag: h.etag };
  }
  const g = await adapter.get(path, getOpts);
  if (!g) throw new NotFound(path);
  if (lastEtag !== null && g.etag === lastEtag) return { changed: false, etag: g.etag };
  return { changed: true, etag: g.etag, index: g.data };
}

export type FetchIndexResult = FetchSnapshotResult & {
  /** The major that was found (the one asked for at `index.v<N>.json`), or `null` for `index.json`. */
  major: number | null;
  path: string;
};

/**
 * Reads the index of the highest major the reader understands (spec "Format
 * versions": an app reads the highest major it understands). `majors` are
 * tried from the highest down at `index.v<N>.json`; `index.json` is the
 * fallback (it holds the oldest major still written, which may be any of
 * them, or a newer one: the caller's parser decides). `lastEtags` holds the
 * ETag last seen per path, to skip an unchanged index with one HEAD.
 */
export async function fetchHighestIndex(
  adapter: StorageAdapter,
  majors: readonly number[],
  lastEtags: Readonly<Record<string, ETag>> = {},
  opts: { maxBytes?: number } = {},
): Promise<FetchIndexResult> {
  const getOpts = opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {};
  for (const major of [...new Set(majors)].sort((a, b) => b - a)) {
    const path = indexPath(major);
    if (path === INDEX_PATH) continue;
    const last = lastEtags[path] ?? null;
    if (last !== null) {
      const h = await adapter.head(path);
      if (!h) continue;
      if (h.etag === last) return { changed: false, etag: h.etag, major, path };
    }
    const g = await adapter.get(path, getOpts);
    if (!g) continue;
    if (last !== null && g.etag === last) return { changed: false, etag: g.etag, major, path };
    return { changed: true, etag: g.etag, index: g.data, major, path };
  }
  const r = await fetchSnapshot(adapter, lastEtags[INDEX_PATH] ?? null, getOpts);
  return { ...r, major: null, path: INDEX_PATH };
}

export async function fetchPack(adapter: StorageAdapter, id: string, opts: { maxBytes?: number } = {}): Promise<Uint8Array> {
  const path = packPath(id);
  const g = await adapter.get(path, opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {});
  if (!g) throw new NotFound(path);
  return g.data;
}
