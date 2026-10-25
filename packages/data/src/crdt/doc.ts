// SPDX-License-Identifier: MPL-2.0
/**
 * The Automerge document holding the user's own data: saves (places and
 * zones), tags, lists, tag mappings. It is the source of truth; SQLite is a
 * projection of it (see project.ts). Every device of the user holds a replica;
 * replicas merge without conflicts (CRDT) and converge.
 *
 * Layout choices that matter for merging:
 *
 * - The root maps are created by a fixed, deterministic first change (fixed
 *   actor, time 0). Every device starts from that same change, so two devices
 *   that never met still share the root maps instead of each creating its own
 *   `saves` map, one of which would hide the other after a merge.
 * - Saves are keyed by place id (one save per place and owner, spec "No
 *   duplicates"). Two devices saving the same OSM place offline both create
 *   `saves[placeId]`; Automerge keeps one object and hides the other as a
 *   conflict. `healDoc` folds the hidden one into the visible one (tags and
 *   photos united, empty fields filled) once, deterministically.
 * - Sets (tags of a save, filter criteria, exceptions, manual items) are maps
 *   of `key → true` so concurrent additions and removals of different keys
 *   all survive.
 * - The comment and descriptions are collaborative text (character merges);
 *   other strings are atomic (`ImmutableString`, last writer wins).
 * - Deletion is a tombstone (`deletedAt`): the item goes to the trash and is
 *   restorable. If one device deletes while another restores, the deletion
 *   wins (spec "Editing and deleting"): any concurrent non-null `deletedAt`
 *   counts. After 30 days, `purgeTrash` removes the item and leaves a small
 *   marker in `tombstones` (kept six months, for friends' caches).
 */
import * as A from '@automerge/automerge';
import { canonicalJson } from '../filter.ts';
import { randomId, type IdGenerator } from '../ids.ts';
import { normalizeSnapshot, type PlaceSnapshotInput } from '../place.ts';
import type {
  AreaGeometry,
  CommentVisibility,
  FilterZone,
  ListFilter,
  ListKind,
  ListVisibility,
  OsmType,
  PlaceGeometry,
  PlaceKind,
  PlaceSnapshot,
  PriceLevel,
  SaveStatus,
  Sharing,
  ZoneEdge,
} from '../types.ts';

type Imm = A.ImmutableString;
type Set_ = Record<string, true>;

export interface DocPlace {
  osmType: Imm | null;
  osmId: number | null;
  name: Imm;
  category: Imm | null;
  kind: Imm;
  edge: Imm;
  /** GeoJSON geometry as JSON text (atomic). */
  geometry: Imm;
}

export interface DocMedia {
  file: Imm;
  blurhash: Imm | null;
  width: number | null;
  height: number | null;
  createdAt: number;
}

export interface DocSave {
  place: DocPlace;
  comment: string;
  commentVisibility: Imm;
  status: Imm | null;
  priceLevel: number | null;
  sharing: Imm;
  mainTagId: Imm | null;
  tagIds: Set_;
  media: Record<string, DocMedia>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** Hidden concurrent creations already folded in (op ids), see healDoc. */
  absorbed: Set_;
}

