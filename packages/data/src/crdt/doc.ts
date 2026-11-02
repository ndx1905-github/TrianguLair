// SPDX-License-Identifier: MPL-2.0
/**
 * The Yjs document holding the user's own data: saves (places and zones),
 * tags, lists, tag mappings. It is the source of truth; SQLite is a projection
 * of it (see project.ts). Every device of the user holds a replica; replicas
 * merge without conflicts (CRDT) and converge.
 *
 * Yjs is pure JavaScript (no WebAssembly), so the same code runs in Node and
 * in React Native's Hermes engine.
 *
 * Layout (root types are named, so every replica shares them by construction):
 *
 *   meta        Y.Map   schema (major version), written once by a fixed base update
 *   saves       Y.Map   `${placeId}\n${creating client}` → save entry (Y.Map)
 *   tags        Y.Map   tag id → tag (Y.Map)
 *   lists       Y.Map   list id → list (Y.Map)
 *   tagMappings Y.Map   `${personId}\n${theirTag}` → my tag id
 *   tombstones  Y.Map   `save:<placeId>` | `tag:<id>` | `list:<id>` → purge time
 *
 * A save entry is one flat Y.Map (the bulk of the document, so kept small):
 * `place` (snapshot: name, category, kind, edge, geometry, a point as
 * `[lon, lat]`; the OSM identity is the place id), `comment` (Y.Text),
 * `commentVisibility`, `status`, `priceLevel`, `mainTagId`, `createdAt`,
 * `updatedAt`, and keyed elements: `t:<tagId>` (tag set), `m:<mediaId>`
 * (photo metadata), `s:<client>` (sharing register), `d:<client>` (deletion
 * register), `a:<entryKey>` (entries folded in). Absent means the default
 * (friends, no status, updated = created…). Tags and lists keep
 * `d:<client>` too, and nested Y.Maps for their sets.
 *
 * Merge rules and how they map onto Yjs:
 *
 * - Shared genesis. Root types are identified by name, never created by a
 *   write, so two devices that never met cannot hide each other's maps. The
 *   only initial write (`meta.schema`) comes from one fixed base update
 *   (client 0, clock 0) applied by every replica: identical ids, so it is
 *   deduplicated instead of conflicting.
 * - One save per place. In Yjs, two concurrent `set` of the same key keep one
 *   value and garbage-collect the other, nested contents included. So a save
 *   entry is keyed by place id *and* creating client: two devices saving the
 *   same place offline create two entries, both visible after the merge.
 *   `healDoc` (run after every merge) folds every entry into the canonical
 *   one (smallest key) once, deterministically, and records it (`a:<key>`),
 *   so a tag removed afterwards does not come back. Entries are never
 *   deleted by healing: a fold may be redone into a later canonical entry
 *   (three devices), and deleting would lose what was folded into it.
 * - Sets (tags of a save, filter criteria, exceptions, manual items) are
 *   keys of their own, so concurrent additions and removals of different
 *   keys all survive.
 * - Comments and list descriptions are Y.Text (character-level merges).
 *   Other fields are plain values (last writer wins, ties broken by client).
 * - Deletion wins and privacy wins need Automerge's "all concurrent values
 *   stay visible" semantics, which Yjs's last-writer-wins map does not have.
 *   They are observed-remove multi-value registers made of per-device slots
 *   (`d:<client>`, `s:<client>`). A device writes its own slot (always a new
 *   item) and deletes the slots it has seen; a concurrent write by another
 *   device is a slot or an item that delete did not see, so it survives.
 *   Reads apply the rule: deleted if any slot holds a date (a restore clears
 *   the slots it saw), private if any slot says "private".
 * - Trash: `purgeTrash` removes items 30 days after the deletion and leaves a
 *   tombstone, itself dropped after six months.
 * - Unknown fields (spec "Format versions"): edits only touch the keys they
 *   know, so keys, items and root types written by a newer version are kept
 *   as is and re-exported; folding and relinking copy them too.
 */
import * as Y from 'yjs';
import { canonicalJson } from '../filter.ts';
import { parseOsmPlaceId, randomId, type IdGenerator } from '../ids.ts';
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

/** A replica of my data: a Yjs document with the layout above. */
export type DataDoc = Y.Doc;
export type YMap = Y.Map<unknown>;

export const DOC_SCHEMA = 1;
export const TRASH_RETENTION_MS = 30 * 24 * 3600 * 1000;
export const TOMBSTONE_RETENTION_MS = 183 * 24 * 3600 * 1000;

/** Yjs client of the base update; never used by a device. */
const BASE_CLIENT = 0;
const SEP = '\n';

/** Scalar keys and element prefixes of a save entry that this version knows (others are preserved and copied). */
const SAVE_KEYS = new Set(['place', 'comment', 'commentVisibility', 'status', 'priceLevel', 'mainTagId', 'createdAt', 'updatedAt']);
const TAG = 't:';
const MEDIA = 'm:';
const SHARING = 's:';
const DELETED = 'd:';
const ABSORBED = 'a:';
const SAVE_PREFIXES = [TAG, MEDIA, SHARING, DELETED, ABSORBED];
const isKnownSaveKey = (k: string) => SAVE_KEYS.has(k) || SAVE_PREFIXES.some((p) => k.startsWith(p));

