// SPDX-License-Identifier: MPL-2.0
/**
 * Places payload, version 1: what a friend decrypts. A GeoJSON
 * FeatureCollection (RFC 7946) with a `triangulair` foreign member, so a
 * decrypted pack is directly a GeoJSON file (spec "Data model": once
 * decrypted, a place is a GeoJSON Feature).
 *
 *   {"type":"FeatureCollection","triangulair":{"kind":"places","version":1},"features":[
 *     {"type":"Feature","id":"osm:node/123","geometry":{"type":"Point","coordinates":[2.35,48.85]},
 *      "properties":{"name":"Chez Lili","category":"amenity=restaurant","comment":"…","comment_visibility":"friends",
 *                    "status":"tried","price_level":2,
 *                    "tags":[{"name":"Pizza","color":"#EF4444","icon":"pizza","parent":"Restaurant"}],
 *                    "created":"2026-10-13T15:10:00.000Z","updated":"2026-10-14T09:00:00.000Z"}}]}
 *
 * Only personal data (spec "No duplicates"): no OSM record. Optional
 * properties are omitted when empty or default (`kind` only for "zone",
 * `edge` only for "blurred"). The comment is present only when its
 * visibility lets this audience read it. `minor` (absent = 0) follows the
 * spec's versioning: unknown fields are an error unless the collection
 * declares a higher minor than this reader's.
 */
import {
  assertValidGeometry,
  representativePoint,
  isLocalPlaceId,
  parseOsmPlaceId,
  saveIdFor,
  type CommentVisibility,
  type ForeignSaveInput,
  type ForeignTag,
  type PlaceGeometry,
  type PriceLevel,
  type Repository,
  type SavePlaceSnapshot,
  type SaveStatus,
} from '@triangulair/data';
import { packHash } from '@triangulair/crypto';
import { PayloadError } from './errors.ts';
import { parseJsonBody, utf8 } from './payload.ts';

export const PLACES_VERSION = 1;
export const PLACES_MINOR = 0;
/**
 * Reader limits (checked before projecting anything). The writer puts at
 * most `capacity` places in a pack (default 200, never more than this).
 */