export interface DocTag {
  parentId: Imm | null;
  name: Imm;
  color: Imm | null;
  icon: Imm | null;
  osmCategories: Set_;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface DocFilter {
  tags: Set_;
  categories: Set_;
  statuses: Set_;
  priceLevels: Set_;
  /** zone key → FilterZone as JSON text. */
  zones: Record<string, Imm>;
  include: Set_;
  exclude: Set_;
}

export interface DocList {
  name: Imm;
  description: string;
  visibility: Imm;
  linkKey: Imm | null;
  kind: Imm;
  filter: DocFilter;
  /** Manual lists: place id → time added. */
  items: Record<string, number>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface DataDoc {
  schema: number;
  saves: Record<string, DocSave>;
  tags: Record<string, DocTag>;
  lists: Record<string, DocList>;
  /** `${personId}\n${theirTag}` → my tag id. */
  tagMappings: Record<string, Imm>;
  /** `save:<placeId>`, `tag:<id>`, `list:<id>` → purge time. */
  tombstones: Record<string, number>;
}

export const DOC_SCHEMA = 1;
export const TRASH_RETENTION_MS = 30 * 24 * 3600 * 1000;
export const TOMBSTONE_RETENTION_MS = 183 * 24 * 3600 * 1000;

const BASE_ACTOR = '00000000000000000000000000000000';

let baseBytes: Uint8Array | null = null;
function base(): Uint8Array {
  if (!baseBytes) {
    const doc = A.change(A.init<DataDoc>({ actor: BASE_ACTOR }), { time: 0, message: 'triangulair:data:v1' }, (d) => {
      d.schema = DOC_SCHEMA;
      d.saves = {};
      d.tags = {};
      d.lists = {};
      d.tagMappings = {};
      d.tombstones = {};
    });
    baseBytes = A.save(doc);
  }
  return baseBytes;
}

/** A new empty replica. `actor`: hex, unique per device (random by default). */
export function createDataDoc(actor?: string): A.Doc<DataDoc> {
  return A.load<DataDoc>(base(), actor ? { actor } : undefined);
}

export function loadDataDoc(bytes: Uint8Array, actor?: string): A.Doc<DataDoc> {
  const doc = A.load<DataDoc>(bytes, actor ? { actor } : undefined);
  if (doc.schema !== DOC_SCHEMA) throw new Error(`unsupported data document schema ${String(doc.schema)}`);
  return doc;
}

// ------------------------------------------------------------------ reading helpers

const imm = (s: string): Imm => new A.ImmutableString(s);
const immOrNull = (s: string | null | undefined): Imm | null => (s == null ? null : imm(s));

export function str(v: unknown): string {
  if (v == null) return '';
  if (A.isImmutableString(v)) return (v as Imm).val;
  return String(v);
}
export function strOrNull(v: unknown): string | null {
  return v == null ? null : str(v);
}

/** Delete-wins read of `deletedAt` on an object (the latest concurrent deletion, if any). */
export function readDeletedAt(parent: unknown): number | null {
  let conflicts: Record<string, unknown> | undefined;
  try {
    conflicts = A.getConflicts(parent as A.Doc<unknown>, 'deletedAt') as Record<string, unknown> | undefined;
  } catch {
    conflicts = undefined; // a materialized (non-proxy) value
  }
  let out: number | null = null;
  if (conflicts) {
    for (const v of Object.values(conflicts)) if (typeof v === 'number' && (out === null || v > out)) out = v;
  } else {
    const v = (parent as { deletedAt?: unknown }).deletedAt;
    if (typeof v === 'number') out = v;
  }
  return out;
}

/**
 * Privacy-wins read of `sharing`: if two devices set it concurrently and one
 * of them chose "private", the save is private until someone sets it again
 * (a private place must never leak to friends or into a list by a merge).
 */
export function readSharing(save: unknown): Sharing {
  let conflicts: Record<string, unknown> | undefined;
  try {
    conflicts = A.getConflicts(save as A.Doc<unknown>, 'sharing') as Record<string, unknown> | undefined;
  } catch {
    conflicts = undefined;
  }
  const values = conflicts ? Object.values(conflicts) : [(save as { sharing?: unknown }).sharing];
  return values.some((v) => str(v) === 'private') ? 'private' : 'friends';
}

export function snapshotFromDoc(placeId: string, p: DocPlace): PlaceSnapshot {
  return {
    id: placeId,
    osmType: strOrNull(p.osmType) as OsmType | null,
    osmId: p.osmId ?? null,
    name: str(p.name),
    category: strOrNull(p.category),
    kind: str(p.kind) as PlaceKind,
    edge: str(p.edge) as ZoneEdge,
    geometry: JSON.parse(str(p.geometry)) as PlaceGeometry,
  };
}

function docPlace(s: PlaceSnapshot): DocPlace {
  return {
    osmType: immOrNull(s.osmType),
    osmId: s.osmId,
    name: imm(s.name),
    category: immOrNull(s.category),
    kind: imm(s.kind),
    edge: imm(s.edge),
    geometry: imm(JSON.stringify(s.geometry)),
  };
}

function zoneKey(z: FilterZone): string {
  return z.kind === 'osm' ? `osm:${z.osmType}/${z.osmId}` : `drawn:${canonicalJson(z.geometry)}`;
}

export function filterFromDoc(f: DocFilter): ListFilter {
  const keys = (m: Record<string, unknown> | undefined) => Object.keys(m ?? {}).sort();
  const out: ListFilter = {};
  const set = <K extends keyof ListFilter>(k: K, v: ListFilter[K] & unknown[]) => {
    if (v.length) out[k] = v;
  };
  set('tags', keys(f.tags));
  set('categories', keys(f.categories));
  set('statuses', keys(f.statuses) as SaveStatus[]);
  set('priceLevels', keys(f.priceLevels).map(Number) as PriceLevel[]);
  set('zones', keys(f.zones).map((k) => JSON.parse(str(f.zones[k])) as FilterZone));
  set('include', keys(f.include));
  set('exclude', keys(f.exclude));
  return out;
}

// ------------------------------------------------------------------ edits

export interface EditContext {
  now(): number;
  newId: IdGenerator;
}

export const defaultEditContext: EditContext = { now: () => Date.now(), newId: randomId };

export interface SaveInput {
  place: PlaceSnapshotInput | PlaceSnapshot;
  comment?: string;
  commentVisibility?: CommentVisibility;
  status?: SaveStatus | null;
  priceLevel?: PriceLevel | null;
  /** Default "friends" (spec). */
  sharing?: Sharing;
  tagIds?: readonly string[];
  mainTagId?: string | null;
}

export interface SavePatch {
  comment?: string;
  commentVisibility?: CommentVisibility;
  status?: SaveStatus | null;
  priceLevel?: PriceLevel | null;
  sharing?: Sharing;
  mainTagId?: string | null;
  /** Manual places and drawn zones only: rename, move, redraw. */
  name?: string;
  geometry?: PlaceGeometry;
  edge?: ZoneEdge;
  category?: string | null;
}

export interface TagInput {
  name: string;
  parentId?: string | null;
  color?: string | null;
  icon?: string | null;
  osmCategories?: readonly string[];
}

export interface ListInput {
  name: string;
  description?: string;
  visibility?: ListVisibility;
  linkKey?: string | null;
  kind: ListKind;
  filter?: ListFilter;
  /** Manual lists: place ids. */
  items?: readonly string[];
}

export interface MediaInput {
  id?: string;
  file: string;
  blurhash?: string | null;
  width?: number | null;
  height?: number | null;
}

const COMMENT_VIS: readonly CommentVisibility[] = ['private', 'friends', 'public'];
const SAVE_STATUSES: readonly SaveStatus[] = ['to_try', 'tried', 'favorite'];
const SHARINGS: readonly Sharing[] = ['private', 'friends'];
const LIST_VIS: readonly ListVisibility[] = ['link', 'public'];

function check<T>(v: T, allowed: readonly T[], what: string): T {
  if (!allowed.includes(v)) throw new TypeError(`invalid ${what}: ${String(v)}`);
  return v;
}
function checkPrice(p: PriceLevel | null): PriceLevel | null {
  if (p !== null && ![1, 2, 3, 4].includes(p)) throw new TypeError(`invalid price level: ${String(p)}`);
  return p;
}

function setKeys(target: Set_, wanted: readonly string[]): void {
  const want = new Set(wanted);
  for (const k of Object.keys(target)) if (!want.has(k)) delete target[k];
  for (const k of want) if (!target[k]) target[k] = true;
}

/**
 * All edits of the user's own data, applied to an Automerge draft. Use through
 * `DataStore.change(tx => …)` (or `A.change(doc, d => new DocTx(d, ctx)…)`).
 */
export class DocTx {
  constructor(
    private readonly d: DataDoc,
    private readonly ctx: EditContext = defaultEditContext,
  ) {}

