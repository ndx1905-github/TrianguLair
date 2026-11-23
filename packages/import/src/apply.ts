// SPDX-License-Identifier: MPL-2.0
/**
 * Writes an import plan to the data store, in batches: each batch is one
 * `DataStore.change` (one Yjs transaction + one SQLite transaction), 200
 * saves by default, with a yield to the UI between batches for the progress
 * bar and the cancel button. A cancelled import keeps the batches already
 * written (each one is atomic) and its report can undo them.
 *
 * Merging (spec "No duplicates"): a place already in my saves gets the new
 * tags added, its comment completed (never replaced), and a status or price
 * only if it had none. Places folded together in the file are merged the
 * same way before writing.
 */
import {
  newLocalPlaceId,
  normalizeText,
  type DataStore,
  type DocTx,
  type ListFilter,
  type PlaceSnapshotInput,
  type SaveStatus,
} from '@triangulair/data';

import type { ImportedPhoto, ImportedPlace, RemotePhoto, SourceFormat } from './model.ts';
import { targetPlaceId, type ImportPlan, type PlanItem } from './plan.ts';

export interface ApplyOptions {
  /** Saves per change (default 200). */
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (written: number, total: number) => void;
  /** Between batches; default a macrotask (lets React render the progress). */
  yieldFn?: () => Promise<void>;
  newId?: () => string;
  now?: () => number;
  /**
   * Stores one of my exported photos on a save (the app: `Photos.add`, which keeps the images on the
   * device and records the photo in my document). Returns its new id. Without it, photos are skipped.
   * Called after the batch that wrote the save; a throw skips that photo only.
   */
  addPhoto?: (placeId: string, photo: ImportedPhoto & { images: NonNullable<ImportedPhoto['images']> }) => string;
  /**
   * Downloads one photo the source keeps on its server (`ImportedPlace.remotePhotos`), when the
   * preview asked for it (`plan.downloadRemotePhotos`). Resolves to the image file; rejects when
   * it cannot. Throw `PhotoDownloadBlockedError` when the platform refuses the request itself (a
   * browser's cross-origin rule): the remaining photos are then not tried.
   */
  fetchPhoto?: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  /**
   * Stores a downloaded image as one of my photos on a save (the app: decode, shrink, thumbnail,
   * then `Photos.add` with the given `id`). Returns the photo id. A rejection counts the photo as
   * not downloaded.
   */
  addDownloadedPhoto?: (placeId: string, image: Uint8Array, info: { id: string; mime?: string }) => Promise<string>;
  /** Per download attempt (default 30 s). */
  photoTimeoutMs?: number;
  /** Downloads at once (default 3). */
  photoConcurrency?: number;
  /** Progress of the photo downloads, after the places are written. */
  onPhotoProgress?: (done: number, total: number) => void;
}

/** Thrown by a `fetchPhoto` when the platform refuses the download itself (the web's cross-origin rule). */
export class PhotoDownloadBlockedError extends Error {
  constructor(message = 'the download was blocked by the platform') {
    super(message);
    this.name = 'PhotoDownloadBlockedError';
  }
}

/**
 * The id of a downloaded photo on a save: the same source photo on the same place always gets the
 * same id, so a re-import (or a second device importing the same file) does not add it twice. A
 * hash: neither the source's file name nor its URL is written.
 */
export function remotePhotoId(placeId: string, key: string): string {
  // Two 32-bit FNV-1a passes with different seeds, as 13 base-36 digits.
  const text = `${placeId}\n${key}`;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 ^ 0x2f) >>> 0;
  }
  return `rp${a.toString(36).padStart(7, '0')}${b.toString(36).padStart(7, '0')}`;
}

export interface MergedSave {
  placeId: string;
  addedTagIds: string[];
  /** Photos the import added to this existing save (undo removes them). */
  addedMediaIds?: string[];
  previousComment?: string;
  previousStatus?: SaveStatus | null;
  restoredFromTrash?: boolean;
}

