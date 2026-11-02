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

import type { ImportedPlace, SourceFormat } from './model.ts';
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
}

export interface MergedSave {
  placeId: string;
  addedTagIds: string[];
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
  };
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
    counts: { imported: 0, created: 0, merged: 0, linkedToOsm: 0, manual: 0, toCheck: 0, skipped: 0, duplicates: 0 },
  };
  // Fold duplicates into their primary item.
  const folded = new Map<string, ImportedPlace[]>();
  for (const it of plan.items) {
    if (it.resolution.kind === 'skip') report.counts.skipped++;
    else if (it.duplicateOf) {
      report.counts.duplicates++;
      (folded.get(it.duplicateOf) ?? folded.set(it.duplicateOf, []).get(it.duplicateOf)!).push(it.place);
    }
  }
  const work = plan.items.filter((it) => it.resolution.kind !== 'skip' && !it.duplicateOf && (it.resolution.kind === 'osm' || it.position || it.place.shape));
  report.counts.skipped += plan.items.filter((it) => it.resolution.kind !== 'skip' && !it.duplicateOf && !work.includes(it)).length;
  const total = work.length;
  opts.onProgress?.(0, total);

  const tagIds = store.change((tx) => writeTags(tx, plan, report), 'import');
  const mapTags = (keys: readonly string[]) => [...new Set(keys.map((k) => tagIds.get(k)).filter((x): x is string => !!x))];
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
    store.change((tx) => {
      for (const it of batch) {
        const place = mergeImported(it.place, folded.get(it.key) ?? []);
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
          for (const m of place.media ?? []) {
            tx.addMedia(placeId, { id: m.id, file: m.file, blurhash: m.blurhash ?? null, width: m.width ?? null, height: m.height ?? null });
          }
          if (place.trashed) tx.deleteSave(placeId);
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
  return report;
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