  private save(placeId: string): DocSave {
    const s = this.d.saves[placeId];
    if (!s) throw new Error(`no save for place ${placeId}`);
    return s;
  }

  private touch(s: DocSave): void {
    s.updatedAt = this.ctx.now();
  }

  /**
   * "Add to my places". Creates my save on this place, or updates it (and
   * takes it out of the trash) when it already exists. Returns the place id.
   */
  putSave(input: SaveInput): string {
    const snap = normalizeSnapshot(input.place);
    const now = this.ctx.now();
    const existing = this.d.saves[snap.id];
    if (!existing) {
      const s: DocSave = {
        place: docPlace(snap),
        comment: input.comment ?? '',
        commentVisibility: imm(check(input.commentVisibility ?? 'friends', COMMENT_VIS, 'comment visibility')),
        status: immOrNull(input.status == null ? null : check(input.status, SAVE_STATUSES, 'status')),
        priceLevel: checkPrice(input.priceLevel ?? null),
        sharing: imm(check(input.sharing ?? 'friends', SHARINGS, 'sharing')),
        mainTagId: immOrNull(input.mainTagId ?? input.tagIds?.[0] ?? null),
        tagIds: Object.fromEntries((input.tagIds ?? []).map((t) => [t, true as const])),
        media: {},
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        absorbed: {},
      };
      this.d.saves[snap.id] = s;
      return snap.id;
    }
    if (readDeletedAt(existing) !== null) existing.deletedAt = null;
    this.updateSave(snap.id, {
      ...(input.comment !== undefined && { comment: input.comment }),
      ...(input.commentVisibility !== undefined && { commentVisibility: input.commentVisibility }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.priceLevel !== undefined && { priceLevel: input.priceLevel }),
      ...(input.sharing !== undefined && { sharing: input.sharing }),
      ...(input.mainTagId !== undefined && { mainTagId: input.mainTagId }),
    });
    if (input.tagIds) this.setSaveTags(snap.id, input.tagIds, input.mainTagId);
    this.touch(existing);
    return snap.id;
  }

