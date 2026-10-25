// SPDX-License-Identifier: MPL-2.0
/**
 * Projection of the Yjs document into SQLite.
 *
 * Deterministic: the rows written for an item depend only on the document
 * state (never on the device, the order of merges or the previous rows), so
 * two devices holding the same document hold the same projection, and an
 * incremental projection equals a full one (both property-tested).
 */
import * as Y from 'yjs';
import { saveIdFor } from '../ids.ts';
import type { Repository } from '../sqlite/repository.ts';
import type {
  CommentVisibility,
  ListKind,
  ListRecord,
  ListVisibility,
  MediaRecord,
  PlaceSnapshot,
  PriceLevel,
  SaveRecord,
  SaveStatus,
  TagMappingRecord,
  TagRecord,
} from '../types.ts';
import {
  filterFromDoc,
  getMap,
  getNum,
  getStr,
  getStrOrNull,
  getText,
  keysOf,
  placeOfEntry,
  readDeletedAt,
  readSharing,
  roots,
  saveEntry,
  saveMedia,
  savePlaceIds,
  saveTagIds,
  snapshotFromEntry,
  type DataDoc,
} from './doc.ts';

export { saveIdFor };

export interface ProjectedSave {
  save: SaveRecord;
  place: PlaceSnapshot;
  media: MediaRecord[];
}

export function readSave(doc: DataDoc, placeId: string, meId: string): ProjectedSave | null {
  const s = saveEntry(doc, placeId);
  if (!s) return null;
  const id = saveIdFor(meId, placeId);
  const tags = saveTagIds(s);
  let main = getStrOrNull(s, 'mainTagId');
  if (main !== null && !tags.includes(main)) main = tags[0] ?? null;
  if (main === null) main = tags[0] ?? null;
  const tagIds = main === null ? tags : [main, ...tags.filter((t) => t !== main)];
  const media: MediaRecord[] = saveMedia(s).map(([mid, m]) => {
    return {
      id: mid,
      saveId: id,
      file: String(m.file ?? ''),
      blurhash: m.blurhash ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
      createdAt: m.createdAt ?? 0,
    };
  });
  return {
    save: {
      id,
      ownerId: meId,
      placeId,
      comment: getText(s, 'comment'),
      commentVisibility: (getStrOrNull(s, 'commentVisibility') ?? 'friends') as CommentVisibility,
      status: getStrOrNull(s, 'status') as SaveStatus | null,
      priceLevel: getNum(s, 'priceLevel') as PriceLevel | null,
      sharing: readSharing(s),
      mainTagId: main,
      tagIds,
      createdAt: getNum(s, 'createdAt') ?? 0,
      updatedAt: getNum(s, 'updatedAt') ?? getNum(s, 'createdAt') ?? 0,
      deletedAt: readDeletedAt(s),
    },
    place: snapshotFromEntry(placeId, s),
    media,
  };
}

/**
 * My tags, with parent cycles broken (concurrent re-parenting on two devices
 * can create one: the tag with the smallest id in the cycle loses its parent)
 * and `active` = not in the trash and no ancestor in the trash.
 */
export function readTags(doc: DataDoc, meId: string): (TagRecord & { active: boolean })[] {
  const all = roots(doc).tags;
  const ids = [...all.keys()].sort();
  const parent = new Map<string, string | null>();
  for (const id of ids) {
    const p = getStrOrNull(all.get(id)!, 'parentId');
    parent.set(id, p !== null && p !== id && all.has(p) ? p : null);
  }
  for (;;) {
    let broke = false;
    const done = new Set<string>();
    for (const start of ids) {
      if (done.has(start)) continue;
      const path: string[] = [];
      const onPath = new Set<string>();
      let cur: string | null = start;
      while (cur !== null && !done.has(cur)) {
        if (onPath.has(cur)) {
          const cycle = path.slice(path.indexOf(cur));
          parent.set(cycle.sort()[0]!, null);
          broke = true;
          break;
        }
        onPath.add(cur);
        path.push(cur);
        cur = parent.get(cur) ?? null;
      }
      if (broke) break;
      for (const p of path) done.add(p);
    }
    if (!broke) break;
  }
  const activeMemo = new Map<string, boolean>();
  const isActive = (id: string): boolean => {
    const known = activeMemo.get(id);
    if (known !== undefined) return known;
    const p = parent.get(id) ?? null;
    const v = readDeletedAt(all.get(id)) === null && (p === null || isActive(p));
    activeMemo.set(id, v);
    return v;
  };
  return ids.map((id) => {
    const t = all.get(id)!;
    return {
      id,
      ownerId: meId,
      parentId: parent.get(id) ?? null,
      name: getStr(t, 'name'),
      color: getStrOrNull(t, 'color'),
      icon: getStrOrNull(t, 'icon'),
      osmCategories: keysOf(getMap(t, 'osmCategories')),
      deletedAt: readDeletedAt(t),
      active: isActive(id),
    };
  });
}