export interface ImportReport {
  format: SourceFormat;
  at: number;
  cancelled: boolean;
  /** New saves (place ids). */
  createdPlaceIds: string[];
  merged: MergedSave[];
  createdTagIds: string[];
  createdListIds: string[];
  counts: {
    /** Saves written (new + merged). */
    imported: number;
    created: number;
    merged: number;
    linkedToOsm: number;
    manual: number;
    /** Doubtful matches the user may want to check. */
    toCheck: number;
    skipped: number;
    duplicates: number;
    /** Photos added (images included in the file). */
    photos?: number;
    /** Photos not added: images not in the file, refused, or no photo support. */
    photosSkipped?: number;
    /** Photos downloaded from the source's server (asked in the preview) and added. */
    remotePhotos?: number;
    /** Photos asked for that could not be downloaded or stored (network, timeout, not an image, blocked). */
    remotePhotosFailed?: number;
    /** Already in my saves and left as they were (`plan.mergeExisting` off). */
    alreadySaved?: number;
    /** Already in my saves, merge asked, but the file added nothing new. */
    unchanged?: number;
    /** New places written with the "maybe closed" flag. */
    maybeClosed?: number;
  };
  /** The platform refused the photo downloads (web: cross-origin rule); the places are imported. */
  photoDownloadBlocked?: boolean;
}

const defaultYield = () => new Promise<void>((r) => setTimeout(r, 0));

const STATUS_RANK: Record<SaveStatus, number> = { to_try: 1, tried: 2, favorite: 3 };

/** One place from an item and the items folded into it. */
function mergeImported(primary: ImportedPlace, others: readonly ImportedPlace[]): ImportedPlace {
  if (others.length === 0) return primary;
  const all = [primary, ...others];
  const comments: string[] = [];
  for (const p of all) {
    const c = p.comment?.trim();
    if (c && !comments.some((x) => x.includes(c))) comments.push(c);
  }
  const statuses = all.map((p) => p.status).filter((s): s is SaveStatus => !!s);
  const created = all.map((p) => p.createdAt).filter((t): t is number => t !== undefined);
  const status = statuses.sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0];
  return {
    ...primary,
    tags: [...new Set(all.flatMap((p) => p.tags))],
    ...(comments.length > 0 && { comment: comments.join('\n\n') }),
    ...(status && { status }),
    ...(created.length > 0 && { createdAt: Math.min(...created) }),
    ...(all.some((p) => p.media?.length) && { media: all.flatMap((p) => p.media ?? []).filter((m, i, a) => a.findIndex((x) => x.file === m.file) === i) }),
    ...(all.some((p) => p.remotePhotos?.length) && {
      remotePhotos: all.flatMap((p) => p.remotePhotos ?? []).filter((m, i, a) => a.findIndex((x) => x.key === m.key) === i),
    }),
    // A place kept private in one of the folded entries stays private.
    ...(all.some((p) => p.sharing === 'private') && { sharing: 'private' as const }),
    ...(all.some((p) => p.commentVisibility === 'private') && { commentVisibility: 'private' as const }),
  };
}

function snapshotFor(item: PlanItem, place: ImportedPlace, newId?: () => string): PlaceSnapshotInput {
  const r = item.resolution;
  if (r.kind === 'osm') {
    const c = r.candidate;
    return { osm: c.ref, name: c.name || place.name, category: c.category, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } };
  }
  const geometry = place.shape?.geometry ?? { type: 'Point' as const, coordinates: [item.position!.lon, item.position!.lat] };
  const kind = place.kind ?? (place.shape ? 'zone' : 'place');
  const base = {
    name: place.name,
    category: place.category ?? null,
    kind,
    ...(place.shape?.edge && { edge: place.shape.edge }),
    geometry,
  };
  if (r.kind === 'source') {
    if (place.ids.osm) return { ...base, osm: place.ids.osm };
    if (place.ids.placeId?.startsWith('local:')) return { ...base, id: place.ids.placeId };
  }
  return { ...base, id: newLocalPlaceId(newId) };
}

function mergeComment(existing: string, incoming: string | undefined): string | null {
  const add = incoming?.trim();
  if (!add) return null;
  const cur = existing.trim();
  if (!cur) return add;
  if (normalizeText(cur).includes(normalizeText(add))) return null;
  return `${cur}\n\n${add}`;
}

