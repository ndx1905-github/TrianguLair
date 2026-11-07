// SPDX-License-Identifier: MPL-2.0
/**
 * Repository over the local SQLite database.
 *
 * Two kinds of writes go through here:
 * - the projection of my own data from the Yjs document (`DataStore`
 *   is the only caller; the app never edits my saves, tags or lists here), and
 * - local caches that are not mine to merge: OSM data on place cards, friends'
 *   decrypted saves, people.
 *
 * Reads (map, list, search, list evaluation) are for everyone.
 */
import { findDuplicateSuggestions, type DedupOptions, type DuplicateSuggestion } from '../dedup.ts';
import type { RunResult, SqlDriver, SqlValue } from '../driver/types.ts';
import {
  canonicalJson,
  isListEligible,
  matchesCriteria,
  normalizeFilter,
  type FilterContext,
} from '../filter.ts';
import {
  bboxAround,
  bboxIntersects,
  geometryBBox,
  geometryIntersectsArea,
  haversineM,
  pointInArea,
  representativePoint,
  splitBBox,
} from '../geo.ts';
import { normalizeSnapshot } from '../place.ts';
import { ftsMatchQuery, normalizeText, tokenize } from '../text.ts';
import type {
  AreaGeometry,
  BBox,
  CommentVisibility,
  LatLon,
  ListFilter,
  ListKind,
  ListRecord,
  ListVisibility,
  MediaRecord,
  PersonRecord,
  PlaceGeometry,
  PlaceKind,
  PlaceOsmData,
  PlaceRecord,
  PlaceSnapshot,
  PlaceStatus,
  PriceLevel,
  SaveRecord,
  SaveStatus,
  Sharing,
  TagMappingRecord,
  TagRecord,
  ZoneEdge,
} from '../types.ts';
import { migrate, type Capabilities, type MigrateOptions } from './schema.ts';

export type PlaceSource = 'mine' | 'friends' | 'all';
export type PlaceSort = 'recent' | 'distance' | 'name' | 'relevance';

export interface PlaceQuery {
  /** Places whose bbox intersects this one. */
  bbox?: BBox;
  /** Places whose geometry touches this area (exact test after the index). */
  within?: AreaGeometry;
  /** Full-text search (name, category, address, comments, my tag names). */
  text?: string;
  /** Default "all": places saved by me or by a friend. */
  source?: PlaceSource;
  /** Default: "relevance" with `text`, "recent" otherwise. */
  sort?: PlaceSort;
  /** Reference point for `sort: "distance"` and `distanceM`. */
  from?: LatLon;
  limit?: number;
  offset?: number;
}

export interface MySaveSummary {
  saveId: string;
  status: SaveStatus | null;
  sharing: Sharing;
  priceLevel: PriceLevel | null;
  mainTagId: string | null;
  /** Active tags, main first. */
  tagIds: string[];
  updatedAt: number;
}

export interface PlaceHit {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
  edge: ZoneEdge;
  category: string | null;
  status: PlaceStatus;
  osmType: PlaceRecord['osmType'];
  osmId: number | null;
  mine: MySaveSummary | null;
  /** Friends who saved this place and shared it with me ("3 friends"). */
  friendsCount: number;
  lastUpdatedAt: number;
  distanceM: number | null;
}

export interface MapPin {
  id: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
  status: PlaceStatus;
  /** My main tag (active), for the pin's icon and color. */
  mainTagId: string | null;
  mine: boolean;
  /** Saved by at least one friend (faded pin when not mine). */
  friends: boolean;
}

export interface ForeignSaveInput {
  id: string;
  ownerId: string;
  place: PlaceSnapshot;
  comment?: string;
  commentVisibility?: CommentVisibility;
  status?: SaveStatus | null;
  priceLevel?: PriceLevel | null;
  /**
   * The friend's tags on this save, as received: a name, or a name with the
   * color and icon chosen by its author (shown until I map it to one of mine).
   */
  theirTags?: (string | ForeignTag)[];
  createdAt: number;
  updatedAt: number;
}

/** A friend's tag as received with their save. */
export interface ForeignTag {
  name: string;
  color?: string | null;
  icon?: string | null;
}

/** One friend's tag on one of their saves (`Repository.friendTags`). */
export interface FriendTagRow {
  personId: string;
  saveId: string;
  placeId: string;
  name: string;
  color: string | null;
  icon: string | null;
}

/** Valid tags of a `their_tags` value (tolerant: bad entries are skipped). */
export function parseTheirTags(value: unknown): ForeignTag[] {
  if (!Array.isArray(value)) return [];
  const out: ForeignTag[] = [];
  for (const v of value) {
    if (typeof v === 'string') {
      if (v.trim()) out.push({ name: v.trim() });
    } else if (v && typeof v === 'object' && typeof (v as ForeignTag).name === 'string' && (v as ForeignTag).name.trim()) {
      const t = v as ForeignTag;
      out.push({
        name: t.name.trim(),
        ...(typeof t.color === 'string' ? { color: t.color } : {}),
        ...(typeof t.icon === 'string' ? { icon: t.icon } : {}),
      });
    }
  }
  return out;
}

export interface OpenRepositoryOptions extends MigrateOptions {
  meId: string;
  meDisplayName?: string;
}

type PlaceRow = {
  pk: number;
  id: string;
  osm_type: string | null;
  osm_id: number | null;
  name: string;
  category: string | null;
  kind: string;
  edge: string;
  geom: string;
  lat: number;
  lon: number;
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
  address: string | null;
  opening_hours: string | null;
  website: string | null;
  phone: string | null;
  osm_tags: string | null;
  photos: string | null;
  osm_synced_at: number | null;
  status: string;
  closed_signals: string | null;
};

type SaveRow = {
  id: string;
  owner_id: string;
  place_id: string;
  comment: string;
  comment_visibility: string;
  status: string | null;
  price_level: number | null;
  sharing: string;
  main_tag_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  tag_ids: string | null;
};

const json = <T>(s: string | null): T | null => (s == null ? null : (JSON.parse(s) as T));

/** The description a save's owner gives of its place (`saves.place_snapshot`). */
export interface SavePlaceSnapshot {
  name: string;
  category: string | null;
  kind: PlaceKind;
  edge: ZoneEdge;
  geometry: PlaceGeometry;
}

function snapshotJson(p: PlaceSnapshot): string {
  const s = normalizeSnapshot(p);
  return JSON.stringify({ name: s.name, category: s.category, kind: s.kind, edge: s.edge, geometry: s.geometry } satisfies SavePlaceSnapshot);
}