  updateSave(placeId: string, patch: SavePatch): void {
    const s = this.save(placeId);
    if (patch.comment !== undefined && patch.comment !== s.comment) {
      // Path relative to the save object: ids contain '/', which updateText's path syntax cannot carry.
      A.updateText(s as unknown as A.Doc<unknown>, ['comment'], patch.comment);
    }
    if (patch.commentVisibility !== undefined)
      s.commentVisibility = imm(check(patch.commentVisibility, COMMENT_VIS, 'comment visibility'));
    if (patch.status !== undefined)
      s.status = immOrNull(patch.status === null ? null : check(patch.status, SAVE_STATUSES, 'status'));
    if (patch.priceLevel !== undefined) s.priceLevel = checkPrice(patch.priceLevel);
    if (patch.sharing !== undefined) s.sharing = imm(check(patch.sharing, SHARINGS, 'sharing'));
    if (patch.mainTagId !== undefined) {
      if (patch.mainTagId !== null && !s.tagIds[patch.mainTagId]) s.tagIds[patch.mainTagId] = true;
      s.mainTagId = immOrNull(patch.mainTagId);
    }
    if (
      patch.name !== undefined ||
      patch.geometry !== undefined ||
      patch.edge !== undefined ||
      patch.category !== undefined
    ) {
      const cur = snapshotFromDoc(placeId, s.place);
      if (cur.osmType !== null && (patch.geometry !== undefined || patch.name !== undefined)) {
        throw new Error('the name and geometry of an OSM place come from OSM');
      }
      const next = normalizeSnapshot({
        ...cur,
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.geometry !== undefined && { geometry: patch.geometry }),
        ...(patch.edge !== undefined && { edge: patch.edge }),
        ...(patch.category !== undefined && { category: patch.category }),
      });
      if (next.name !== cur.name) s.place.name = imm(next.name);
      if (patch.geometry !== undefined) s.place.geometry = imm(JSON.stringify(next.geometry));
      if (next.edge !== cur.edge) s.place.edge = imm(next.edge);
      if (next.category !== cur.category) s.place.category = immOrNull(next.category);
    }
    this.touch(s);
  }