/** Writes the tags the plan creates (parents first) and returns source key → my tag id. */
function writeTags(tx: DocTx, plan: ImportPlan, report: ImportReport): Map<string, string> {
  const ids = new Map<string, string>();
  for (const t of plan.tags) if (t.action.kind === 'map') ids.set(t.source.key, t.action.tagId);
  const pending = plan.tags.filter((t) => t.action.kind === 'create');
  const byKey = new Map(plan.tags.map((t) => [t.source.key, t]));
  const created = new Set<string>();
  const create = (key: string, depth = 0): string | null => {
    if (ids.has(key)) return ids.get(key)!;
    const t = byKey.get(key);
    if (!t || t.action.kind !== 'create' || depth > 32 || created.has(key)) return null;
    created.add(key);
    const parentId = t.source.parentKey ? create(t.source.parentKey, depth + 1) : null;
    const id = tx.createTag({
      name: t.action.name,
      color: t.action.color,
      ...(parentId && { parentId }),
      ...(t.source.icon && { icon: t.source.icon }),
      ...(t.source.osmCategories && { osmCategories: t.source.osmCategories }),
    });
    ids.set(key, id);
    report.createdTagIds.push(id);
    if (t.source.deleted) tx.deleteTag(id);
    return id;
  };
  for (const t of pending) create(t.source.key);
  return ids;
}

function remapFilter(f: ListFilter, tagIds: Map<string, string>): ListFilter {
  const out: ListFilter = { ...f };
  if (f.tags) out.tags = f.tags.map((k) => tagIds.get(k)).filter((x): x is string => !!x);
  return out;
}