let baseUpdate: Uint8Array | null = null;
/** The base update every replica starts from (deterministic bytes). */
export function baseDocUpdate(): Uint8Array {
  if (!baseUpdate) {
    const d = new Y.Doc({ gc: true });
    d.clientID = BASE_CLIENT;
    d.getMap('meta').set('schema', DOC_SCHEMA);
    baseUpdate = Y.encodeStateAsUpdate(d);
    d.destroy();
  }
  return baseUpdate;
}

/**
 * Yjs client id for a device actor (any stable string, hashed to 32 bits).
 * A Yjs client id must never be used by two replicas at once; DataStore only
 * reuses it after loading every update it wrote (stored atomically).
 */
export function clientIdFor(actor: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < actor.length; i++) {
    h ^= actor.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h === BASE_CLIENT ? 1 : h;
}

function setClient(doc: Y.Doc, actor: string | undefined): void {
  if (actor !== undefined) doc.clientID = clientIdFor(actor);
  else if (doc.clientID === BASE_CLIENT) doc.clientID = 1 + Math.floor(Math.random() * 0xfffffffe);
}

/** A new empty replica. `actor`: stable per device (random Yjs client by default). */
export function createDataDoc(actor?: string): DataDoc {
  const doc = new Y.Doc({ gc: true });
  Y.applyUpdate(doc, baseDocUpdate());
  setClient(doc, actor);
  return doc;
}

/**
 * Loads a replica from Yjs updates (a snapshot and/or incremental updates, in
 * any order). The client id is set after loading, so reusing this device's
 * own id does not look like another client using it.
 */
export function loadDataDoc(updates: Uint8Array | readonly Uint8Array[], actor?: string): DataDoc {
  const doc = new Y.Doc({ gc: true });
  const list = updates instanceof Uint8Array ? [updates] : updates;
  doc.transact(() => {
    for (const u of list) Y.applyUpdate(doc, u);
  });
  const schema = doc.getMap('meta').get('schema');
  if (schema !== DOC_SCHEMA) throw new Error(`unsupported data document schema ${String(schema)}`);
  setClient(doc, actor);
  return doc;
}

export function roots(doc: DataDoc): {
  meta: YMap;
  saves: Y.Map<YMap>;
  tags: Y.Map<YMap>;
  lists: Y.Map<YMap>;
  tagMappings: Y.Map<string>;
  tombstones: Y.Map<number>;
} {
  return {
    meta: doc.getMap<unknown>('meta'),
    saves: doc.getMap<YMap>('saves'),
    tags: doc.getMap<YMap>('tags'),
    lists: doc.getMap<YMap>('lists'),
    tagMappings: doc.getMap<string>('tagMappings'),
    tombstones: doc.getMap<number>('tombstones'),
  };
}

/** This replica's key in multi-value registers and save entry keys. */
function me(doc: DataDoc): string {
  return doc.clientID.toString(36);
}

// ------------------------------------------------------------------ save entries index

/** place id → entry keys, kept up to date by an observer (and directly by edits in a transaction). */
const indexes = new WeakMap<DataDoc, Map<string, Set<string>>>();

export function placeOfEntry(key: string): string {
  const i = key.indexOf(SEP);
  return i < 0 ? key : key.slice(0, i);
}

function indexAdd(idx: Map<string, Set<string>>, key: string): void {
  const p = placeOfEntry(key);
  let s = idx.get(p);
  if (!s) idx.set(p, (s = new Set()));
  s.add(key);
}
function indexRemove(idx: Map<string, Set<string>>, key: string): void {
  const p = placeOfEntry(key);
  const s = idx.get(p);
  if (!s) return;
  s.delete(key);
  if (s.size === 0) idx.delete(p);
}

function saveIndex(doc: DataDoc): Map<string, Set<string>> {
  let idx = indexes.get(doc);
  if (!idx) {
    const built = new Map<string, Set<string>>();
    const saves = roots(doc).saves;
    for (const k of saves.keys()) indexAdd(built, k);
    saves.observe((ev) => {
      for (const k of ev.keysChanged) {
        if (saves.has(k)) indexAdd(built, k);
        else indexRemove(built, k);
      }
    });
    indexes.set(doc, built);
    idx = built;
  }
  return idx;
}

/** Entry keys of a place, canonical first. */
export function saveEntryKeys(doc: DataDoc, placeId: string): string[] {
  return [...(saveIndex(doc).get(placeId) ?? [])].sort();
}

/** The canonical entry of my save on a place (the one edits go to), or null. */
export function saveEntry(doc: DataDoc, placeId: string): YMap | null {
  const key = saveEntryKeys(doc, placeId)[0];
  return key === undefined ? null : (roots(doc).saves.get(key) ?? null);
}