export function readList(doc: DataDoc, id: string, meId: string): ListRecord | null {
  const l = roots(doc).lists.get(id);
  if (!l) return null;
  return {
    id,
    ownerId: meId,
    name: getStr(l, 'name'),
    description: getText(l, 'description'),
    visibility: (getStrOrNull(l, 'visibility') ?? 'link') as ListVisibility,
    linkKey: getStrOrNull(l, 'linkKey'),
    kind: getStr(l, 'kind') as ListKind,
    filter: filterFromDoc(getMap(l, 'filter')),
    manualItems: keysOf(getMap(l, 'items')),
    createdAt: getNum(l, 'createdAt') ?? 0,
    updatedAt: getNum(l, 'updatedAt') ?? 0,
    deletedAt: readDeletedAt(l),
  };
}

export function readTagMappings(doc: DataDoc): TagMappingRecord[] {
  const m = roots(doc).tagMappings;
  return [...m.keys()].sort().map((k) => {
    const i = k.indexOf('\n');
    return { personId: k.slice(0, i), theirTag: k.slice(i + 1), myTagId: String(m.get(k)) };
  });
}

/** Rebuilds my whole projection from the document. */
export function projectAll(doc: DataDoc, repo: Repository): void {
  repo.transaction(() => {
    repo.writeOwnTags(readTags(doc, repo.meId));
    const keep = new Set<string>();
    for (const placeId of savePlaceIds(doc)) {
      const p = readSave(doc, placeId, repo.meId)!;
      keep.add(p.save.id);
      repo.writeOwnSave(p.save, p.place, p.media);
    }
    for (const id of repo.ownSaveIds()) if (!keep.has(id)) repo.removeOwnSave(id);
    const lists = roots(doc).lists;
    for (const id of [...lists.keys()].sort()) repo.writeOwnList(readList(doc, id, repo.meId)!);
    for (const id of repo.ownListIds()) if (!lists.has(id)) repo.removeOwnList(id);
    repo.writeTagMappings(readTagMappings(doc));
    repo.markListsDirty();
  });
}

/** What a set of Yjs transactions touched, for an incremental projection. */
export interface Touched {
  /** Place ids. */
  saves: Set<string>;
  tags: boolean;
  /** List ids. */
  lists: Set<string>;
  tagMappings: boolean;
  /** Something outside the known layout changed (meta): re-project everything. */
  all: boolean;
}

export function emptyTouched(): Touched {
  return { saves: new Set(), tags: false, lists: new Set(), tagMappings: false, all: false };
}

type DeepHandler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void;

/**
 * Runs `fn` (local edits, `Y.applyUpdate`, healing…) and returns what it
 * touched, from the Yjs events of the root types.
 */
export function trackChanges<T>(doc: DataDoc, fn: () => T, into: Touched = emptyTouched()): { result: T; touched: Touched } {
  const r = roots(doc);
  const keyed = (add: (key: string) => void): DeepHandler => (events) => {
    for (const ev of events) {
      if (ev.path.length === 0) for (const k of (ev as Y.YMapEvent<unknown>).keysChanged) add(k);
      else add(String(ev.path[0]));
    }
  };
  const handlers: [Y.AbstractType<unknown>, DeepHandler][] = [
    [r.saves as Y.AbstractType<unknown>, keyed((k) => into.saves.add(placeOfEntry(k)))],
    [r.lists as Y.AbstractType<unknown>, keyed((k) => into.lists.add(k))],
    [r.tags as Y.AbstractType<unknown>, () => (into.tags = true)],
    [r.tagMappings as Y.AbstractType<unknown>, () => (into.tagMappings = true)],
    [r.meta as Y.AbstractType<unknown>, () => (into.all = true)],
  ];
  for (const [t, h] of handlers) t.observeDeep(h);
  try {
    return { result: fn(), touched: into };
  } finally {
    for (const [t, h] of handlers) t.unobserveDeep(h);
  }
}

/** Projects what a set of transactions touched (see `trackChanges`). */
export function projectChanges(doc: DataDoc, repo: Repository, t: Touched): void {
  if (t.all) return projectAll(doc, repo);
  repo.transaction(() => {
    if (t.tags) repo.writeOwnTags(readTags(doc, repo.meId));
    for (const placeId of [...t.saves].sort()) {
      const p = readSave(doc, placeId, repo.meId);
      if (p) repo.writeOwnSave(p.save, p.place, p.media);
      else repo.removeOwnSave(saveIdFor(repo.meId, placeId));
    }
    for (const id of [...t.lists].sort()) {
      const l = readList(doc, id, repo.meId);
      if (l) repo.writeOwnList(l);
      else repo.removeOwnList(id);
    }
    if (t.tagMappings) repo.writeTagMappings(readTagMappings(doc));
    if (t.tags || t.saves.size > 0) repo.markListsDirty();
  });
}