export async function applyImport(store: DataStore, plan: ImportPlan, opts: ApplyOptions = {}): Promise<ImportReport> {
  const batchSize = Math.max(1, opts.batchSize ?? 200);
  const yieldFn = opts.yieldFn ?? defaultYield;
  const now = opts.now ?? Date.now;
  const report: ImportReport = {
    format: plan.format,
    at: now(),
    cancelled: false,
    createdPlaceIds: [],
    merged: [],
    createdTagIds: [],
    createdListIds: [],
    counts: {
      imported: 0,
      created: 0,
      merged: 0,
      linkedToOsm: 0,
      manual: 0,
      toCheck: 0,
      skipped: 0,
      duplicates: 0,
      photos: 0,
      photosSkipped: 0,
      remotePhotos: 0,
      remotePhotosFailed: 0,
      alreadySaved: 0,
      unchanged: 0,
      maybeClosed: 0,
    },
  };
  const counts = report.counts as Required<ImportReport['counts']>;
  // Fold duplicates into their primary item.
  const folded = new Map<string, ImportedPlace[]>();
  for (const it of plan.items) {
    if (it.resolution.kind === 'skip') report.counts.skipped++;
    else if (it.duplicateOf) {
      report.counts.duplicates++;
      (folded.get(it.duplicateOf) ?? folded.set(it.duplicateOf, []).get(it.duplicateOf)!).push(it.place);
    }
  }
  const writable = plan.items.filter((it) => it.resolution.kind !== 'skip' && !it.duplicateOf && (it.resolution.kind === 'osm' || it.position || it.place.shape));
  // Places already in my saves are left as they are unless the user chose to merge.
  const work = plan.mergeExisting ? writable : writable.filter((it) => !it.existing);
  counts.alreadySaved = writable.length - work.length;
  report.counts.skipped += plan.items.filter((it) => it.resolution.kind !== 'skip' && !it.duplicateOf && !writable.includes(it)).length;
  const total = work.length;
  opts.onProgress?.(0, total);

  const tagIds = store.change((tx) => writeTags(tx, plan, report), 'import');
  const mapTags = (keys: readonly string[]) => [...new Set(keys.map((k) => tagIds.get(k)).filter((x): x is string => !!x))];
  // Source tags that stand for a status ("À essayer" → to try): the best one wins over the place's own.
  const tagStatus = new Map<string, SaveStatus>();
  for (const t of plan.tags) if (t.action.kind === 'status') tagStatus.set(t.source.key, t.action.status);
  const statusOf = (place: ImportedPlace): SaveStatus | undefined =>
    [place.status, ...place.tags.map((k) => tagStatus.get(k))]
      .filter((x): x is SaveStatus => !!x)
      .sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0];
  const closureFlags: { placeId: string; signals: PlanItem['closure'] }[] = [];
  // Photos to download once the places are written (asked in the preview).
  const downloads: PhotoJob[] = [];
  const queued = new Set<string>();
  const wantDownloads = plan.downloadRemotePhotos && !!opts.fetchPhoto && !!opts.addDownloadedPhoto;
  const queue = (placeId: string, saveId: string | null, list: readonly RemotePhoto[] | undefined, merged?: MergedSave) => {
    if (!wantDownloads || !list?.length) return;
    const have = saveId ? new Set(store.repo.getMedia(saveId).map((m) => m.id)) : new Set<string>();
    for (const photo of list) {
      const id = remotePhotoId(placeId, photo.key);
      if (have.has(id) || queued.has(id)) continue;
      queued.add(id);
      downloads.push({ placeId, id, photo, ...(merged && { merged }) });
    }
  };
  const osmCache: { placeId: string; tags: Record<string, string>; address?: string }[] = [];

  let written = 0;
  for (let i = 0; i < work.length; i += batchSize) {
    if (opts.signal?.aborted) {
      report.cancelled = true;
      break;
    }
    const batch = work.slice(i, i + batchSize);
    // Reads (existing saves) before the change.
    const existing = new Map(batch.map((it) => {
      const id = it.existing?.placeId ?? targetPlaceId(it);
      return [it.key, id ? store.repo.getMySaveForPlace(id) : null] as const;
    }));
    // Photos are stored after the batch's change (the app's photo store writes its own change).
    const photos: { placeId: string; photo: ImportedPhoto; merged?: MergedSave }[] = [];
    store.change((tx) => {
      for (const it of batch) {
        const merged0 = mergeImported(it.place, folded.get(it.key) ?? []);
        const status = statusOf(merged0);
        const place: ImportedPlace = { ...merged0, ...(status && { status }) };
        const tags = mapTags(place.tags);
        const main = place.mainTag ? tagIds.get(place.mainTag) : undefined;
        const ordered = main ? [main, ...tags.filter((t) => t !== main)] : tags;
        const cur = existing.get(it.key);
        if (cur) {
          const merged: MergedSave = { placeId: cur.placeId, addedTagIds: ordered.filter((t) => !cur.tagIds.includes(t)) };
          const comment = mergeComment(cur.comment, place.comment);
          if (comment !== null) {
            merged.previousComment = cur.comment;
            tx.updateSave(cur.placeId, { comment });
          }
          if (!cur.status && place.status) {
            merged.previousStatus = cur.status;
            tx.updateSave(cur.placeId, { status: place.status });
          }
          if (!cur.priceLevel && place.priceLevel) tx.updateSave(cur.placeId, { priceLevel: place.priceLevel });
          if (merged.addedTagIds.length > 0) tx.setSaveTags(cur.placeId, [...cur.tagIds, ...merged.addedTagIds], cur.mainTagId ?? ordered[0] ?? null);
          if (cur.deletedAt !== null && !place.trashed) {
            tx.restoreSave(cur.placeId);
            merged.restoredFromTrash = true;
          }
          if (comment === null && merged.previousStatus === undefined && merged.addedTagIds.length === 0 && !merged.restoredFromTrash && !(!cur.priceLevel && place.priceLevel)) {
            counts.unchanged++;
          }
          const have = new Set(store.repo.getMedia(cur.id).map((m) => m.file));
          for (const m of place.media ?? []) if (!have.has(m.file)) photos.push({ placeId: cur.placeId, photo: m, merged });
          queue(cur.placeId, cur.id, place.remotePhotos, merged);
          report.merged.push(merged);
          report.counts.merged++;
        } else {
          const snapshot = snapshotFor(it, place, opts.newId);
          const placeId = tx.putSave({
            place: snapshot,
            tagIds: ordered,
            mainTagId: ordered[0] ?? null,
            ...(place.comment && { comment: place.comment }),
            ...(place.status && { status: place.status }),
            ...(place.priceLevel && { priceLevel: place.priceLevel }),
            ...(place.sharing && { sharing: place.sharing }),
            ...(place.commentVisibility && { commentVisibility: place.commentVisibility }),
            ...(place.createdAt && { createdAt: place.createdAt }),
          });
          for (const m of place.media ?? []) photos.push({ placeId, photo: m });
          queue(placeId, null, place.remotePhotos);
          if (place.trashed) tx.deleteSave(placeId);
          if (it.closure.length > 0) closureFlags.push({ placeId, signals: it.closure });
          report.createdPlaceIds.push(placeId);
          report.counts.created++;
          if (it.resolution.kind === 'osm' && it.resolution.candidate.tags) {
            osmCache.push({ placeId, tags: it.resolution.candidate.tags, ...(it.resolution.candidate.address && { address: it.resolution.candidate.address }) });
          }
        }
        const target = targetPlaceId(it);
        if (target?.startsWith('osm:')) report.counts.linkedToOsm++;
        else report.counts.manual++;
        if (it.match.kind === 'ambiguous') report.counts.toCheck++;
      }
    }, 'import');
    for (const { placeId, photo, merged } of photos) {
      const images = photo.images;
      if (!images || !opts.addPhoto) {
        counts.photosSkipped++;
        continue;
      }
      try {
        const id = opts.addPhoto(placeId, { ...photo, images });
        counts.photos++;
        if (merged) (merged.addedMediaIds ??= []).push(id);
      } catch {
        counts.photosSkipped++;
      }
    }
    written += batch.length;
    report.counts.imported = written;
    opts.onProgress?.(written, total);
    await yieldFn();
  }

  if (!report.cancelled) {
    // Lists and tag mappings of a TrianguLair export.
    const extras = plan.extras;
    if (extras) {
      const have = new Set(store.repo.lists({ includeDeleted: true }).map((l) => `${l.kind}\n${normalizeText(l.name)}`));
      store.change((tx) => {
        for (const l of extras.lists) {
          if (have.has(`${l.kind}\n${normalizeText(l.name)}`)) continue;
          const id = tx.createList({
            name: l.name,
            description: l.description,
            visibility: l.visibility,
            linkKey: l.linkKey,
            kind: l.kind,
            filter: remapFilter(l.filter, tagIds),
            items: l.items,
          });
          if (l.deletedAt !== null) tx.deleteList(id);
          report.createdListIds.push(id);
        }
        for (const m of extras.tagMappings) {
          const mine = tagIds.get(m.myTag);
          if (mine) tx.setTagMapping(m.personId, m.theirTag, mine);
        }
      }, 'import');
    }
    // OSM data of matched places (local cache, not in the document).
    for (const c of osmCache) {
      try {
        store.repo.updatePlaceOsmData(c.placeId, { osmTags: c.tags, ...(c.address && { address: c.address }) });
      } catch {
        // the place card is refreshed later anyway
      }
    }
  }
  if (!report.cancelled && downloads.length > 0) await downloadPhotos(downloads, opts, report);
  // "Maybe closed", the closure system's flag (place cache): the card shows the badge and asks.
  for (const f of closureFlags) {
    try {
      store.repo.updatePlaceOsmData(f.placeId, { status: 'maybe_closed', closedSignals: f.signals });
      counts.maybeClosed++;
    } catch {
      // the monthly check looks again
    }
  }
  return report;
}