export const MAX_FEATURES_PER_PACK = 1000;
const MAX_POSITIONS = 20_000;
const MAX_TAGS = 32;
/** Tag colors: `#RRGGBB` only (they reach the UI and uMap styles). */
export const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
/** Tag icons: a symbol name (lower-case letters, digits, `-` and `_`), never markup or a URL. */
export const ICON_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Dates more than this far in the future are clamped (they would pin a friend's items at the top of "recent"). */
export const MAX_FUTURE_MS = 24 * 3600 * 1000;

export interface TagOut {
  name: string;
  color?: string;
  icon?: string;
  parent?: string;
}

export interface PlaceFeature {
  type: 'Feature';
  id: string;
  geometry: PlaceGeometry;
  properties: {
    name: string;
    category?: string;
    kind?: 'zone';
    edge?: 'blurred';
    comment?: string;
    comment_visibility?: 'friends' | 'public';
    status?: SaveStatus;
    price_level?: PriceLevel;
    tags?: TagOut[];
    created: string;
    updated: string;
  };
}

/** One of my live saves, as read for publishing. */
export interface OwnItem {
  placeId: string;
  saveId: string;
  sharing: 'private' | 'friends';
  comment: string;
  commentVisibility: CommentVisibility;
  status: SaveStatus | null;
  priceLevel: PriceLevel | null;
  createdAt: number;
  updatedAt: number;
  name: string;
  category: string | null;
  kind: 'place' | 'zone';
  edge: 'sharp' | 'blurred';
  geometry: PlaceGeometry;
  lat: number;
  lon: number;
  /** OSM side status of the place (closed places leave public lists). */
  placeStatus: string;
  tags: TagOut[];
}

/** Every live (not trashed) save of mine, with its place and tags, in one pass over SQLite. */
export function readOwnItems(repo: Repository): OwnItem[] {
  const me = repo.meId;
  const tagRows = repo.db.all<{ id: string; parent_id: string | null; name: string; color: string | null; icon: string | null }>(
    `SELECT id, parent_id, name, color, icon FROM tags WHERE owner_id = ? AND active = 1`,
    [me],
  );
  const tags = new Map(tagRows.map((t) => [t.id, t]));
  const tagOut = (id: string): TagOut | null => {
    const t = tags.get(id);
    if (!t) return null;
    const out: TagOut = { name: t.name };
    // Only what readers accept (R-13): another value would make the whole pack unreadable.
    if (t.color && COLOR_RE.test(t.color)) out.color = t.color;
    if (t.icon && ICON_RE.test(t.icon)) out.icon = t.icon;
    const p = t.parent_id ? tags.get(t.parent_id) : undefined;
    if (p) out.parent = p.name;
    return out;
  };
  const byS = new Map<string, TagOut[]>();
  for (const r of repo.db.all<{ save_id: string; tag_id: string }>(
    `SELECT st.save_id, st.tag_id FROM save_tags st JOIN saves s ON s.id = st.save_id JOIN tags t ON t.id = st.tag_id
     WHERE s.owner_id = ? AND s.deleted_at IS NULL ORDER BY st.save_id, st.position, t.name, t.id`,
    [me],
  )) {
    const t = tagOut(r.tag_id);
    if (!t) continue;
    let l = byS.get(r.save_id);
    if (!l) byS.set(r.save_id, (l = []));
    if (l.length < MAX_TAGS) l.push(t);
  }
  // R-02: the place as MY document describes it (`saves.place_snapshot`), never the shared `places` row,
  // which a friend's save may have created. Only the identity fields that came from my own OSM cache
  // (`places.osm_fields`, written by this device's OSM fetches) take precedence, as they do in my app.
  return repo.db
    .all<{
      id: string; place_id: string; comment: string; comment_visibility: CommentVisibility; status: SaveStatus | null;
      price_level: PriceLevel | null; sharing: 'private' | 'friends'; created_at: number; updated_at: number;
      snap: string | null; osm_fields: string; name: string; category: string | null; kind: 'place' | 'zone';
      edge: 'sharp' | 'blurred'; geom: string; pstatus: string;
    }>(
      `SELECT s.id, s.place_id, s.comment, s.comment_visibility, s.status, s.price_level, s.sharing, s.created_at,
         s.updated_at, s.place_snapshot AS snap, p.osm_fields, p.name, p.category, p.kind, p.edge, p.geom, p.status AS pstatus
       FROM saves s JOIN places p ON p.id = s.place_id
       WHERE s.owner_id = ? AND s.deleted_at IS NULL ORDER BY s.place_id`,
      [me],
    )
    .map((r) => {
      const mine = r.snap ? (JSON.parse(r.snap) as SavePlaceSnapshot) : null;
      if (!mine) throw new Error(`my save ${r.id} has no place snapshot (projection out of date)`);
      const osm = new Set(r.osm_fields ? r.osm_fields.split(',') : []);
      const geometry = osm.has('geom') ? (JSON.parse(r.geom) as PlaceGeometry) : mine.geometry;
      const { lat, lon } = representativePoint(geometry);
      return {
        placeId: r.place_id,
        saveId: r.id,
        sharing: r.sharing,
        comment: r.comment,
        commentVisibility: r.comment_visibility,
        status: r.status,
        priceLevel: r.price_level,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        name: osm.has('name') ? r.name : mine.name,
        category: osm.has('category') ? r.category : mine.category,
        kind: mine.kind,
        edge: mine.edge,
        geometry,
        lat,
        lon,
        placeStatus: r.pstatus,
        tags: byS.get(r.id) ?? [],
      };
    });
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The feature of one of my saves for an audience: "friends" (packs) sees
 * comments marked friends or public, "public" (public lists) only public ones.
 */
export function featureFor(item: OwnItem, audience: 'friends' | 'public'): PlaceFeature {
  const props = { name: clean(item.name, 500) } as PlaceFeature['properties'];
  if (item.category) props.category = clean(item.category, 200);
  if (item.kind === 'zone') props.kind = 'zone';
  if (item.edge === 'blurred') props.edge = 'blurred';
  const visible = audience === 'public' ? item.commentVisibility === 'public' : item.commentVisibility !== 'private';
  if (visible && item.comment) {
    props.comment = clean(item.comment, 20_000, true);
    props.comment_visibility = item.commentVisibility as 'friends' | 'public';
  }
  if (item.status) props.status = item.status;
  if (item.priceLevel) props.price_level = item.priceLevel;
  if (item.tags.length) {
    props.tags = item.tags.map((t) => {
      const o: TagOut = { ...t, name: clean(t.name, 100) };
      if (t.parent !== undefined) o.parent = clean(t.parent, 100);
      return o;
    });
  }
  props.created = iso(item.createdAt);
  props.updated = iso(item.updatedAt);
  return { type: 'Feature', id: item.placeId, geometry: item.geometry, properties: props };
}

/** What readers accept in a string field (R-13): no controls or bidi overrides, bounded length. */
function clean(v: string, max: number, multiline = false): string {
  const out = v.replace(new RegExp(CONTROL_RE.source, 'g'), '').replace(multiline ? /(?!)/ : new RegExp(LINE_RE.source, 'g'), ' ');
  return out.length > max ? out.slice(0, max) : out;
}

/** Short content hash of a feature (what changed between two versions of an item). */
export function featureHash(f: PlaceFeature): string {
  return packHash(utf8(JSON.stringify(f))).slice(7, 29);
}

export function placesCollection(features: PlaceFeature[]): Uint8Array {
  return utf8(JSON.stringify({ type: 'FeatureCollection', triangulair: { kind: 'places', version: PLACES_VERSION }, features }));
}

// ------------------------------------------------------------------ reader side

const STATUSES = new Set(['to_try', 'tried', 'favorite']);
const PROPS = new Set(['name', 'category', 'kind', 'edge', 'comment', 'comment_visibility', 'status', 'price_level', 'tags', 'created', 'updated']);
const TAG_KEYS = new Set(['name', 'color', 'icon', 'parent']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function fail(msg: string): never {
  throw new PayloadError(`places: ${msg}`);
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
// C0 controls except tab, line feed and carriage return; DEL and C1 controls; bidi embeddings, overrides and isolates.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex
const LINE_RE = /[\t\n\r]/;
function str(v: unknown, max: number, what: string, multiline = false): string {
  if (typeof v !== 'string' || v.length > max) fail(`${what} must be a string of at most ${max} characters`);
  if (CONTROL_RE.test(v) || (!multiline && LINE_RE.test(v))) fail(`${what} contains control or bidirectional override characters`);
  return v;
}
function date(v: unknown, what: string): number {
  if (typeof v !== 'string' || !ISO_RE.test(v)) fail(`${what} must be an ISO-8601 UTC date`);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) fail(`${what} is not a real date`);
  return t;
}
function countPositions(c: unknown, depth: number): number {
  if (!Array.isArray(c)) fail('bad coordinates');
  if (depth === 0) {
    if (c.length < 2 || c.length > 3 || !c.every((x) => typeof x === 'number' && Number.isFinite(x))) fail('bad position');
    return 1;
  }
  let n = 0;
  for (const x of c) n += countPositions(x, depth - 1);
  return n;
}
const DEPTH: Record<string, number> = { Point: 0, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };

export interface ParsedFeature {
  feature: PlaceFeature;
  hash: string;
}

/** Parses and validates a places payload body (strict; see the module comment). */
export function parsePlaces(body: Uint8Array): ParsedFeature[] {
  const doc = parseJsonBody(body);
  if (!isObj(doc) || doc.type !== 'FeatureCollection' || !isObj(doc.triangulair)) fail('not a TrianguLair FeatureCollection');
  const meta = doc.triangulair;
  if (meta.kind !== 'places') fail('wrong kind');
  if (meta.version !== PLACES_VERSION) throw new PayloadError('places: unsupported version', true);
  const minor = meta.minor === undefined ? 0 : meta.minor;
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor < 1 && meta.minor !== undefined) fail('bad minor');
  const lenient = minor > PLACES_MINOR;
  for (const k of Object.keys(doc)) if (!['type', 'triangulair', 'features'].includes(k) && !lenient) fail(`unknown field ${k}`);
  for (const k of Object.keys(meta)) if (!['kind', 'version', 'minor'].includes(k) && !lenient) fail(`unknown field triangulair.${k}`);
  if (!Array.isArray(doc.features) || doc.features.length > MAX_FEATURES_PER_PACK) fail('features must be an array (bounded)');
  return doc.features.map((f: unknown) => {
    if (!isObj(f) || f.type !== 'Feature') fail('feature expected');
    for (const k of Object.keys(f)) if (!['type', 'id', 'geometry', 'properties'].includes(k) && !lenient) fail(`unknown feature field ${k}`);
    const id = str(f.id, 100, 'id');
    if (!parseOsmPlaceId(id) && !isLocalPlaceId(id)) fail('id is not a place id');
    const g = f.geometry;
    if (!isObj(g) || typeof g.type !== 'string' || !(g.type in DEPTH)) fail('unsupported geometry');
    if (countPositions(g.coordinates, DEPTH[g.type]!) > MAX_POSITIONS) fail('geometry too large');
    try {
      assertValidGeometry(g as unknown as PlaceGeometry);
    } catch {
      fail('invalid geometry');
    }
    const p = f.properties;
    if (!isObj(p)) fail('properties expected');
    for (const k of Object.keys(p)) if (!PROPS.has(k) && !lenient) fail(`unknown property ${k}`);
    str(p.name, 500, 'name');
    if (p.category !== undefined) str(p.category, 200, 'category');
    if (p.kind !== undefined && p.kind !== 'zone') fail('bad kind');
    if (p.edge !== undefined && p.edge !== 'blurred') fail('bad edge');
    if (p.comment !== undefined) str(p.comment, 20_000, 'comment', true);
    if (p.comment_visibility !== undefined && p.comment_visibility !== 'friends' && p.comment_visibility !== 'public') fail('bad comment_visibility');
    if (p.status !== undefined && !STATUSES.has(p.status as string)) fail('bad status');
    if (p.price_level !== undefined && ![1, 2, 3, 4].includes(p.price_level as number)) fail('bad price_level');
    if (p.tags !== undefined) {
      if (!Array.isArray(p.tags) || p.tags.length > MAX_TAGS) fail('bad tags');
      for (const t of p.tags) {
        if (!isObj(t)) fail('bad tag');
        for (const k of Object.keys(t)) if (!TAG_KEYS.has(k) && !lenient) fail(`unknown tag field ${k}`);
        str(t.name, 100, 'tag name');
        if (t.color !== undefined && (typeof t.color !== 'string' || !COLOR_RE.test(t.color))) fail('tag color must be #RRGGBB');
        if (t.icon !== undefined && (typeof t.icon !== 'string' || !ICON_RE.test(t.icon))) fail('tag icon must be a symbol name');
        if (t.parent !== undefined) str(t.parent, 100, 'tag parent');
      }
    }
    date(p.created, 'created');
    date(p.updated, 'updated');
    const feature = f as unknown as PlaceFeature;
    return { feature, hash: featureHash(feature) };
  });
}

/**
 * A friend's feature as a foreign save for the local cache. Dates later than
 * `now` + 24 h are clamped to it (R-13).
 */
export function toForeignSave(owner: string, f: PlaceFeature, now: number = Date.now()): ForeignSaveInput {
  const latest = now + MAX_FUTURE_MS;
  const clamp = (iso: string) => Math.min(Date.parse(iso), latest);
  const osm = parseOsmPlaceId(f.id);
  const p = f.properties;
  const kind = p.kind === 'zone' ? 'zone' : 'place';
  const theirTags: ForeignTag[] = (p.tags ?? []).map((t) => ({
    name: t.name,
    ...(t.color !== undefined && { color: t.color }),
    ...(t.icon !== undefined && { icon: t.icon }),
  }));
  return {
    id: saveIdFor(owner, f.id),
    ownerId: owner,
    place: {
      id: f.id,
      osmType: osm?.osmType ?? null,
      osmId: osm?.osmId ?? null,
      name: p.name,
      category: p.category ?? null,
      kind,
      edge: p.edge ?? 'sharp',
      geometry: f.geometry,
    },
    comment: p.comment ?? '',
    commentVisibility: p.comment_visibility ?? 'friends',
    status: p.status ?? null,
    priceLevel: p.price_level ?? null,
    theirTags,
    createdAt: clamp(p.created),
    updatedAt: clamp(p.updated),
  };
}

/** Z-order (Morton) key of a point: nearby places get nearby keys, so packs follow geographic zones. */
export function zOrder(lat: number, lon: number): number {
  const x = Math.max(0, Math.min(65535, Math.floor(((lon + 180) / 360) * 65536)));
  const y = Math.max(0, Math.min(65535, Math.floor(((lat + 90) / 180) * 65536)));
  let z = 0;
  for (let i = 15; i >= 0; i--) z = z * 4 + (((y >> i) & 1) << 1) + ((x >> i) & 1);
  return z;
}