  setSaveTags(placeId: string, tagIds: readonly string[], mainTagId?: string | null): void {
    const s = this.save(placeId);
    setKeys(s.tagIds, tagIds);
    const main = mainTagId !== undefined ? mainTagId : strOrNull(s.mainTagId);
    s.mainTagId = immOrNull(main !== null && tagIds.includes(main) ? main : (tagIds[0] ?? null));
    this.touch(s);
  }

  addSaveTag(placeId: string, tagId: string): void {
    const s = this.save(placeId);
    if (!s.tagIds[tagId]) s.tagIds[tagId] = true;
    if (s.mainTagId === null) s.mainTagId = imm(tagId);
    this.touch(s);
  }

  removeSaveTag(placeId: string, tagId: string): void {
    const s = this.save(placeId);
    if (s.tagIds[tagId]) delete s.tagIds[tagId];
    if (strOrNull(s.mainTagId) === tagId) s.mainTagId = immOrNull(Object.keys(s.tagIds).sort()[0] ?? null);
    this.touch(s);
  }

  /** To the trash (restorable for 30 days). */
  deleteSave(placeId: string): void {
    const s = this.save(placeId);
    s.deletedAt = this.ctx.now();
    this.touch(s);
  }

  restoreSave(placeId: string): void {
    const s = this.save(placeId);
    s.deletedAt = null;
    this.touch(s);
  }

  addMedia(placeId: string, m: MediaInput): string {
    const s = this.save(placeId);
    const id = m.id ?? this.ctx.newId();
    s.media[id] = {
      file: imm(m.file),
      blurhash: immOrNull(m.blurhash ?? null),
      width: m.width ?? null,
      height: m.height ?? null,
      createdAt: this.ctx.now(),
    };
    this.touch(s);
    return id;
  }

  removeMedia(placeId: string, mediaId: string): void {
    const s = this.save(placeId);
    if (s.media[mediaId]) delete s.media[mediaId];
    this.touch(s);
  }

  /**
   * Merges my save on a manual place into another place (after the user
   * confirmed a duplicate suggestion, or an OSM match). Tags and photos are
   * united, the comment kept (both, if they differ), lists re-pointed.
   */
  relinkSave(fromPlaceId: string, to: PlaceSnapshotInput | PlaceSnapshot): string {
    const from = this.save(fromPlaceId);
    const target = normalizeSnapshot(to);
    if (target.id === fromPlaceId) return fromPlaceId;
    const fromComment = from.comment;
    const fromTags = Object.keys(from.tagIds);
    const fromMain = strOrNull(from.mainTagId);
    if (!this.d.saves[target.id]) {
      this.putSave({
        place: target,
        comment: fromComment,
        commentVisibility: str(from.commentVisibility) as CommentVisibility,
        status: strOrNull(from.status) as SaveStatus | null,
        priceLevel: (from.priceLevel ?? null) as PriceLevel | null,
        sharing: str(from.sharing) as Sharing,
        tagIds: fromTags,
        mainTagId: fromMain,
      });
      this.d.saves[target.id]!.createdAt = from.createdAt;
    } else {
      const t = this.d.saves[target.id]!;
      if (readDeletedAt(t) !== null) t.deletedAt = null;
      for (const tag of fromTags) if (!t.tagIds[tag]) t.tagIds[tag] = true;
      if (t.mainTagId === null && fromMain) t.mainTagId = imm(fromMain);
      if (fromComment && fromComment !== t.comment) {
        A.updateText(
          t as unknown as A.Doc<unknown>,
          ['comment'],
          t.comment ? `${t.comment}\n\n${fromComment}` : fromComment,
        );
      }
      if (t.status === null && from.status !== null) t.status = imm(str(from.status));
      if (t.priceLevel === null && from.priceLevel !== null) t.priceLevel = from.priceLevel;
      if (str(from.sharing) === 'private') t.sharing = imm('private');
      this.touch(t);
    }
    const dest = this.d.saves[target.id]!;
    for (const [id, m] of Object.entries(from.media)) {
      if (!dest.media[id]) {
        dest.media[id] = {
          file: imm(str(m.file)),
          blurhash: immOrNull(strOrNull(m.blurhash)),
          width: m.width,
          height: m.height,
          createdAt: m.createdAt,
        };
      }
    }
    for (const l of Object.values(this.d.lists)) {
      for (const set of [l.filter.include, l.filter.exclude] as Set_[]) {
        if (set[fromPlaceId]) {
          delete set[fromPlaceId];
          set[target.id] = true;
        }
      }
      if (l.items[fromPlaceId] !== undefined) {
        const at = l.items[fromPlaceId]!;
        delete l.items[fromPlaceId];
        if (l.items[target.id] === undefined) l.items[target.id] = at;
      }
    }
    delete this.d.saves[fromPlaceId];
    this.d.tombstones[`save:${fromPlaceId}`] = this.ctx.now();
    return target.id;
  }