interface PhotoJob {
  placeId: string;
  /** The photo id it gets (`remotePhotoId`). */
  id: string;
  photo: RemotePhoto;
  merged?: MergedSave;
}

/** One download, given up after `ms` or when `signal` aborts (even if the fetcher ignores its signal). */
function fetchWithTimeout(fetchPhoto: NonNullable<ApplyOptions['fetchPhoto']>, url: string, ms: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort);
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error('timeout'));
    }, ms);
    ac.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  return Promise.race([fetchPhoto(url, ac.signal), stop]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}

const isBlocked = (e: unknown) => e instanceof PhotoDownloadBlockedError || (e instanceof Error && e.name === 'PhotoDownloadBlockedError');

/**
 * Downloads the photos asked for, a few at a time, each URL of a photo in turn (full size, then
 * smaller). A photo that fails is counted, never an error of the import. Stops on cancel, and on
 * the first download the platform blocks (the others would be blocked too).
 */
async function downloadPhotos(jobs: readonly PhotoJob[], opts: ApplyOptions, report: ImportReport): Promise<void> {
  const fetchPhoto = opts.fetchPhoto!;
  const addPhoto = opts.addDownloadedPhoto!;
  const timeout = opts.photoTimeoutMs ?? 30_000;
  const counts = report.counts as Required<ImportReport['counts']>;
  let next = 0;
  let done = 0;
  const stopped = () => opts.signal?.aborted || report.photoDownloadBlocked;
  opts.onPhotoProgress?.(0, jobs.length);
  const worker = async () => {
    while (!stopped() && next < jobs.length) {
      const job = jobs[next++]!;
      let ok = false;
      for (const url of job.photo.urls) {
        if (stopped()) break;
        try {
          const image = await fetchWithTimeout(fetchPhoto, url, timeout, opts.signal);
          if (stopped()) break;
          const id = await addPhoto(job.placeId, image, { id: job.id, ...(job.photo.mime && { mime: job.photo.mime }) });
          if (job.merged) (job.merged.addedMediaIds ??= []).push(id);
          ok = true;
          break;
        } catch (e) {
          if (isBlocked(e)) report.photoDownloadBlocked = true;
          // else: the next URL of this photo
        }
      }
      if (ok) counts.remotePhotos++;
      done++;
      opts.onPhotoProgress?.(done, jobs.length);
    }
  };
  const n = Math.max(1, Math.min(opts.photoConcurrency ?? 3, jobs.length));
  await Promise.all(Array.from({ length: n }, worker));
  counts.remotePhotosFailed = jobs.length - counts.remotePhotos;
  if (opts.signal?.aborted) report.cancelled = true;
}