function rowToPlace(r: PlaceRow): PlaceRecord {
  return {
    id: r.id,
    osmType: r.osm_type as PlaceRecord['osmType'],
    osmId: r.osm_id,
    name: r.name,
    category: r.category,
    kind: r.kind as PlaceKind,
    edge: r.edge as ZoneEdge,
    geometry: JSON.parse(r.geom) as PlaceGeometry,
    lat: r.lat,
    lon: r.lon,
    bbox: [r.min_lon, r.min_lat, r.max_lon, r.max_lat],
    address: r.address,
    openingHours: r.opening_hours,
    website: r.website,
    phone: r.phone,
    osmTags: json(r.osm_tags),
    photos: json(r.photos),
    status: r.status as PlaceStatus,
    closedSignals: json(r.closed_signals),
    osmSyncedAt: r.osm_synced_at,
  };
}

function rowToSave(r: SaveRow): SaveRecord {
  return {
    id: r.id,
    ownerId: r.owner_id,
    placeId: r.place_id,
    comment: r.comment,
    commentVisibility: r.comment_visibility as CommentVisibility,
    status: r.status as SaveStatus | null,
    priceLevel: r.price_level as PriceLevel | null,
    sharing: r.sharing as Sharing,
    mainTagId: r.main_tag_id,
    tagIds: r.tag_ids ? r.tag_ids.split(',') : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

const SAVE_COLUMNS = `s.id, s.owner_id, s.place_id, s.comment, s.comment_visibility, s.status, s.price_level,
  s.sharing, s.main_tag_id, s.created_at, s.updated_at, s.deleted_at,
  (SELECT group_concat(tag_id) FROM (SELECT st.tag_id FROM save_tags st JOIN tags t ON t.id = st.tag_id
     WHERE st.save_id = s.id AND t.active = 1 ORDER BY st.position, t.name, t.id)) AS tag_ids`;

/** SQL fragment + params selecting place pks whose bbox intersects `b`. */
function spatialClause(caps: Capabilities, boxes: BBox[]): { sql: string; params: SqlValue[] } {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const [w, s, e, n] of boxes) {
    // The R*Tree stores 32-bit floats rounded outwards: it may return a few
    // extra candidates at the edges, never miss one; the exact test follows.
    const exact = `(p.min_lon <= ? AND p.max_lon >= ? AND p.min_lat <= ? AND p.max_lat >= ?)`;
    if (caps.rtree) {
      parts.push(
        `(p.pk IN (SELECT pk FROM places_rtree WHERE min_lon <= ? AND max_lon >= ? AND min_lat <= ? AND max_lat >= ?) AND ${exact})`,
      );
      params.push(e, w, n, s, e, w, n, s);
    } else {
      parts.push(exact);
      params.push(e, w, n, s);
    }
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '1', params };
}

function intersectBBox(a: BBox, b: BBox): BBox | null {
  // Only for non-antimeridian boxes (callers split first).
  const w = Math.max(a[0], b[0]);
  const s = Math.max(a[1], b[1]);
  const e = Math.min(a[2], b[2]);
  const n = Math.min(a[3], b[3]);
  return w <= e && s <= n ? [w, s, e, n] : null;
}

export class Repository {
  readonly capabilities: Capabilities;

  private constructor(
    readonly db: SqlDriver,
    readonly meId: string,
    caps: Capabilities,
  ) {
    this.capabilities = caps;
  }

  static open(db: SqlDriver, options: OpenRepositoryOptions): Repository {
    const caps = migrate(db, options);
    const repo = new Repository(db, options.meId, caps);
    repo.ensureMe(options.meDisplayName ?? '');
    return repo;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  // ---------------------------------------------------------------- people

  private ensureMe(displayName: string): void {
    const other = this.db.get<{ id: string }>(`SELECT id FROM people WHERE is_me = 1 AND id <> ?`, [this.meId]);
    if (other) throw new Error(`database belongs to ${other.id}, not ${this.meId}`);
    this.db.run(
      `INSERT INTO people (id, display_name, is_me) VALUES (?, ?, 1) ON CONFLICT (id) DO UPDATE SET is_me = 1`,
      [this.meId, displayName],
    );
  }

  /** People stub: insert or update a person (friends, followed authors). */
  upsertPerson(p: Partial<PersonRecord> & { id: string }): void {
    if (p.id === this.meId && p.isMe === false) throw new Error('cannot unset is_me on myself');
    const cur = this.getPerson(p.id);
    const v: PersonRecord = {
      id: p.id,
      displayName: p.displayName ?? cur?.displayName ?? '',
      avatar: p.avatar !== undefined ? p.avatar : (cur?.avatar ?? null),
      publicKey: p.publicKey !== undefined ? p.publicKey : (cur?.publicKey ?? null),
      readUrl: p.readUrl !== undefined ? p.readUrl : (cur?.readUrl ?? null),
      isMe: p.id === this.meId,
      iFollow: p.iFollow ?? cur?.iFollow ?? false,
      followsMe: p.followsMe ?? cur?.followsMe ?? false,
      requestState: p.requestState !== undefined ? p.requestState : (cur?.requestState ?? null),
      lastEtag: p.lastEtag !== undefined ? p.lastEtag : (cur?.lastEtag ?? null),
      lastSync: p.lastSync !== undefined ? p.lastSync : (cur?.lastSync ?? null),
    };
    this.db.run(
      `INSERT INTO people (id, display_name, avatar, public_key, read_url, is_me, i_follow, follows_me, request_state, last_etag, last_sync)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, avatar = excluded.avatar,
         public_key = excluded.public_key, read_url = excluded.read_url, i_follow = excluded.i_follow,
         follows_me = excluded.follows_me, request_state = excluded.request_state,
         last_etag = excluded.last_etag, last_sync = excluded.last_sync`,
      [
        v.id, v.displayName, v.avatar, v.publicKey, v.readUrl, v.isMe ? 1 : 0, v.iFollow ? 1 : 0,
        v.followsMe ? 1 : 0, v.requestState, v.lastEtag, v.lastSync,
      ],
    );
  }

  getPerson(id: string): PersonRecord | null {
    const r = this.db.get(`SELECT * FROM people WHERE id = ?`, [id]);
    if (!r) return null;
    return {
      id: r.id as string,
      displayName: r.display_name as string,
      avatar: r.avatar as string | null,
      publicKey: r.public_key as string | null,
      readUrl: r.read_url as string | null,
      isMe: r.is_me === 1,
      iFollow: r.i_follow === 1,
      followsMe: r.follows_me === 1,
      requestState: r.request_state as PersonRecord['requestState'],
      lastEtag: r.last_etag as string | null,
      lastSync: r.last_sync as number | null,
    };
  }

  /** Removes a person and, by cascade, their saves in my cache. */
  removePerson(id: string): void {
    if (id === this.meId) throw new Error('cannot remove myself');
    this.transaction(() => {
      const places = this.db.all<{ place_id: string }>(`SELECT place_id FROM saves WHERE owner_id = ?`, [id]);
      this.db.run(`DELETE FROM people WHERE id = ?`, [id]);
      this.refreshSearchText(places.map((p) => p.place_id));
    });
  }

  // ---------------------------------------------------------------- places

  /**
   * Inserts or updates the identity and geometry of a place from a snapshot.
   * The fields that came from my own OSM cache (`osm_fields`, set by
   * `updatePlaceOsmData`) are kept; the others take the snapshot's values.
   *
   * `foreignOwner` (a friend's save, T-204 review R-02): the row is only
   * created when missing, or updated while every save on it belongs to that
   * friend. A friend can never change a row that one of my saves, or another
   * person's, also uses: their own description stays in their save
   * (`saves.place_snapshot`).
   */
  upsertPlaceSnapshot(snapshot: PlaceSnapshot, opts: { foreignOwner?: string } = {}): void {
    const s = normalizeSnapshot(snapshot);
    const [w, so, e, n] = geometryBBox(s.geometry);
    const rp = representativePoint(s.geometry);
    const field: Record<string, string> = { name: 'name', name_key: 'name', category: 'category' };
    const keep = (col: string) =>
      `${col} = CASE WHEN instr(',' || places.osm_fields || ',', ',${field[col] ?? 'geom'},') > 0 THEN places.${col} ELSE excluded.${col} END`;
    const foreign = opts.foreignOwner !== undefined;
    this.db.run(
      `INSERT INTO places (id, osm_type, osm_id, name, name_key, category, kind, edge, geom, lat, lon, min_lon, min_lat, max_lon, max_lat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, edge = excluded.edge,
         ${['name', 'name_key', 'category', 'geom', 'lat', 'lon', 'min_lon', 'min_lat', 'max_lon', 'max_lat'].map(keep).join(', ')}
       ${foreign ? 'WHERE NOT EXISTS (SELECT 1 FROM saves o WHERE o.place_id = places.id AND o.owner_id <> ?)' : ''}`,
      [
        s.id, s.osmType, s.osmId, s.name, normalizeText(s.name), s.category, s.kind, s.edge,
        JSON.stringify(s.geometry), rp.lat, rp.lon, w, so, e, n,
        ...(foreign ? [opts.foreignOwner!] : []),
      ],
    );
  }

  /**
   * OSM cache of a place card (T-106/T-107/T-113). Optional `name`,
   * `category` and `geometry` replace the snapshot values from now on.
   */
  updatePlaceOsmData(
    placeId: string,
    data: PlaceOsmData & { name?: string; category?: string | null; geometry?: PlaceGeometry },
  ): void {
    const cur = this.getPlace(placeId);
    if (!cur) throw new Error(`unknown place ${placeId}`);
    const geometry = data.geometry ?? cur.geometry;
    const [w, s, e, n] = geometryBBox(geometry);
    const rp = representativePoint(geometry);
    const name = data.name ?? cur.name;
    const pick = <K extends keyof PlaceOsmData>(k: K): PlaceOsmData[K] => (data[k] !== undefined ? data[k] : (cur as PlaceOsmData)[k]);
    const prevFields = this.db.get<{ f: string }>(`SELECT osm_fields AS f FROM places WHERE id = ?`, [placeId])!.f;
    const fields = new Set(prevFields ? prevFields.split(',') : []);
    if (data.name !== undefined) fields.add('name');
    if (data.category !== undefined) fields.add('category');
    if (data.geometry !== undefined) fields.add('geom');
    const osmFields = ['name', 'category', 'geom'].filter((f) => fields.has(f)).join(',');
    const statusChanged = data.status !== undefined && data.status !== cur.status;
    this.transaction(() => {
      this.db.run(
        `UPDATE places SET name = ?, name_key = ?, category = ?, geom = ?, lat = ?, lon = ?, min_lon = ?, min_lat = ?,
           max_lon = ?, max_lat = ?, address = ?, opening_hours = ?, website = ?, phone = ?, osm_tags = ?, photos = ?,
           status = ?, closed_signals = ?, osm_synced_at = ?, osm_fields = ?
         WHERE id = ?`,
        [
          name, normalizeText(name), data.category !== undefined ? data.category : cur.category,
          JSON.stringify(geometry), rp.lat, rp.lon, w, s, e, n,
          pick('address') ?? null, pick('openingHours') ?? null, pick('website') ?? null, pick('phone') ?? null,
          pick('osmTags') ? JSON.stringify(pick('osmTags')) : null,
          pick('photos') ? JSON.stringify(pick('photos')) : null,
          pick('status') ?? 'open',
          pick('closedSignals') ? JSON.stringify(pick('closedSignals')) : null,
          data.osmSyncedAt !== undefined ? data.osmSyncedAt : (cur.osmSyncedAt ?? Date.now()),
          osmFields,
          placeId,
        ],
      );
      this.refreshSearchText([placeId]);
      if (statusChanged || data.category !== undefined || data.geometry) this.markListsDirty();
    });
  }

  getPlace(id: string): PlaceRecord | null {
    const r = this.db.get<PlaceRow>(`SELECT * FROM places WHERE id = ?`, [id]);
    return r ? rowToPlace(r) : null;
  }

  /** Deletes cached places that nobody's save refers to any more. */
  pruneOrphanPlaces(): number {
    return this.db.run(`DELETE FROM places WHERE NOT EXISTS (SELECT 1 FROM saves s WHERE s.place_id = places.id)`).changes;
  }

  /**
   * Rebuilds `search_text` (what full-text search sees) for these places:
   * name, category value, address, the comments of live saves, my active tags.
   */
  refreshSearchText(placeIds: Iterable<string>): void {
    for (const id of new Set(placeIds)) {
      const p = this.db.get<{ name: string; category: string | null; address: string | null; search_text: string }>(
        `SELECT name, category, address, search_text FROM places WHERE id = ?`,
        [id],
      );
      if (!p) continue;
      const comments = this.db.all<{ comment: string }>(
        `SELECT comment FROM saves WHERE place_id = ? AND deleted_at IS NULL AND comment <> ''
           AND (owner_id = ? OR comment_visibility <> 'private') ORDER BY owner_id`,
        [id, this.meId],
      );
      const tags = this.db.all<{ name: string }>(
        `SELECT t.name FROM saves s JOIN save_tags st ON st.save_id = s.id JOIN tags t ON t.id = st.tag_id
         WHERE s.place_id = ? AND s.owner_id = ? AND s.deleted_at IS NULL AND t.active = 1 ORDER BY t.name`,
        [id, this.meId],
      );
      const category = p.category ? (p.category.split('=')[1] ?? p.category).replace(/_/g, ' ') : '';
      const text = normalizeText(
        [p.name, category, p.address ?? '', ...comments.map((c) => c.comment), ...tags.map((t) => t.name)].join(' '),
      );
      if (text !== p.search_text) this.db.run(`UPDATE places SET search_text = ? WHERE id = ?`, [text, id]);
    }
  }

  // ---------------------------------------------------------------- my data (projection only)

  /** Projection: writes one of my saves exactly as given (replacing tags and media). */
  writeOwnSave(save: SaveRecord, place: PlaceSnapshot, media: readonly MediaRecord[]): void {
    if (save.ownerId !== this.meId) throw new Error('writeOwnSave is for my own saves');
    if (save.placeId !== place.id) throw new Error('save and place snapshot disagree');
    this.upsertPlaceSnapshot(place);
    const prevPlace = this.db.get<{ place_id: string }>(`SELECT place_id FROM saves WHERE id = ?`, [save.id]);
    this.db.run(
      `INSERT INTO saves (id, owner_id, place_id, comment, comment_visibility, status, price_level, sharing, main_tag_id,
         their_tags, created_at, updated_at, deleted_at, place_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET place_id = excluded.place_id, comment = excluded.comment,
         comment_visibility = excluded.comment_visibility, status = excluded.status, price_level = excluded.price_level,
         sharing = excluded.sharing, main_tag_id = excluded.main_tag_id, created_at = excluded.created_at,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, place_snapshot = excluded.place_snapshot`,
      [
        save.id, save.ownerId, save.placeId, save.comment, save.commentVisibility, save.status, save.priceLevel,
        save.sharing, save.mainTagId, save.createdAt, save.updatedAt, save.deletedAt, snapshotJson(place),
      ],
    );
    this.db.run(`DELETE FROM save_tags WHERE save_id = ?`, [save.id]);
    // Position 0 for the main tag, 1 for the others (then ordered by name on read).
    for (const tagId of new Set(save.tagIds)) {
      this.db.run(
        `INSERT INTO save_tags (save_id, tag_id, position) SELECT ?, id, ? FROM tags WHERE id = ? AND owner_id = ?`,
        [save.id, tagId === save.mainTagId ? 0 : 1, tagId, this.meId],
      );
    }
    this.db.run(`DELETE FROM media WHERE save_id = ?`, [save.id]);
    for (const m of media) {
      this.db.run(
        `INSERT INTO media (id, save_id, file, blurhash, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [m.id, save.id, m.file, m.blurhash, m.width, m.height, m.createdAt],
      );
    }
    const touched = [save.placeId];
    if (prevPlace && prevPlace.place_id !== save.placeId) touched.push(prevPlace.place_id);
    this.refreshSearchText(touched);
  }

  /** Projection: my save no longer exists in the document (purged from the trash). */
  removeOwnSave(saveId: string): void {
    const row = this.db.get<{ place_id: string }>(`SELECT place_id FROM saves WHERE id = ? AND owner_id = ?`, [
      saveId,
      this.meId,
    ]);
    if (!row) return;
    this.db.run(`DELETE FROM saves WHERE id = ?`, [saveId]);
    this.refreshSearchText([row.place_id]);
  }

  ownSaveIds(): string[] {
    return this.db.all<{ id: string }>(`SELECT id FROM saves WHERE owner_id = ?`, [this.meId]).map((r) => r.id);
  }

  /** Projection: replaces all my tags (they are few; parent cycles already broken). */
  writeOwnTags(tags: readonly (TagRecord & { active: boolean })[]): void {
    const before = new Map(
      this.db
        .all<{ id: string; name: string; active: number }>(`SELECT id, name, active FROM tags WHERE owner_id = ?`, [this.meId])
        .map((r) => [r.id, `${r.name}\u0000${r.active}`]),
    );
    const keep = new Set(tags.map((t) => t.id));
    const changed = new Set<string>();
    for (const id of before.keys()) {
      if (!keep.has(id)) {
        changed.add(id);
      }
    }
    for (const t of tags) {
      if (before.get(t.id) !== `${t.name}\u0000${t.active ? 1 : 0}`) changed.add(t.id);
    }
    // Places whose search text includes a changed tag name.
    const affected =
      changed.size === 0
        ? []
        : this.db
            .all<{ place_id: string }>(
              `SELECT DISTINCT s.place_id FROM save_tags st JOIN saves s ON s.id = st.save_id
               WHERE st.tag_id IN (SELECT value FROM json_each(?))`,
              [JSON.stringify([...changed])],
            )
            .map((r) => r.place_id);
    for (const id of before.keys()) if (!keep.has(id)) this.db.run(`DELETE FROM tags WHERE id = ?`, [id]);
    for (const t of tags) {
      this.db.run(
        `INSERT INTO tags (id, owner_id, parent_id, name, color, icon, osm_categories, deleted_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, color = excluded.color,
           icon = excluded.icon, osm_categories = excluded.osm_categories, deleted_at = excluded.deleted_at,
           active = excluded.active`,
        [
          t.id, this.meId, t.parentId, t.name, t.color, t.icon, JSON.stringify(t.osmCategories), t.deletedAt,
          t.active ? 1 : 0,
        ],
      );
    }
    this.refreshSearchText(affected);
  }

  /** Projection: writes one of my lists (its items are recomputed lazily). */
  writeOwnList(list: ListRecord): void {
    if (list.ownerId !== this.meId) throw new Error('writeOwnList is for my own lists');
    this.db.run(
      `INSERT INTO lists (id, owner_id, name, description, visibility, link_key, kind, filter, manual, created_at,
         updated_at, deleted_at, items_dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
         visibility = excluded.visibility, link_key = excluded.link_key, kind = excluded.kind, filter = excluded.filter,
         manual = excluded.manual, created_at = excluded.created_at, updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at, items_dirty = 1`,
      [
        list.id, list.ownerId, list.name, list.description, list.visibility, list.linkKey, list.kind,
        canonicalJson(normalizeFilter(list.filter)), JSON.stringify([...new Set(list.manualItems)].sort()),
        list.createdAt, list.updatedAt, list.deletedAt,
      ],
    );
  }

  removeOwnList(listId: string): void {
    this.db.run(`DELETE FROM lists WHERE id = ? AND owner_id = ?`, [listId, this.meId]);
  }

  ownListIds(): string[] {
    return this.db.all<{ id: string }>(`SELECT id FROM lists WHERE owner_id = ?`, [this.meId]).map((r) => r.id);
  }

  writeTagMappings(mappings: readonly TagMappingRecord[]): void {
    this.db.run(`DELETE FROM tag_mappings`);
    for (const m of mappings) {
      this.db.run(`INSERT INTO tag_mappings (person_id, their_tag, my_tag_id) VALUES (?, ?, ?)`, [
        m.personId,
        m.theirTag,
        m.myTagId,
      ]);
    }
  }

  markListsDirty(): void {
    this.db.run(`UPDATE lists SET items_dirty = 1 WHERE items_dirty = 0`);
  }

  // ---------------------------------------------------------------- friends' saves (cache)

  /** A friend's decrypted save (T-204). Private saves never reach me; refuse them anyway. */
  upsertForeignSave(input: ForeignSaveInput): void {
    if (input.ownerId === this.meId) throw new Error('my own saves come from my document');
    this.transaction(() => {
      if (!this.getPerson(input.ownerId)) this.upsertPerson({ id: input.ownerId });
      this.upsertPlaceSnapshot(input.place, { foreignOwner: input.ownerId });
      this.db.run(
        `INSERT INTO saves (id, owner_id, place_id, comment, comment_visibility, status, price_level, sharing,
           main_tag_id, their_tags, created_at, updated_at, deleted_at, place_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'friends', NULL, ?, ?, ?, NULL, ?)
         ON CONFLICT (id) DO UPDATE SET place_id = excluded.place_id, comment = excluded.comment,
           comment_visibility = excluded.comment_visibility, status = excluded.status,
           price_level = excluded.price_level, their_tags = excluded.their_tags, created_at = excluded.created_at,
           updated_at = excluded.updated_at, deleted_at = NULL, place_snapshot = excluded.place_snapshot`,
        [
          input.id, input.ownerId, input.place.id, input.comment ?? '', input.commentVisibility ?? 'friends',
          input.status ?? null, input.priceLevel ?? null, JSON.stringify(parseTheirTags(input.theirTags ?? []).map((t) => (t.color || t.icon ? t : t.name))), input.createdAt,
          input.updatedAt, snapshotJson(input.place),
        ],
      );
      this.refreshSearchText([input.place.id]);
    });
  }

  /** A friend deleted their save, or removed my access (deletion marker). */
  deleteForeignSave(saveId: string): void {
    const row = this.db.get<{ place_id: string; owner_id: string }>(`SELECT place_id, owner_id FROM saves WHERE id = ?`, [
      saveId,
    ]);
    if (!row) return;
    if (row.owner_id === this.meId) throw new Error('my own saves are deleted through my document');
    this.transaction(() => {
      this.db.run(`DELETE FROM saves WHERE id = ?`, [saveId]);
      this.refreshSearchText([row.place_id]);
    });
  }

  // ---------------------------------------------------------------- reads

  getSave(id: string): SaveRecord | null {
    const r = this.db.get<SaveRow>(`SELECT ${SAVE_COLUMNS} FROM saves s WHERE s.id = ?`, [id]);
    return r ? rowToSave(r) : null;
  }

  /** The place as this save's owner describes it (my document for my saves, their pack for a friend's). */
  savePlaceSnapshot(saveId: string): SavePlaceSnapshot | null {
    const r = this.db.get<{ place_snapshot: string | null }>(`SELECT place_snapshot FROM saves WHERE id = ?`, [saveId]);
    return json<SavePlaceSnapshot>(r?.place_snapshot ?? null);
  }

  getMySaveForPlace(placeId: string): SaveRecord | null {
    const r = this.db.get<SaveRow>(`SELECT ${SAVE_COLUMNS} FROM saves s WHERE s.owner_id = ? AND s.place_id = ?`, [
      this.meId,
      placeId,
    ]);
    return r ? rowToSave(r) : null;
  }

  /** Every save on a place visible to me (mine first, then friends by date). */
  savesForPlace(placeId: string): SaveRecord[] {
    return this.db
      .all<SaveRow>(
        `SELECT ${SAVE_COLUMNS} FROM saves s WHERE s.place_id = ? AND s.deleted_at IS NULL
         ORDER BY (s.owner_id = ?) DESC, s.updated_at DESC`,
        [placeId, this.meId],
      )
      .map(rowToSave);
  }

  /** My saves in the trash, most recently deleted first. */
  trash(): SaveRecord[] {
    return this.db
      .all<SaveRow>(
        `SELECT ${SAVE_COLUMNS} FROM saves s WHERE s.owner_id = ? AND s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC, s.id`,
        [this.meId],
      )
      .map(rowToSave);
  }

  getMedia(saveId: string): MediaRecord[] {
    return this.db
      .all(`SELECT * FROM media WHERE save_id = ? ORDER BY created_at, id`, [saveId])
      .map((r) => ({
        id: r.id as string,
        saveId: r.save_id as string,
        file: r.file as string,
        blurhash: r.blurhash as string | null,
        width: r.width as number | null,
        height: r.height as number | null,
        createdAt: r.created_at as number,
      }));
  }

  /** My tags, including the ones in the trash (`deletedAt`) and inactive sub-tags. */
  tags(): (TagRecord & { active: boolean })[] {
    return this.db
      .all(`SELECT * FROM tags WHERE owner_id = ? ORDER BY name, id`, [this.meId])
      .map((r) => ({
        id: r.id as string,
        ownerId: r.owner_id as string,
        parentId: r.parent_id as string | null,
        name: r.name as string,
        color: r.color as string | null,
        icon: r.icon as string | null,
        osmCategories: JSON.parse(r.osm_categories as string) as string[],
        deletedAt: r.deleted_at as number | null,
        active: r.active === 1,
      }));
  }

  /**
   * Friends' tags on their live saves (not mine), in save order then tag
   * order. The app groups them by person and name, and maps them to my tags.
   */
  friendTags(): FriendTagRow[] {
    const rows = this.db.all<{ id: string; owner_id: string; place_id: string; their_tags: string | null }>(
      `SELECT id, owner_id, place_id, their_tags FROM saves
       WHERE owner_id <> ? AND deleted_at IS NULL AND their_tags IS NOT NULL AND their_tags <> '[]'
       ORDER BY owner_id, place_id`,
      [this.meId],
    );
    const out: FriendTagRow[] = [];
    for (const r of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.their_tags!);
      } catch {
        continue;
      }
      for (const t of parseTheirTags(parsed)) {
        out.push({ personId: r.owner_id, saveId: r.id, placeId: r.place_id, name: t.name, color: t.color ?? null, icon: t.icon ?? null });
      }
    }
    return out;
  }

  tagMappings(): TagMappingRecord[] {
    return this.db
      .all(`SELECT * FROM tag_mappings ORDER BY person_id, their_tag`)
      .map((r) => ({ personId: r.person_id as string, theirTag: r.their_tag as string, myTagId: r.my_tag_id as string }));
  }

  getList(id: string): ListRecord | null {
    const r = this.db.get(`SELECT * FROM lists WHERE id = ?`, [id]);
    return r ? this.rowToList(r) : null;
  }

  /** My lists (not deleted unless asked). */
  lists(options: { includeDeleted?: boolean } = {}): ListRecord[] {
    return this.db
      .all(
        `SELECT * FROM lists WHERE owner_id = ? ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY name, id`,
        [this.meId],
      )
      .map((r) => this.rowToList(r));
  }

  private rowToList(r: Record<string, SqlValue>): ListRecord {
    return {
      id: r.id as string,
      ownerId: r.owner_id as string,
      name: r.name as string,
      description: r.description as string,
      visibility: r.visibility as ListVisibility,
      linkKey: r.link_key as string | null,
      kind: r.kind as ListKind,
      filter: JSON.parse(r.filter as string) as ListFilter,
      manualItems: JSON.parse(r.manual as string) as string[],
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      deletedAt: r.deleted_at as number | null,
    };
  }

  /** Active tags → parent, for filter evaluation. */
  filterContext(): FilterContext {
    const rows = this.db.all<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM tags WHERE owner_id = ? AND active = 1`,
      [this.meId],
    );
    return { meId: this.meId, tagParents: new Map(rows.map((r) => [r.id, r.parent_id])) };
  }

  /**
   * Evaluates a list in SQL (indexes on saves, save_tags, R*Tree for zones),
   * then tests zone shapes exactly. Returns sorted save ids. Equivalent to
   * `evaluateListPure` (property-tested).
   */
  evaluateList(def: { kind: ListKind; visibility: ListVisibility; filter: ListFilter; manualItems: readonly string[] }): string[] {
    const f = normalizeFilter(def.filter);
    const where: string[] = [`s.owner_id = ?`, `s.deleted_at IS NULL`, `s.sharing <> 'private'`];
    const params: SqlValue[] = [this.meId];
    if (def.visibility === 'public') where.push(`p.status <> 'closed'`);
    if (def.kind === 'manual') {
      where.push(`s.place_id IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(def.manualItems));
      return this.db
        .all<{ id: string }>(
          `SELECT s.id FROM saves s JOIN places p ON p.id = s.place_id WHERE ${where.join(' AND ')} ORDER BY s.id`,
          params,
        )
        .map((r) => r.id);
    }
    if (f.exclude?.length) {
      where.push(`s.place_id NOT IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(f.exclude));
    }
    const crit: string[] = [];
    const critParams: SqlValue[] = [];
    let cte = '';
    const cteParams: SqlValue[] = [];
    if (f.tags?.length) {
      cte = `WITH RECURSIVE wanted (id) AS (
          SELECT id FROM tags WHERE owner_id = ? AND active = 1 AND id IN (SELECT value FROM json_each(?))
          UNION SELECT t.id FROM tags t JOIN wanted w ON t.parent_id = w.id WHERE t.active = 1)`;
      cteParams.push(this.meId, JSON.stringify(f.tags));
      crit.push(`EXISTS (SELECT 1 FROM save_tags st WHERE st.save_id = s.id AND st.tag_id IN (SELECT id FROM wanted))`);
    }
    if (f.categories?.length) {
      crit.push(`p.category IN (SELECT value FROM json_each(?))`);
      critParams.push(JSON.stringify(f.categories));
    }
    if (f.statuses?.length) {
      crit.push(`s.status IN (SELECT value FROM json_each(?))`);
      critParams.push(JSON.stringify(f.statuses));
    }
    if (f.priceLevels?.length) {
      crit.push(`s.price_level IN (SELECT value FROM json_each(?))`);
      critParams.push(JSON.stringify(f.priceLevels));
    }
    if (f.zones?.length) {
      const boxes = f.zones.flatMap((z) => splitBBox(geometryBBox(z.geometry)));
      const sp = spatialClause(this.capabilities, boxes);
      crit.push(sp.sql);
      critParams.push(...sp.params);
    }
    const include = f.include ?? [];
    const critSql = crit.length ? crit.join(' AND ') : '1';
    const sql = `${cte}
      SELECT s.id, p.kind, p.geom, p.lat, p.lon, (s.place_id IN (SELECT value FROM json_each(?))) AS inc
      FROM saves s JOIN places p ON p.id = s.place_id
      WHERE ${where.join(' AND ')} AND ((s.place_id IN (SELECT value FROM json_each(?))) OR (${critSql}))
      ORDER BY s.id`;
    const rows = this.db.all<{ id: string; kind: string; geom: string; lat: number; lon: number; inc: number }>(sql, [
      ...cteParams,
      JSON.stringify(include),
      ...params,
      JSON.stringify(include),
      ...critParams,
    ]);
    if (!f.zones?.length) return rows.map((r) => r.id);
    const zones = f.zones;
    return rows
      .filter((r) => {
        if (r.inc === 1) return true;
        if (r.geom.startsWith('{"type":"Point"')) return zones.some((z) => pointInArea(r, z.geometry));
        const g = JSON.parse(r.geom) as PlaceGeometry;
        return zones.some((z) => geometryIntersectsArea(g, z.geometry));
      })
      .map((r) => r.id);
  }

  /** Save ids currently in one of my lists (materialized, recomputed when stale). */
  listItems(listId: string): string[] {
    return this.transaction(() => {
      const list = this.db.get<{ items_dirty: number; deleted_at: number | null }>(
        `SELECT items_dirty, deleted_at FROM lists WHERE id = ?`,
        [listId],
      );
      if (!list) return [];
      if (list.deleted_at !== null) return [];
      if (list.items_dirty === 1) {
        const def = this.getList(listId)!;
        const ids = this.evaluateList(def);
        this.db.run(`DELETE FROM list_items WHERE list_id = ?`, [listId]);
        for (const id of ids) this.db.run(`INSERT INTO list_items (list_id, save_id) VALUES (?, ?)`, [listId, id]);
        this.db.run(`UPDATE lists SET items_dirty = 0 WHERE id = ?`, [listId]);
        return ids;
      }
      return this.db
        .all<{ save_id: string }>(`SELECT save_id FROM list_items WHERE list_id = ? ORDER BY save_id`, [listId])
        .map((r) => r.save_id);
    });
  }

  /** Lists (mine, not deleted) that contain this save. */
  listsContaining(saveId: string): string[] {
    return this.lists()
      .filter((l) => this.listItems(l.id).includes(saveId))
      .map((l) => l.id);
  }

  /** Does a single save match a filter? (Preview, "why is this place in the list".) */
  saveMatchesList(saveId: string, def: { visibility: ListVisibility; filter: ListFilter }): boolean {
    const save = this.getSave(saveId);
    if (!save) return false;
    const place = this.getPlace(save.placeId)!;
    const ctx = this.filterContext();
    const subject = { save, place };
    if (!isListEligible(subject, def.visibility, ctx)) return false;
    const f = normalizeFilter(def.filter);
    if (f.exclude?.includes(save.placeId)) return false;
    return !!f.include?.includes(save.placeId) || matchesCriteria(subject, f, ctx);
  }

  /**
   * Places for the map and the list view. One row per place (a single pin
   * however many friends saved it), with my save summary and the friends count.
   */
  queryPlaces(q: PlaceQuery = {}): PlaceHit[] {
    const source = q.source ?? 'all';
    const sort: PlaceSort = q.sort ?? (q.text ? 'relevance' : 'recent');
    if (sort === 'distance' && !q.from) throw new Error('sort by distance needs `from`');
    const params: SqlValue[] = [];
    const where: string[] = [];
    let ftsJoin = '';
    const ftsParams: SqlValue[] = [];

    let boxes: BBox[] | null = q.bbox ? splitBBox(q.bbox) : null;
    if (q.within) {
      const wb = geometryBBox(q.within);
      boxes = boxes ? boxes.map((b) => intersectBBox(b, wb)).filter((b): b is BBox => b !== null) : [wb];
      if (boxes.length === 0) return [];
    }
    if (boxes) {
      const sp = spatialClause(this.capabilities, boxes);
      where.push(sp.sql);
      params.push(...sp.params);
    }

    let textActive = false;
    if (q.text !== undefined && tokenize(q.text).length > 0) {
      textActive = true;
      if (this.capabilities.fts5) {
        ftsJoin = `JOIN (SELECT rowid AS fpk, bm25(places_fts) AS rank FROM places_fts WHERE places_fts MATCH ?) fts ON fts.fpk = p.pk`;
        ftsParams.push(ftsMatchQuery(q.text)!);
      } else {
        for (const t of tokenize(q.text).slice(0, 12)) {
          where.push(`instr(' ' || p.search_text, ?) > 0`);
          params.push(` ${t}`);
        }
      }
    }

    const live = `a.deleted_at IS NULL AND a.sharing <> 'private'`;
    const sourceCond =
      source === 'mine' ? `a.owner_id = ?` : source === 'friends' ? `a.owner_id <> ? AND ${live}` : `(a.owner_id = ? OR ${live})`;
    where.push(`EXISTS (SELECT 1 FROM saves a WHERE a.place_id = p.id AND a.deleted_at IS NULL AND ${sourceCond})`);
    params.push(this.meId);

    let order: string;
    const orderParams: SqlValue[] = [];
    switch (sort) {
      case 'name':
        order = `p.name_key, p.id`;
        break;
      case 'distance': {
        const k = Math.cos((q.from!.lat * Math.PI) / 180);
        order = `((p.lat - ?) * (p.lat - ?) + (p.lon - ?) * (p.lon - ?) * ?), p.id`;
        orderParams.push(q.from!.lat, q.from!.lat, q.from!.lon, q.from!.lon, k * k);
        break;
      }
      case 'relevance':
        order = textActive && this.capabilities.fts5 ? `fts.rank, last_at DESC, p.id` : `last_at DESC, p.id`;
        break;
      default:
        order = `last_at DESC, p.id`;
    }

    // With an exact area test the limit applies after filtering in JS.
    const limit = q.within ? -1 : (q.limit ?? -1);
    const offset = q.within ? 0 : (q.offset ?? 0);
    const sql = `
      SELECT p.id, p.name, p.lat, p.lon, p.kind, p.edge, p.category, p.status, p.osm_type, p.osm_id,
        ${q.within ? 'p.geom,' : ''}
        ms.id AS my_id, ms.status AS my_status, ms.sharing AS my_sharing, ms.price_level AS my_price,
        ms.main_tag_id AS my_main, ms.updated_at AS my_updated,
        (SELECT group_concat(tag_id) FROM (SELECT st.tag_id FROM save_tags st JOIN tags t ON t.id = st.tag_id
           WHERE st.save_id = ms.id AND t.active = 1 ORDER BY st.position, t.name, t.id)) AS my_tags,
        (SELECT count(*) FROM saves f WHERE f.place_id = p.id AND f.owner_id <> ? AND f.deleted_at IS NULL
           AND f.sharing <> 'private') AS friends_count,
        (SELECT max(a.updated_at) FROM saves a WHERE a.place_id = p.id AND a.deleted_at IS NULL AND ${sourceCond}) AS last_at
      FROM places p
      ${ftsJoin}
      LEFT JOIN saves ms ON ms.place_id = p.id AND ms.owner_id = ? AND ms.deleted_at IS NULL
      WHERE ${where.length ? where.join(' AND ') : '1'}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`;
    const rows = this.db.all(sql, [
      this.meId,
      this.meId,
      ...ftsParams,
      this.meId,
      ...params,
      ...orderParams,
      limit,
      offset,
    ]);
    let hits = rows;
    if (q.within) {
      const area = q.within;
      hits = rows.filter((r) =>
        r.kind === 'place' && String(r.geom).startsWith('{"type":"Point"')
          ? pointInArea({ lat: r.lat as number, lon: r.lon as number }, area)
          : geometryIntersectsArea(JSON.parse(r.geom as string) as PlaceGeometry, area),
      );
      hits = hits.slice(q.offset ?? 0, q.limit !== undefined ? (q.offset ?? 0) + q.limit : undefined);
    }
    return hits.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      lat: r.lat as number,
      lon: r.lon as number,
      kind: r.kind as PlaceKind,
      edge: r.edge as ZoneEdge,
      category: r.category as string | null,
      status: r.status as PlaceStatus,
      osmType: r.osm_type as PlaceRecord['osmType'],
      osmId: r.osm_id as number | null,
      mine:
        r.my_id == null
          ? null
          : {
              saveId: r.my_id as string,
              status: r.my_status as SaveStatus | null,
              sharing: r.my_sharing as Sharing,
              priceLevel: r.my_price as PriceLevel | null,
              mainTagId: r.my_main as string | null,
              tagIds: r.my_tags ? String(r.my_tags).split(',') : [],
              updatedAt: r.my_updated as number,
            },
      friendsCount: r.friends_count as number,
      lastUpdatedAt: (r.last_at as number | null) ?? 0,
      distanceM: q.from ? haversineM(q.from, { lat: r.lat as number, lon: r.lon as number }) : null,
    }));
  }

  /**
   * Lightweight query for the map layer (T-103): one compact row per pin,
   * without the per-row aggregates of `queryPlaces`. Feed it to a MapLibre
   * GeoJSON source; open the card with `queryPlaces`/`savesForPlace`.
   */
  mapPins(bbox: BBox, source: PlaceSource = 'all'): MapPin[] {
    const sp = spatialClause(this.capabilities, splitBBox(bbox));
    const friendExists = `EXISTS (SELECT 1 FROM saves f WHERE f.place_id = p.id AND f.owner_id <> ? AND f.deleted_at IS NULL AND f.sharing <> 'private')`;
    const cond = source === 'mine' ? 'my_id IS NOT NULL' : source === 'friends' ? 'friends = 1' : '(my_id IS NOT NULL OR friends = 1)';
    return this.db
      .all<{ id: string; lat: number; lon: number; kind: string; status: string; main: string | null; mine: number; friends: number }>(
        `SELECT * FROM (
           SELECT p.id, p.lat, p.lon, p.kind, p.status,
             (SELECT t.id FROM tags t WHERE t.id = ms.main_tag_id AND t.active = 1) AS main,
             (ms.id IS NOT NULL) AS mine, ms.id AS my_id, ${friendExists} AS friends
           FROM places p LEFT JOIN saves ms ON ms.place_id = p.id AND ms.owner_id = ? AND ms.deleted_at IS NULL
           WHERE ${sp.sql}
         ) WHERE ${cond}`,
        [this.meId, this.meId, ...sp.params],
      )
      .map((r) => ({
        id: r.id,
        lat: r.lat,
        lon: r.lon,
        kind: r.kind as PlaceKind,
        status: r.status as PlaceStatus,
        mainTagId: r.main,
        mine: r.mine === 1,
        friends: r.friends === 1,
      }));
  }

  /** Full-text search over the places I or my friends saved. */
  search(text: string, options: Omit<PlaceQuery, 'text'> = {}): PlaceHit[] {
    return this.queryPlaces({ limit: 50, ...options, text });
  }

  /**
   * Places that may be the same as a manually placed point: within
   * `maxDistanceM` (default 30 m) with a similar name (spec "No duplicates").
   * Looks at every cached place, saved or not.
   */
  findDuplicateSuggestions(
    point: { id: string; name: string; lat: number; lon: number },
    options: DedupOptions = {},
  ): DuplicateSuggestion[] {
    const radius = options.maxDistanceM ?? 30;
    const boxes = splitBBox(bboxAround(point, radius * 1.5));
    const sp = spatialClause(this.capabilities, boxes);
    const rows = this.db.all<{ id: string; name: string; lat: number; lon: number }>(
      `SELECT p.id, p.name, p.lat, p.lon FROM places p WHERE ${sp.sql} AND p.id <> ?`,
      [...sp.params, point.id],
    );
    return findDuplicateSuggestions(point, rows, options);
  }

  /** Is anything stored in a bbox at all? Cheap check used by tests and the add screen. */
  countInBBox(b: BBox): number {
    const sp = spatialClause(this.capabilities, splitBBox(b));
    return Number(this.db.get<{ n: number }>(`SELECT count(*) AS n FROM places p WHERE ${sp.sql}`, sp.params)?.n ?? 0);
  }

  /**
   * Canonical dump of everything projected from my document (tests: two
   * devices, or incremental vs. full projection, must produce the same dump).
   */
  dumpOwnData(): string {
    const q = (sql: string, params: SqlValue[] = []) => this.db.all(sql, params);
    return canonicalJson({
      saves: q(
        `SELECT s.id, s.place_id, s.comment, s.comment_visibility, s.status, s.price_level, s.sharing, s.main_tag_id,
           s.created_at, s.updated_at, s.deleted_at FROM saves s WHERE s.owner_id = ? ORDER BY s.id`,
        [this.meId],
      ),
      saveTags: q(
        `SELECT st.save_id, st.tag_id, st.position FROM save_tags st JOIN saves s ON s.id = st.save_id
         WHERE s.owner_id = ? ORDER BY st.save_id, st.tag_id`,
        [this.meId],
      ),
      places: q(
        `SELECT p.id, p.osm_type, p.osm_id, p.name, p.category, p.kind, p.edge, p.geom, p.lat, p.lon, p.search_text
         FROM places p WHERE EXISTS (SELECT 1 FROM saves s WHERE s.place_id = p.id AND s.owner_id = ?) ORDER BY p.id`,
        [this.meId],
      ),
      media: q(
        `SELECT m.* FROM media m JOIN saves s ON s.id = m.save_id WHERE s.owner_id = ? ORDER BY m.id`,
        [this.meId],
      ),
      tags: q(`SELECT * FROM tags WHERE owner_id = ? ORDER BY id`, [this.meId]),
      lists: q(
        `SELECT id, name, description, visibility, link_key, kind, filter, manual, created_at, updated_at, deleted_at
         FROM lists WHERE owner_id = ? ORDER BY id`,
        [this.meId],
      ),
      tagMappings: q(`SELECT * FROM tag_mappings ORDER BY person_id, their_tag`),
    });
  }

  /** Raw access for advanced callers (exports, diagnostics). */
  run(sql: string, params: SqlValue[] = []): RunResult {
    return this.db.run(sql, params);
  }
}

export { bboxIntersects };
