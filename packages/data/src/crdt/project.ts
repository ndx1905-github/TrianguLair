// SPDX-License-Identifier: MPL-2.0
/**
 * Projection of the Automerge document into SQLite.
 *
 * Deterministic: the rows written for an item depend only on the document
 * state (never on the device, the order of merges or the previous rows), so
 * two devices holding the same document hold the same projection, and an
 * incremental projection equals a full one (both property-tested).
 */
import * as A from '@automerge/automerge';
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
  Sharing,
  TagMappingRecord,
  TagRecord,
} from '../types.ts';
import { filterFromDoc, readDeletedAt, readSharing, snapshotFromDoc, str, strOrNull, type DataDoc } from './doc.ts';

export { saveIdFor };

export interface ProjectedSave {
  save: SaveRecord;
  place: PlaceSnapshot;
  media: MediaRecord[];
}

export function readSave(doc: A.Doc<DataDoc>, placeId: string, meId: string): ProjectedSave | null {
  const s = doc.saves[placeId];
  if (!s) return null;
  const id = saveIdFor(meId, placeId);
  const tags = Object.keys(s.tagIds ?? {}).sort();
  let main = strOrNull(s.mainTagId);
  if (main !== null && !tags.includes(main)) main = tags[0] ?? null;
  if (main === null) main = tags[0] ?? null;
  const tagIds = main === null ? tags : [main, ...tags.filter((t) => t !== main)];
  const media: MediaRecord[] = Object.keys(s.media ?? {})
    .sort()
    .map((mid) => {
      const m = s.media[mid]!;
      return {
        id: mid,
        saveId: id,
        file: str(m.file),
        blurhash: strOrNull(m.blurhash),
        width: m.width ?? null,
        height: m.height ?? null,
        createdAt: m.createdAt,
      };
    });
  return {
    save: {
      id,
      ownerId: meId,
      placeId,
      comment: String(s.comment ?? ''),
      commentVisibility: str(s.commentVisibility) as CommentVisibility,
      status: strOrNull(s.status) as SaveStatus | null,
      priceLevel: (s.priceLevel ?? null) as PriceLevel | null,
      sharing: readSharing(s),
      mainTagId: main,
      tagIds,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      deletedAt: readDeletedAt(s),
    },
    place: snapshotFromDoc(placeId, s.place),
    media,
  };
}

/**
 * My tags, with parent cycles broken (concurrent re-parenting on two devices
 * can create one: the tag with the smallest id in the cycle loses its parent)
 * and `active` = not in the trash and no ancestor in the trash.
 */
export function readTags(doc: A.Doc<DataDoc>, meId: string): (TagRecord & { active: boolean })[] {
  const ids = Object.keys(doc.tags).sort();
  const parent = new Map<string, string | null>();
  for (const id of ids) {
    const p = strOrNull(doc.tags[id]!.parentId);
    parent.set(id, p !== null && p !== id && doc.tags[p] ? p : null);
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
    const v = readDeletedAt(doc.tags[id]) === null && (p === null || isActive(p));
    activeMemo.set(id, v);
    return v;
  };
  return ids.map((id) => {
    const t = doc.tags[id]!;
    return {
      id,
      ownerId: meId,
      parentId: parent.get(id) ?? null,
      name: str(t.name),
      color: strOrNull(t.color),
      icon: strOrNull(t.icon),
      osmCategories: Object.keys(t.osmCategories ?? {}).sort(),
      deletedAt: readDeletedAt(t),
      active: isActive(id),
    };
  });
}

export function readList(doc: A.Doc<DataDoc>, id: string, meId: string): ListRecord | null {
  const l = doc.lists[id];
  if (!l) return null;
  return {
    id,
    ownerId: meId,
    name: str(l.name),
    description: String(l.description ?? ''),
    visibility: str(l.visibility) as ListVisibility,
    linkKey: strOrNull(l.linkKey),
    kind: str(l.kind) as ListKind,
    filter: filterFromDoc(l.filter),
    manualItems: Object.keys(l.items ?? {}).sort(),
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    deletedAt: readDeletedAt(l),
  };
}

export function readTagMappings(doc: A.Doc<DataDoc>): TagMappingRecord[] {
  return Object.keys(doc.tagMappings)
    .sort()
    .map((k) => {
      const [personId, theirTag] = k.split('\n') as [string, string];
      return { personId, theirTag, myTagId: str(doc.tagMappings[k]) };
    });
}

/** Rebuilds my whole projection from the document. */
export function projectAll(doc: A.Doc<DataDoc>, repo: Repository): void {
  repo.transaction(() => {
    repo.writeOwnTags(readTags(doc, repo.meId));
    const keep = new Set<string>();
    for (const placeId of Object.keys(doc.saves).sort()) {
      const p = readSave(doc, placeId, repo.meId)!;
      keep.add(p.save.id);
      repo.writeOwnSave(p.save, p.place, p.media);
    }
    for (const id of repo.ownSaveIds()) if (!keep.has(id)) repo.removeOwnSave(id);
    const lists = new Set(Object.keys(doc.lists));
    for (const id of [...lists].sort()) repo.writeOwnList(readList(doc, id, repo.meId)!);
    for (const id of repo.ownListIds()) if (!lists.has(id)) repo.removeOwnList(id);
    repo.writeTagMappings(readTagMappings(doc));
    repo.markListsDirty();
  });
}

export interface Touched {
  saves: Set<string>;
  tags: boolean;
  lists: Set<string>;
  tagMappings: boolean;
  all: boolean;
}

export function touchedBetween(doc: A.Doc<DataDoc>, before: A.Heads, after: A.Heads = A.getHeads(doc)): Touched {
  const t: Touched = { saves: new Set(), tags: false, lists: new Set(), tagMappings: false, all: false };
  if (before.length === 0) {
    t.all = true;
    return t;
  }
  for (const patch of A.diff(doc, before, after)) {
    const [root, id] = patch.path;
    if (patch.path.length < 2) {
      if (root === 'tombstones' || root === undefined) continue;
      t.all = true;
      continue;
    }
    if (root === 'saves') t.saves.add(String(id));
    else if (root === 'tags') t.tags = true;
    else if (root === 'lists') t.lists.add(String(id));
    else if (root === 'tagMappings') t.tagMappings = true;
  }
  return t;
}

/** Projects what changed in the document between `before` and its current heads. */
export function projectChanges(doc: A.Doc<DataDoc>, repo: Repository, before: A.Heads): void {
  const t = touchedBetween(doc, before);
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