  // ---------------------------------------------------------------- tags

  createTag(input: TagInput): string {
    const id = this.ctx.newId();
    const now = this.ctx.now();
    if (input.parentId && !this.d.tags[input.parentId]) throw new Error(`unknown parent tag ${input.parentId}`);
    this.d.tags[id] = {
      parentId: immOrNull(input.parentId ?? null),
      name: imm(input.name.trim()),
      color: immOrNull(input.color ?? null),
      icon: immOrNull(input.icon ?? null),
      osmCategories: Object.fromEntries((input.osmCategories ?? []).map((c) => [c, true as const])),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    return id;
  }

  updateTag(id: string, patch: Partial<TagInput>): void {
    const t = this.d.tags[id];
    if (!t) throw new Error(`no tag ${id}`);
    if (patch.parentId !== undefined) {
      if (patch.parentId === id) throw new Error('a tag cannot be its own parent');
      // Local cycle check; concurrent re-parenting may still create one, which the projection breaks.
      let cur = patch.parentId;
      while (cur) {
        if (cur === id) throw new Error('this would create a cycle of sub-tags');
        cur = strOrNull(this.d.tags[cur]?.parentId);
      }
      t.parentId = immOrNull(patch.parentId);
    }
    if (patch.name !== undefined) t.name = imm(patch.name.trim());
    if (patch.color !== undefined) t.color = immOrNull(patch.color);
    if (patch.icon !== undefined) t.icon = immOrNull(patch.icon);
    if (patch.osmCategories !== undefined) setKeys(t.osmCategories, patch.osmCategories);
    t.updatedAt = this.ctx.now();
  }

  /** To the trash, with its sub-tags (they become inactive until restored). */
  deleteTag(id: string): void {
    const t = this.d.tags[id];
    if (!t) throw new Error(`no tag ${id}`);
    t.deletedAt = this.ctx.now();
    t.updatedAt = this.ctx.now();
  }

  restoreTag(id: string): void {
    const t = this.d.tags[id];
    if (!t) throw new Error(`no tag ${id}`);
    t.deletedAt = null;
    t.updatedAt = this.ctx.now();
  }

  /** How a friend's tag is shown on my side (null removes the mapping). */
  setTagMapping(personId: string, theirTag: string, myTagId: string | null): void {
    const key = `${personId}\n${theirTag}`;
    if (myTagId === null) {
      if (this.d.tagMappings[key]) delete this.d.tagMappings[key];
    } else {
      this.d.tagMappings[key] = imm(myTagId);
    }
  }

  // ---------------------------------------------------------------- lists

  createList(input: ListInput): string {
    const id = this.ctx.newId();
    const now = this.ctx.now();
    this.d.lists[id] = {
      name: imm(input.name.trim()),
      description: input.description ?? '',
      visibility: imm(check(input.visibility ?? 'link', LIST_VIS, 'list visibility')),
      linkKey: immOrNull(input.linkKey ?? null),
      kind: imm(check(input.kind, ['filter', 'manual'] as const, 'list kind')),
      filter: { tags: {}, categories: {}, statuses: {}, priceLevels: {}, zones: {}, include: {}, exclude: {} },
      items: Object.fromEntries((input.items ?? []).map((p) => [p, now])),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    if (input.filter) this.setListFilter(id, input.filter);
    return id;
  }

  private list(id: string): DocList {
    const l = this.d.lists[id];
    if (!l) throw new Error(`no list ${id}`);
    return l;
  }

  updateList(id: string, patch: { name?: string; description?: string; visibility?: ListVisibility; linkKey?: string | null }): void {
    const l = this.list(id);
    if (patch.name !== undefined) l.name = imm(patch.name.trim());
    if (patch.description !== undefined && patch.description !== l.description) {
      A.updateText(l as unknown as A.Doc<unknown>, ['description'], patch.description);
    }
    if (patch.visibility !== undefined) l.visibility = imm(check(patch.visibility, LIST_VIS, 'list visibility'));
    if (patch.linkKey !== undefined) l.linkKey = immOrNull(patch.linkKey);
    l.updatedAt = this.ctx.now();
  }

  /** Replaces the saved filter, touching only the criteria that changed (merge-friendly). */
  setListFilter(id: string, filter: ListFilter): void {
    const l = this.list(id);
    const f = l.filter;
    setKeys(f.tags, filter.tags ?? []);
    setKeys(f.categories, filter.categories ?? []);
    setKeys(f.statuses, (filter.statuses ?? []).map((s) => check(s, SAVE_STATUSES, 'status')));
    setKeys(f.priceLevels, (filter.priceLevels ?? []).map((p) => String(checkPrice(p))));
    const zones = new Map((filter.zones ?? []).map((z) => [zoneKey(z), z]));
    for (const k of Object.keys(f.zones)) if (!zones.has(k)) delete f.zones[k];
    for (const [k, z] of zones) if (!f.zones[k]) f.zones[k] = imm(canonicalJson(z));
    const exclude = filter.exclude ?? [];
    setKeys(f.exclude, exclude);
    setKeys(f.include, (filter.include ?? []).filter((p) => !exclude.includes(p)));
    l.updatedAt = this.ctx.now();
  }

  /** Exception "add this place by hand" (filter list) or selection (manual list). */
  addToList(id: string, placeId: string): void {
    const l = this.list(id);
    if (str(l.kind) === 'manual') {
      if (l.items[placeId] === undefined) l.items[placeId] = this.ctx.now();
    } else {
      if (l.filter.exclude[placeId]) delete l.filter.exclude[placeId];
      if (!l.filter.include[placeId]) l.filter.include[placeId] = true;
    }
    l.updatedAt = this.ctx.now();
  }

  /** Exception "remove this place by hand" (filter list) or unselect (manual list). */
  removeFromList(id: string, placeId: string): void {
    const l = this.list(id);
    if (str(l.kind) === 'manual') {
      if (l.items[placeId] !== undefined) delete l.items[placeId];
    } else {
      if (l.filter.include[placeId]) delete l.filter.include[placeId];
      if (!l.filter.exclude[placeId]) l.filter.exclude[placeId] = true;
    }
    l.updatedAt = this.ctx.now();
  }

  /** The places remain; only the list goes (to the trash). */
  deleteList(id: string): void {
    const l = this.list(id);
    l.deletedAt = this.ctx.now();
    l.updatedAt = this.ctx.now();
  }

  restoreList(id: string): void {
    const l = this.list(id);
    l.deletedAt = null;
    l.updatedAt = this.ctx.now();
  }

  /**
   * Removes items deleted more than 30 days ago, leaving a tombstone; drops
   * tombstones older than six months. Returns the number of purged items.
   */
  purgeTrash(): number {
    const now = this.ctx.now();
    let n = 0;
    const sweep = (kind: 'save' | 'tag' | 'list', m: Record<string, unknown>) => {
      for (const id of Object.keys(m)) {
        const deletedAt = readDeletedAt(m[id]);
        if (deletedAt !== null && now - deletedAt >= TRASH_RETENTION_MS) {
          delete m[id];
          this.d.tombstones[`${kind}:${id}`] = now;
          n++;
        }
      }
    };
    sweep('save', this.d.saves);
    sweep('tag', this.d.tags);
    sweep('list', this.d.lists);
    for (const [k, t] of Object.entries(this.d.tombstones)) {
      if (now - t >= TOMBSTONE_RETENTION_MS) delete this.d.tombstones[k];
    }
    return n;
  }
}

// ------------------------------------------------------------------ healing

/**
 * Folds hidden concurrent creations of the same save into the visible one.
 * Deterministic (depends only on the document), idempotent, and each hidden
 * version is folded only once (`absorbed`), so a tag the user later removes
 * does not come back. Returns the same document when there is nothing to do.
 */
export function healDoc(doc: A.Doc<DataDoc>): A.Doc<DataDoc> {
  const work: { key: string; losers: [string, DocSave][] }[] = [];
  for (const key of Object.keys(doc.saves)) {
    const conflicts = A.getConflicts(doc.saves as unknown as A.Doc<unknown>, key);
    if (!conflicts || Object.keys(conflicts).length < 2) continue;
    const winner = doc.saves[key]!;
    const winnerId = A.getObjectId(winner);
    const losers = Object.entries(conflicts as unknown as Record<string, DocSave>)
      .filter(([, v]) => v && typeof v === 'object' && A.getObjectId(v) !== winnerId)
      .filter(([op]) => !winner.absorbed?.[op])
      .sort(([a], [b]) => (a < b ? -1 : 1));
    if (losers.length) work.push({ key, losers });
  }
  if (work.length === 0) return doc;
  return A.change(doc, { message: 'heal' }, (d) => {
    for (const { key, losers } of work) {
      const w = d.saves[key]!;
      if (!w.absorbed) w.absorbed = {};
      for (const [op, l] of losers) {
        for (const t of Object.keys(l.tagIds ?? {}).sort()) if (!w.tagIds[t]) w.tagIds[t] = true;
        for (const [id, m] of Object.entries(l.media ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
          if (!w.media[id]) {
            w.media[id] = {
              file: imm(str(m.file)),
              blurhash: immOrNull(strOrNull(m.blurhash)),
              width: m.width ?? null,
              height: m.height ?? null,
              createdAt: m.createdAt,
            };
          }
        }
        if (w.comment === '' && l.comment) w.comment = String(l.comment);
        if (w.status === null && l.status != null) w.status = imm(str(l.status));
        if (w.priceLevel === null && l.priceLevel != null) w.priceLevel = l.priceLevel;
        if (w.mainTagId === null && l.mainTagId != null) w.mainTagId = imm(str(l.mainTagId));
        // Privacy wins: if either device made it private, it stays private.
        if (readSharing(l) === 'private' && readSharing(w) !== 'private') w.sharing = imm('private');
        if (l.createdAt < w.createdAt) w.createdAt = l.createdAt;
        if (l.updatedAt > w.updatedAt) w.updatedAt = l.updatedAt;
        const ld = readDeletedAt(l);
        if (ld !== null && readDeletedAt(w) === null) w.deletedAt = ld;
        w.absorbed[op] = true;
      }
    }
  });
}

/** Merge a remote replica into a local one, then heal. */
export function mergeDataDocs(local: A.Doc<DataDoc>, remote: A.Doc<DataDoc>): A.Doc<DataDoc> {
  return healDoc(A.merge(local, remote));
}

export type { AreaGeometry };