/**
 * Undoes an import: new saves go to the trash (restorable for 30 days),
 * merged saves lose the tags the import added and get their comment and
 * status back, created tags and lists are deleted. Batched like the import.
 */
export async function undoImport(store: DataStore, report: ImportReport, opts: Omit<ApplyOptions, 'newId' | 'now'> = {}): Promise<void> {
  const batchSize = Math.max(1, opts.batchSize ?? 200);
  const yieldFn = opts.yieldFn ?? defaultYield;
  const total = report.createdPlaceIds.length + report.merged.length;
  let done = 0;
  opts.onProgress?.(0, total);
  const ops: (() => (tx: DocTx) => void)[] = [
    ...report.createdPlaceIds.map((id) => () => (tx: DocTx) => {
      const s = store.repo.getMySaveForPlace(id);
      if (s && s.deletedAt === null) tx.deleteSave(id);
    }),
    ...report.merged.map((m) => () => (tx: DocTx) => {
      const s = store.repo.getMySaveForPlace(m.placeId);
      if (!s) return;
      if (m.addedTagIds.length > 0) tx.setSaveTags(m.placeId, s.tagIds.filter((t) => !m.addedTagIds.includes(t)));
      if (m.previousComment !== undefined) tx.updateSave(m.placeId, { comment: m.previousComment });
      if (m.previousStatus !== undefined) tx.updateSave(m.placeId, { status: m.previousStatus });
      for (const id of m.addedMediaIds ?? []) tx.removeMedia(m.placeId, id);
      if (m.restoredFromTrash) tx.deleteSave(m.placeId);
    }),
  ];
  for (let i = 0; i < ops.length; i += batchSize) {
    if (opts.signal?.aborted) return;
    const batch = ops.slice(i, i + batchSize).map((f) => f());
    store.change((tx) => {
      for (const f of batch) f(tx);
    }, 'undo-import');
    done += batch.length;
    opts.onProgress?.(done, total);
    await yieldFn();
  }
  store.change((tx) => {
    for (const id of report.createdListIds) if (store.repo.getList(id)?.deletedAt === null) tx.deleteList(id);
    for (const id of report.createdTagIds) {
      const t = store.repo.tags().find((x) => x.id === id);
      if (t && t.deletedAt === null) tx.deleteTag(id);
    }
  }, 'undo-import');
}