/** Place ids of my saves (trash included), sorted. */
export function savePlaceIds(doc: DataDoc): string[] {
  return [...saveIndex(doc).keys()].sort();
}
export function hasSave(doc: DataDoc, placeId: string): boolean {
  return saveIndex(doc).has(placeId);
}
export function tagIdsOf(doc: DataDoc): string[] {
  return [...roots(doc).tags.keys()].sort();
}
export function listIdsOf(doc: DataDoc): string[] {
  return [...roots(doc).lists.keys()].sort();
}
export function readTombstones(doc: DataDoc): Record<string, number> {
  return Object.fromEntries([...roots(doc).tombstones.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ------------------------------------------------------------------ reading helpers

export function getStr(m: YMap, k: string): string {
  const v = m.get(k);
  return v == null ? '' : String(v);
}
export function getStrOrNull(m: YMap, k: string): string | null {
  const v = m.get(k);
  return v == null ? null : String(v);
}
export function getNum(m: YMap, k: string): number | null {
  const v = m.get(k);
  return typeof v === 'number' ? v : null;
}
export function getMap(m: YMap, k: string): YMap | null {
  const v = m.get(k);
  return v instanceof Y.Map ? (v as YMap) : null;
}
export function getText(m: YMap, k: string): string {
  const v = m.get(k);
  return v instanceof Y.Text ? v.toString() : v == null ? '' : String(v);
}

/**
 * A keyed collection inside a Y.Map: the keys starting with `prefix` (a set
 * or register flattened into an item), or a whole nested map (prefix '').
 */
export class Slots {
  constructor(
    readonly map: YMap,
    readonly prefix = '',
  ) {}
  keys(): string[] {
    const out: string[] = [];
    const n = this.prefix.length;
    for (const k of this.map.keys()) if (k.startsWith(this.prefix)) out.push(k.slice(n));
    return out.sort();
  }
  entries(): [string, unknown][] {
    return this.keys().map((k) => [k, this.map.get(this.prefix + k)]);
  }
  has(k: string): boolean {
    return this.map.has(this.prefix + k);
  }
  get(k: string): unknown {
    return this.map.get(this.prefix + k);
  }
  set(k: string, v: unknown): void {
    this.map.set(this.prefix + k, v);
  }
  delete(k: string): void {
    this.map.delete(this.prefix + k);
  }
}

const NO_SLOTS = new Slots(new Y.Map<unknown>());
function nested(m: YMap, k: string): Slots {
  const v = getMap(m, k);
  return v ? new Slots(v) : NO_SLOTS;
}
export function keysOf(m: YMap | null): string[] {
  return m ? new Slots(m).keys() : [];
}

/** Tag ids of a save entry (unordered set, sorted). */
export function saveTagIds(e: YMap): string[] {
  return new Slots(e, TAG).keys();
}
export function saveMedia(e: YMap): [string, Partial<DocMedia>][] {
  return new Slots(e, MEDIA).entries() as [string, Partial<DocMedia>][];
}

/** Delete-wins read on a save, tag or list: the latest deletion in any slot, or null when no slot is set. */
export function readDeletedAt(item: YMap | null | undefined): number | null {
  if (!item) return null;
  let out: number | null = null;
  for (const [, v] of new Slots(item, DELETED).entries()) if (typeof v === 'number' && (out === null || v > out)) out = v;
  return out;
}

/**
 * Privacy-wins read of `sharing`: if two devices set it concurrently and one
 * of them chose "private", the save is private until someone sets it again
 * (a private place must never leak to friends or into a list by a merge).
 * No slot means the default, "friends".
 */
export function readSharing(save: YMap): Sharing {
  for (const [, v] of new Slots(save, SHARING).entries()) if (v === 'private') return 'private';
  return 'friends';
}

interface DocPlace {
  name?: string;
  category?: string | null;
  kind?: PlaceKind;
  edge?: ZoneEdge;
  /** A point as `[lon, lat]`; any other geometry as GeoJSON text. */
  geometry?: string | [number, number];
  [unknown: string]: unknown;
}

const defaultKind = (g: { type: string }): PlaceKind => (g.type === 'Point' ? 'place' : 'zone');

export function snapshotFromEntry(placeId: string, e: YMap): PlaceSnapshot {
  const p = (e.get('place') ?? {}) as DocPlace;
  const osm = parseOsmPlaceId(placeId);
  const g = p.geometry;
  const geometry: PlaceGeometry = Array.isArray(g)
    ? { type: 'Point', coordinates: [g[0], g[1]] }
    : (JSON.parse(g ?? 'null') as PlaceGeometry);
  return {
    id: placeId,
    osmType: osm?.osmType ?? null,
    osmId: osm?.osmId ?? null,
    name: String(p.name ?? ''),
    category: p.category ?? null,
    kind: p.kind ?? defaultKind(geometry),
    edge: p.edge ?? 'sharp',
    geometry,
  };
}

/** The stored place object: defaults and the OSM identity (in the place id) left out; unknown fields kept. */
function docPlace(s: PlaceSnapshot, prev: DocPlace = {}): DocPlace {
  const g = s.geometry;
  const geometry: DocPlace['geometry'] =
    g.type === 'Point' && g.coordinates.length === 2 ? [g.coordinates[0]!, g.coordinates[1]!] : JSON.stringify(g);
  const out: DocPlace = { ...prev, name: s.name, geometry };
  if (s.category !== null) out.category = s.category;
  else delete out.category;
  if (s.kind !== defaultKind(s.geometry)) out.kind = s.kind;
  else delete out.kind;
  if (s.edge !== 'sharp') out.edge = s.edge;
  else delete out.edge;
  return out;
}

function zoneKey(z: FilterZone): string {
  return z.kind === 'osm' ? `osm:${z.osmType}/${z.osmId}` : `drawn:${canonicalJson(z.geometry)}`;
}

export function filterFromDoc(f: YMap | null): ListFilter {
  const out: ListFilter = {};
  if (!f) return out;
  const keys = (k: string) => keysOf(getMap(f, k));
  const set = <K extends keyof ListFilter>(k: K, v: ListFilter[K] & unknown[]) => {
    if (v.length) out[k] = v;
  };
  set('tags', keys('tags'));
  set('categories', keys('categories'));
  set('statuses', keys('statuses') as SaveStatus[]);
  set('priceLevels', keys('priceLevels').map(Number) as PriceLevel[]);
  set('zones', nested(f, 'zones').entries().map(([, v]) => JSON.parse(String(v)) as FilterZone));
  set('include', keys('include'));
  set('exclude', keys('exclude'));
  return out;
}

// ------------------------------------------------------------------ writing helpers

/** Observed-remove multi-value register: my slot takes the value, the slots I have seen go. */
function mvSet(reg: Slots, mine: string, v: unknown): void {
  for (const k of reg.keys()) if (k !== mine) reg.delete(k);
  reg.set(mine, v); // always a new item, so a concurrent removal of my old slot does not erase it
}
function mvClear(reg: Slots): void {
  for (const k of reg.keys()) reg.delete(k);
}

function setKeys(m: Slots, wanted: readonly string[], value: unknown = true): void {
  const want = new Set(wanted);
  for (const k of m.keys()) if (!want.has(k)) m.delete(k);
  for (const k of want) if (!m.has(k)) m.set(k, value);
}

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Minimal edit (common prefix and suffix kept) so concurrent edits merge per character. */
export function updateText(t: Y.Text, next: string): void {
  const cur = t.toString();
  if (cur === next) return;
  const max = Math.min(cur.length, next.length);
  let p = 0;
  while (p < max && cur.charCodeAt(p) === next.charCodeAt(p)) p++;
  if (p > 0 && isHigh(cur.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && cur.charCodeAt(cur.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  if (s > 0 && isLow(cur.charCodeAt(cur.length - s))) s--;
  const del = cur.length - p - s;
  if (del > 0) t.delete(p, del);
  const ins = next.slice(p, next.length - s);
  if (ins) t.insert(p, ins);
}

function textOf(m: YMap, k: string): Y.Text {
  const v = m.get(k);
  if (v instanceof Y.Text) return v;
  const t = new Y.Text(v == null ? '' : String(v));
  m.set(k, t);
  return t;
}

function filterOf(l: YMap): YMap {
  const v = getMap(l, 'filter');
  if (v) return v;
  const f = new Y.Map<unknown>();
  l.set('filter', f);
  return f;
}

/** A nested set map, created if missing (only on items created by older code or other versions). */
function nestedOf(m: YMap, k: string): Slots {
  const v = m.get(k);
  if (v instanceof Y.Map) return new Slots(v as YMap);
  const r = new Y.Map<unknown>();
  m.set(k, r);
  return new Slots(r);
}

/** Deep copy of a value for another place in the document (Yjs types cannot be moved). */
function cloneValue(v: unknown): unknown {
  if (v instanceof Y.Text) return new Y.Text(v.toString());
  if (v instanceof Y.Map) {
    const m = new Y.Map<unknown>();
    for (const [k, x] of (v as YMap).entries()) m.set(k, cloneValue(x));
    return m;
  }
  if (v instanceof Y.Array) {
    const a = new Y.Array<unknown>();
    a.push((v as Y.Array<unknown>).toArray().map(cloneValue));
    return a;
  }
  if (v instanceof Y.AbstractType) return null; // other shared types (XML…) are not carried over
  return v;
}

function copyUnknown(from: YMap, to: YMap): void {
  for (const [k, v] of from.entries()) if (!isKnownSaveKey(k) && !to.has(k)) to.set(k, cloneValue(v));
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
  /**
   * Creation date (ms) of a new save, for imports that carry the original
   * date (Google Takeout, a TrianguLair export). Default: now. Ignored when
   * the save already exists.
   */
  createdAt?: number;
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

/** Editable fields of a list (filter and items have their own edits). */
export interface ListPatch {
  name?: string;
  description?: string;
  visibility?: ListVisibility;
  linkKey?: string | null;
  kind?: ListKind;
}

export interface MediaInput {
  id?: string;
  file: string;
  blurhash?: string | null;
  width?: number | null;
  height?: number | null;
}

/** Media metadata as stored (one atomic JSON value per photo). */
export interface DocMedia {
  file: string;
  blurhash: string | null;
  width: number | null;
  height: number | null;
  createdAt: number;
}

const COMMENT_VIS: readonly CommentVisibility[] = ['private', 'friends', 'public'];
const SAVE_STATUSES: readonly SaveStatus[] = ['to_try', 'tried', 'favorite'];
const SHARINGS: readonly Sharing[] = ['private', 'friends'];
const LIST_VIS: readonly ListVisibility[] = ['link', 'public'];
const FILTER_GROUPS = ['tags', 'categories', 'statuses', 'priceLevels', 'zones', 'include', 'exclude'] as const;

function check<T>(v: T, allowed: readonly T[], what: string): T {
  if (!allowed.includes(v)) throw new TypeError(`invalid ${what}: ${String(v)}`);
  return v;
}
function checkPrice(p: PriceLevel | null): PriceLevel | null {
  if (p !== null && ![1, 2, 3, 4].includes(p)) throw new TypeError(`invalid price level: ${String(p)}`);
  return p;
}

/**
 * All edits of the user's own data, applied to a Yjs document. Use through
 * `DataStore.change(tx => …)`, or `doc.transact(() => new DocTx(doc, ctx)…)`
 * to group operations into one Yjs transaction (one update).
 *
 * Each method validates its input before writing, so a refused edit writes
 * nothing; DataStore additionally discards a replica left half-edited by an
 * exception (Yjs has no rollback).
 */
export class DocTx {
  private readonly r: ReturnType<typeof roots>;

  constructor(
    private readonly doc: DataDoc,
    private readonly ctx: EditContext = defaultEditContext,
  ) {
    this.r = roots(doc);
  }

  private get me(): string {
    return me(this.doc);
  }

  private save(placeId: string): YMap {
    const s = saveEntry(this.doc, placeId);
    if (!s) throw new Error(`no save for place ${placeId}`);
    return s;
  }

  private touch(m: YMap): void {
    m.set('updatedAt', this.ctx.now());
  }

  private newEntry(placeId: string): YMap {
    const key = `${placeId}${SEP}${this.me}`;
    const e = new Y.Map<unknown>();
    this.r.saves.set(key, e);
    indexAdd(saveIndex(this.doc), key);
    return e;
  }

  private dropEntries(placeId: string): void {
    const idx = saveIndex(this.doc);
    for (const key of saveEntryKeys(this.doc, placeId)) {
      this.r.saves.delete(key);
      indexRemove(idx, key);
    }
  }

  /**
   * "Add to my places". Creates my save on this place, or updates it (and
   * takes it out of the trash) when it already exists. Returns the place id.
   */
  putSave(input: SaveInput): string {
    const snap = normalizeSnapshot(input.place);
    const now = this.ctx.now();
    const existing = saveEntry(this.doc, snap.id);
    if (!existing) {
      const commentVisibility = check(input.commentVisibility ?? 'friends', COMMENT_VIS, 'comment visibility');
      const status = input.status == null ? null : check(input.status, SAVE_STATUSES, 'status');
      const priceLevel = checkPrice(input.priceLevel ?? null);
      const sharing = check(input.sharing ?? 'friends', SHARINGS, 'sharing');
      const tags = [...new Set(input.tagIds ?? [])];
      const main = input.mainTagId ?? tags[0] ?? null;
      if (main !== null && !tags.includes(main)) tags.push(main);
      const e = this.newEntry(snap.id);
      e.set('place', docPlace(snap));
      e.set('comment', new Y.Text(input.comment ?? ''));
      if (commentVisibility !== 'friends') e.set('commentVisibility', commentVisibility);
      if (status !== null) e.set('status', status);
      if (priceLevel !== null) e.set('priceLevel', priceLevel);
      if (sharing !== 'friends') e.set(SHARING + this.me, sharing);
      if (main !== null) e.set('mainTagId', main);
      for (const id of tags) e.set(TAG + id, true);
      const createdAt = input.createdAt;
      e.set('createdAt', createdAt !== undefined && Number.isFinite(createdAt) && createdAt > 0 ? Math.round(createdAt) : now);
      return snap.id;
    }
    this.updateSave(snap.id, {
      ...(input.comment !== undefined && { comment: input.comment }),
      ...(input.commentVisibility !== undefined && { commentVisibility: input.commentVisibility }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.priceLevel !== undefined && { priceLevel: input.priceLevel }),
      ...(input.sharing !== undefined && { sharing: input.sharing }),
      ...(input.mainTagId !== undefined && { mainTagId: input.mainTagId }),
    });
    if (input.tagIds) this.setSaveTags(snap.id, input.tagIds, input.mainTagId);
    if (readDeletedAt(existing) !== null) mvClear(new Slots(existing, DELETED));
    this.touch(existing);
    return snap.id;
  }

  updateSave(placeId: string, patch: SavePatch): void {
    const s = this.save(placeId);
    // Validate everything first: a refused edit writes nothing.
    const commentVisibility =
      patch.commentVisibility === undefined ? undefined : check(patch.commentVisibility, COMMENT_VIS, 'comment visibility');
    const status =
      patch.status === undefined ? undefined : patch.status === null ? null : check(patch.status, SAVE_STATUSES, 'status');
    const priceLevel = patch.priceLevel === undefined ? undefined : checkPrice(patch.priceLevel);
    const sharing = patch.sharing === undefined ? undefined : check(patch.sharing, SHARINGS, 'sharing');
    let place: PlaceSnapshot | null = null;
    if (patch.name !== undefined || patch.geometry !== undefined || patch.edge !== undefined || patch.category !== undefined) {
      const cur = snapshotFromEntry(placeId, s);
      if (cur.osmType !== null && (patch.geometry !== undefined || patch.name !== undefined)) {
        throw new Error('the name and geometry of an OSM place come from OSM');
      }
      place = normalizeSnapshot({
        ...cur,
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.geometry !== undefined && { geometry: patch.geometry }),
        ...(patch.edge !== undefined && { edge: patch.edge }),
        ...(patch.category !== undefined && { category: patch.category }),
      });
    }

    if (patch.comment !== undefined) updateText(textOf(s, 'comment'), patch.comment);
    if (commentVisibility !== undefined) s.set('commentVisibility', commentVisibility);
    if (status !== undefined) s.set('status', status);
    if (priceLevel !== undefined) s.set('priceLevel', priceLevel);
    if (sharing !== undefined) mvSet(new Slots(s, SHARING), this.me, sharing);
    if (patch.mainTagId !== undefined) {
      if (patch.mainTagId !== null && !s.has(TAG + patch.mainTagId)) s.set(TAG + patch.mainTagId, true);
      s.set('mainTagId', patch.mainTagId);
    }
    if (place) s.set('place', docPlace(place, (s.get('place') ?? {}) as DocPlace));
    this.touch(s);
  }

  setSaveTags(placeId: string, tagIds: readonly string[], mainTagId?: string | null): void {
    const s = this.save(placeId);
    setKeys(new Slots(s, TAG), tagIds);
    const main = mainTagId !== undefined ? mainTagId : getStrOrNull(s, 'mainTagId');
    const next = main !== null && tagIds.includes(main) ? main : (tagIds[0] ?? null);
    if (getStrOrNull(s, 'mainTagId') !== next) s.set('mainTagId', next);
    this.touch(s);
  }

  addSaveTag(placeId: string, tagId: string): void {
    const s = this.save(placeId);
    if (!s.has(TAG + tagId)) s.set(TAG + tagId, true);
    if (getStrOrNull(s, 'mainTagId') === null) s.set('mainTagId', tagId);
    this.touch(s);
  }

  removeSaveTag(placeId: string, tagId: string): void {
    const s = this.save(placeId);
    if (s.has(TAG + tagId)) s.delete(TAG + tagId);
    if (getStrOrNull(s, 'mainTagId') === tagId) s.set('mainTagId', saveTagIds(s)[0] ?? null);
    this.touch(s);
  }

  /** To the trash (restorable for 30 days). */
  deleteSave(placeId: string): void {
    const s = this.save(placeId);
    mvSet(new Slots(s, DELETED), this.me, this.ctx.now());
    this.touch(s);
  }

  restoreSave(placeId: string): void {
    const s = this.save(placeId);
    mvClear(new Slots(s, DELETED));
    this.touch(s);
  }

  addMedia(placeId: string, m: MediaInput): string {
    const s = this.save(placeId);
    const id = m.id ?? this.ctx.newId();
    const media: DocMedia = {
      file: m.file,
      blurhash: m.blurhash ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
      createdAt: this.ctx.now(),
    };
    s.set(MEDIA + id, media);
    this.touch(s);
    return id;
  }

  removeMedia(placeId: string, mediaId: string): void {
    const s = this.save(placeId);
    if (s.has(MEDIA + mediaId)) s.delete(MEDIA + mediaId);
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
    const fromComment = getText(from, 'comment');
    const fromTags = saveTagIds(from);
    const fromMain = getStrOrNull(from, 'mainTagId');
    const fromStatus = getStrOrNull(from, 'status') as SaveStatus | null;
    const fromPrice = getNum(from, 'priceLevel') as PriceLevel | null;
    let dest = saveEntry(this.doc, target.id);
    if (!dest) {
      this.putSave({
        place: target,
        comment: fromComment,
        commentVisibility: (getStrOrNull(from, 'commentVisibility') ?? 'friends') as CommentVisibility,
        status: fromStatus,
        priceLevel: fromPrice,
        sharing: readSharing(from),
        tagIds: fromTags,
        mainTagId: fromMain,
      });
      dest = saveEntry(this.doc, target.id)!;
      dest.set('createdAt', getNum(from, 'createdAt') ?? this.ctx.now());
      this.touch(dest);
    } else {
      const t = dest;
      if (readDeletedAt(t) !== null) mvClear(new Slots(t, DELETED));
      for (const tag of fromTags) if (!t.has(TAG + tag)) t.set(TAG + tag, true);
      if (getStrOrNull(t, 'mainTagId') === null && fromMain) t.set('mainTagId', fromMain);
      const cur = getText(t, 'comment');
      if (fromComment && fromComment !== cur) updateText(textOf(t, 'comment'), cur ? `${cur}\n\n${fromComment}` : fromComment);
      if (getStrOrNull(t, 'status') === null && fromStatus !== null) t.set('status', fromStatus);
      if (getNum(t, 'priceLevel') === null && fromPrice !== null) t.set('priceLevel', fromPrice);
      if (readSharing(from) === 'private') mvSet(new Slots(t, SHARING), this.me, 'private');
      this.touch(t);
    }
    for (const [id, m] of saveMedia(from)) if (!dest.has(MEDIA + id)) dest.set(MEDIA + id, m);
    copyUnknown(from, dest);
    for (const l of this.r.lists.values()) {
      const f = getMap(l, 'filter');
      for (const set of f ? [nested(f, 'include'), nested(f, 'exclude')] : []) {
        if (set.has(fromPlaceId)) {
          set.delete(fromPlaceId);
          set.set(target.id, true);
        }
      }
      const items = nested(l, 'items');
      if (items.has(fromPlaceId)) {
        const at = items.get(fromPlaceId);
        items.delete(fromPlaceId);
        if (!items.has(target.id)) items.set(target.id, at);
      }
    }
    this.dropEntries(fromPlaceId);
    this.r.tombstones.set(`save:${fromPlaceId}`, this.ctx.now());
    return target.id;
  }

  // ---------------------------------------------------------------- tags

  createTag(input: TagInput): string {
    if (input.parentId && !this.r.tags.has(input.parentId)) throw new Error(`unknown parent tag ${input.parentId}`);
    const id = this.ctx.newId();
    const now = this.ctx.now();
    const t = new Y.Map<unknown>();
    this.r.tags.set(id, t);
    if (input.parentId) t.set('parentId', input.parentId);
    t.set('name', input.name.trim());
    if (input.color != null) t.set('color', input.color);
    if (input.icon != null) t.set('icon', input.icon);
    const cats = new Y.Map<unknown>();
    t.set('osmCategories', cats);
    for (const c of input.osmCategories ?? []) cats.set(c, true);
    t.set('createdAt', now);
    t.set('updatedAt', now);
    return id;
  }

  private tag(id: string): YMap {
    const t = this.r.tags.get(id);
    if (!t) throw new Error(`no tag ${id}`);
    return t;
  }

  updateTag(id: string, patch: Partial<TagInput>): void {
    const t = this.tag(id);
    if (patch.parentId !== undefined) {
      if (patch.parentId === id) throw new Error('a tag cannot be its own parent');
      // Local cycle check; concurrent re-parenting may still create one, which the projection breaks.
      let cur: string | null = patch.parentId;
      while (cur) {
        if (cur === id) throw new Error('this would create a cycle of sub-tags');
        const p = this.r.tags.get(cur);
        cur = p ? getStrOrNull(p, 'parentId') : null;
      }
      t.set('parentId', patch.parentId);
    }
    if (patch.name !== undefined) t.set('name', patch.name.trim());
    if (patch.color !== undefined) t.set('color', patch.color);
    if (patch.icon !== undefined) t.set('icon', patch.icon);
    if (patch.osmCategories !== undefined) setKeys(nestedOf(t, 'osmCategories'), patch.osmCategories);
    this.touch(t);
  }

  /** To the trash, with its sub-tags (they become inactive until restored). */
  deleteTag(id: string): void {
    const t = this.tag(id);
    mvSet(new Slots(t, DELETED), this.me, this.ctx.now());
    this.touch(t);
  }

  restoreTag(id: string): void {
    const t = this.tag(id);
    mvClear(new Slots(t, DELETED));
    this.touch(t);
  }

  /** How a friend's tag is shown on my side (null removes the mapping). */
  setTagMapping(personId: string, theirTag: string, myTagId: string | null): void {
    const key = `${personId}${SEP}${theirTag}`;
    if (myTagId === null) {
      if (this.r.tagMappings.has(key)) this.r.tagMappings.delete(key);
    } else {
      this.r.tagMappings.set(key, myTagId);
    }
  }

  // ---------------------------------------------------------------- lists

  createList(input: ListInput): string {
    const visibility = check(input.visibility ?? 'link', LIST_VIS, 'list visibility');
    const kind = check(input.kind, ['filter', 'manual'] as const, 'list kind');
    const id = this.ctx.newId();
    const now = this.ctx.now();
    const l = new Y.Map<unknown>();
    this.r.lists.set(id, l);
    l.set('name', input.name.trim());
    l.set('description', new Y.Text(input.description ?? ''));
    l.set('visibility', visibility);
    if (input.linkKey != null) l.set('linkKey', input.linkKey);
    l.set('kind', kind);
    const f = new Y.Map<unknown>();
    l.set('filter', f);
    for (const g of FILTER_GROUPS) f.set(g, new Y.Map());
    const items = new Y.Map<unknown>();
    l.set('items', items);
    for (const p of input.items ?? []) items.set(p, now);
    l.set('createdAt', now);
    l.set('updatedAt', now);
    if (input.filter) this.setListFilter(id, input.filter);
    return id;
  }

  private list(id: string): YMap {
    const l = this.r.lists.get(id);
    if (!l) throw new Error(`no list ${id}`);
    return l;
  }

  /**
   * Edits a list. Changing `kind` keeps both the saved filter and the manual
   * selection, so switching back restores the previous definition.
   */
  updateList(id: string, patch: ListPatch): void {
    const l = this.list(id);
    const visibility = patch.visibility === undefined ? undefined : check(patch.visibility, LIST_VIS, 'list visibility');
    const kind = patch.kind === undefined ? undefined : check(patch.kind, ['filter', 'manual'] as const, 'list kind');
    if (patch.name !== undefined) l.set('name', patch.name.trim());
    if (kind !== undefined && getStr(l, 'kind') !== kind) l.set('kind', kind);
    if (patch.description !== undefined) updateText(textOf(l, 'description'), patch.description);
    if (visibility !== undefined) l.set('visibility', visibility);
    if (patch.linkKey !== undefined) l.set('linkKey', patch.linkKey);
    this.touch(l);
  }

  /** Replaces the saved filter, touching only the criteria that changed (merge-friendly). */
  setListFilter(id: string, filter: ListFilter): void {
    const l = this.list(id);
    const statuses = (filter.statuses ?? []).map((s) => check(s, SAVE_STATUSES, 'status'));
    const prices = (filter.priceLevels ?? []).map((p) => String(checkPrice(p)));
    const f = filterOf(l);
    setKeys(nestedOf(f, 'tags'), filter.tags ?? []);
    setKeys(nestedOf(f, 'categories'), filter.categories ?? []);
    setKeys(nestedOf(f, 'statuses'), statuses);
    setKeys(nestedOf(f, 'priceLevels'), prices);
    const zones = new Map((filter.zones ?? []).map((z) => [zoneKey(z), z]));
    const zm = nestedOf(f, 'zones');
    for (const k of zm.keys()) if (!zones.has(k)) zm.delete(k);
    for (const [k, z] of zones) if (!zm.has(k)) zm.set(k, canonicalJson(z));
    const exclude = filter.exclude ?? [];
    setKeys(nestedOf(f, 'exclude'), exclude);
    setKeys(nestedOf(f, 'include'), (filter.include ?? []).filter((p) => !exclude.includes(p)));
    this.touch(l);
  }

  /** Exception "add this place by hand" (filter list) or selection (manual list). */
  addToList(id: string, placeId: string): void {
    const l = this.list(id);
    if (getStr(l, 'kind') === 'manual') {
      const items = nestedOf(l, 'items');
      if (!items.has(placeId)) items.set(placeId, this.ctx.now());
    } else {
      const f = filterOf(l);
      const ex = nestedOf(f, 'exclude');
      const inc = nestedOf(f, 'include');
      if (ex.has(placeId)) ex.delete(placeId);
      if (!inc.has(placeId)) inc.set(placeId, true);
    }
    this.touch(l);
  }

  /** Exception "remove this place by hand" (filter list) or unselect (manual list). */
  removeFromList(id: string, placeId: string): void {
    const l = this.list(id);
    if (getStr(l, 'kind') === 'manual') {
      const items = nestedOf(l, 'items');
      if (items.has(placeId)) items.delete(placeId);
    } else {
      const f = filterOf(l);
      const ex = nestedOf(f, 'exclude');
      const inc = nestedOf(f, 'include');
      if (inc.has(placeId)) inc.delete(placeId);
      if (!ex.has(placeId)) ex.set(placeId, true);
    }
    this.touch(l);
  }

  /** The places remain; only the list goes (to the trash). */
  deleteList(id: string): void {
    const l = this.list(id);
    mvSet(new Slots(l, DELETED), this.me, this.ctx.now());
    this.touch(l);
  }

  restoreList(id: string): void {
    const l = this.list(id);
    mvClear(new Slots(l, DELETED));
    this.touch(l);
  }

  /**
   * Removes items deleted more than 30 days ago, leaving a tombstone; drops
   * tombstones older than six months. Returns the number of purged items.
   */
  purgeTrash(): number {
    const now = this.ctx.now();
    const old = (m: YMap | null | undefined) => {
      const d = readDeletedAt(m);
      return d !== null && now - d >= TRASH_RETENTION_MS;
    };
    let n = 0;
    for (const placeId of savePlaceIds(this.doc)) {
      if (old(saveEntry(this.doc, placeId))) {
        this.dropEntries(placeId);
        this.r.tombstones.set(`save:${placeId}`, now);
        n++;
      }
    }
    for (const [kind, m] of [['tag', this.r.tags], ['list', this.r.lists]] as const) {
      for (const id of [...m.keys()].sort()) {
        if (old(m.get(id))) {
          m.delete(id);
          this.r.tombstones.set(`${kind}:${id}`, now);
          n++;
        }
      }
    }
    for (const [k, t] of [...this.r.tombstones.entries()]) {
      if (now - t >= TOMBSTONE_RETENTION_MS) this.r.tombstones.delete(k);
    }
    return n;
  }
}

// ------------------------------------------------------------------ healing

/** Folds entry `l` (key `lk`) into the canonical entry `w`. Writes depend only on the two entries. */
function fold(w: YMap, l: YMap, lk: string): void {
  // Tag set, photos, sharing and deletion slots, entries folded earlier:
  // carried over, so the privacy-wins and delete-wins reads see them too.
  for (const [k, v] of l.entries()) if (SAVE_PREFIXES.some((p) => k.startsWith(p)) && !w.has(k)) w.set(k, v);
  // Comments: keep both. Replaced by a new Y.Text (not appended to), so two
  // devices healing the same entries at once do not duplicate the text.
  const wc = getText(w, 'comment');
  const lc = getText(l, 'comment');
  if (lc && !wc.includes(lc)) w.set('comment', new Y.Text(wc ? `${wc}\n\n${lc}` : lc));
  for (const k of ['status', 'priceLevel', 'mainTagId', 'commentVisibility'] as const) {
    if (w.get(k) == null && l.get(k) != null) w.set(k, l.get(k));
  }
  const lc0 = getNum(l, 'createdAt');
  const wc0 = getNum(w, 'createdAt');
  if (lc0 !== null && (wc0 === null || lc0 < wc0)) w.set('createdAt', lc0);
  const lu = getNum(l, 'updatedAt') ?? lc0;
  const wu = getNum(w, 'updatedAt') ?? wc0;
  if (lu !== null && (wu === null || lu > wu)) w.set('updatedAt', lu);
  copyUnknown(l, w);
  w.set(ABSORBED + lk, true);
}

/**
 * Folds concurrent creations of the same save (several entries for one
 * place) into the canonical entry (smallest key). Deterministic (depends
 * only on the document), idempotent, and each entry is folded only once
 * (`absorbed`), so a tag the user later removes does not come back.
 * Returns whether it wrote anything.
 */
export function healDoc(doc: DataDoc): boolean {
  const idx = saveIndex(doc);
  const saves = roots(doc).saves;
  const work: [YMap, [string, YMap][]][] = [];
  for (const placeId of [...idx.keys()].sort()) {
    const keys = idx.get(placeId)!;
    if (keys.size < 2) continue;
    const [wk, ...rest] = [...keys].sort();
    const w = saves.get(wk!)!;
    const losers = rest.filter((k) => !w.has(ABSORBED + k)).map((k) => [k, saves.get(k)!] as [string, YMap]);
    if (losers.length) work.push([w, losers]);
  }
  if (work.length === 0) return false;
  doc.transact(() => {
    for (const [w, losers] of work) for (const [k, l] of losers) fold(w, l, k);
  }, 'heal');
  return true;
}

/** Merges a remote replica into a local one (in place), then heals. Returns `local`. */
export function mergeDataDocs(local: DataDoc, remote: DataDoc | Uint8Array): DataDoc {
  const update = remote instanceof Uint8Array ? remote : Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local));
  Y.applyUpdate(local, update, 'merge');
  healDoc(local);
  return local;
}

export type { AreaGeometry };
