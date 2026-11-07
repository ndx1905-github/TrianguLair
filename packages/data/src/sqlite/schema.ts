// SPDX-License-Identifier: MPL-2.0
/**
 * SQLite schema and migrations (spec "Data model").
 *
 * Versioned with `PRAGMA user_version`; each migration runs in a transaction.
 * Two optional SQLite modules are used when present and replaced by plain
 * indexes otherwise:
 *
 * - R*Tree (`places_rtree`): spatial index on each place's bbox. Present in
 *   better-sqlite3 and in expo-sqlite with `-DSQLITE_ENABLE_RTREE=1`.
 *   Fallback: B-tree index on (min_lat, min_lon).
 * - FTS5 (`places_fts`): full-text search on `places.search_text`, external
 *   content, kept in sync by triggers. Fallback: LIKE on the same column.
 *
 * The capabilities chosen at creation are stored in `meta` so a database keeps
 * its layout; `rebuildIndexes` re-creates them if the SQLite build changes.
 */
import type { SqlDriver } from '../driver/types.ts';

export interface Capabilities {
  rtree: boolean;
  fts5: boolean;
}

function probe(db: SqlDriver, ddl: string, name: string): boolean {
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.${name} USING ${ddl}; DROP TABLE temp.${name};`);
    return true;
  } catch {
    return false;
  }
}

export function detectCapabilities(db: SqlDriver): Capabilities {
  return {
    rtree: probe(db, 'rtree(id, a, b, c, d)', '__probe_rtree'),
    fts5: probe(db, 'fts5(t)', '__probe_fts5'),
  };
}

interface Migration {
  version: number;
  up(db: SqlDriver, caps: Capabilities): void;
}

const V1 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- The Yjs document of my own data, stored as a snapshot followed by
-- incremental updates (appended in the same transaction as the projection, so
-- the document and its projection never disagree after a crash).
CREATE TABLE doc_chunks (
  seq   INTEGER PRIMARY KEY,
  kind  TEXT NOT NULL CHECK (kind IN ('snapshot', 'incremental')),
  bytes BLOB NOT NULL
);

CREATE TABLE people (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL DEFAULT '',
  avatar        TEXT,
  public_key    TEXT,
  read_url      TEXT,
  is_me         INTEGER NOT NULL DEFAULT 0 CHECK (is_me IN (0, 1)),
  i_follow      INTEGER NOT NULL DEFAULT 0 CHECK (i_follow IN (0, 1)),
  follows_me    INTEGER NOT NULL DEFAULT 0 CHECK (follows_me IN (0, 1)),
  request_state TEXT CHECK (request_state IN ('received', 'sent', 'accepted')),
  last_etag     TEXT,
  last_sync     INTEGER
);
CREATE UNIQUE INDEX people_single_me ON people (is_me) WHERE is_me = 1;

CREATE TABLE groups (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE group_members (
  group_id  TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, person_id)
) WITHOUT ROWID;

-- Shared place card: identity and geometry (from saves) + OSM cache.
CREATE TABLE places (
  pk             INTEGER PRIMARY KEY,
  id             TEXT NOT NULL UNIQUE,
  osm_type       TEXT CHECK (osm_type IN ('node', 'way', 'relation')),
  osm_id         INTEGER,
  name           TEXT NOT NULL DEFAULT '',
  name_key       TEXT NOT NULL DEFAULT '',
  category       TEXT,
  kind           TEXT NOT NULL DEFAULT 'place' CHECK (kind IN ('place', 'zone')),
  edge           TEXT NOT NULL DEFAULT 'sharp' CHECK (edge IN ('sharp', 'blurred')),
  geom           TEXT NOT NULL,
  lat            REAL NOT NULL,
  lon            REAL NOT NULL,
  min_lon        REAL NOT NULL,
  min_lat        REAL NOT NULL,
  max_lon        REAL NOT NULL,
  max_lat        REAL NOT NULL,
  address        TEXT,
  opening_hours  TEXT,
  website        TEXT,
  phone          TEXT,
  osm_tags       TEXT,
  photos         TEXT,
  osm_synced_at  INTEGER,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'maybe_closed', 'closed')),
  closed_signals TEXT,
  search_text    TEXT NOT NULL DEFAULT '',
  CHECK ((osm_type IS NULL) = (osm_id IS NULL))
);
CREATE UNIQUE INDEX places_osm ON places (osm_type, osm_id) WHERE osm_type IS NOT NULL;
CREATE INDEX places_category ON places (category);
CREATE INDEX places_name_key ON places (name_key);

-- "I saved this place" (mine and friends' decrypted saves).
CREATE TABLE saves (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  place_id           TEXT NOT NULL REFERENCES places (id),
  comment            TEXT NOT NULL DEFAULT '',
  comment_visibility TEXT NOT NULL DEFAULT 'friends' CHECK (comment_visibility IN ('private', 'friends', 'public')),
  status             TEXT CHECK (status IN ('to_try', 'tried', 'favorite')),
  price_level        INTEGER CHECK (price_level BETWEEN 1 AND 4),
  sharing            TEXT NOT NULL DEFAULT 'friends' CHECK (sharing IN ('private', 'friends')),
  main_tag_id        TEXT,
  -- Friends' saves: their tag names as received (JSON array); mapped through
  -- tag_mappings at display time. NULL for my own saves (they use save_tags).
  their_tags         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  UNIQUE (owner_id, place_id)
);
CREATE INDEX saves_place ON saves (place_id);
CREATE INDEX saves_owner_updated ON saves (owner_id, updated_at);
CREATE INDEX saves_owner_status ON saves (owner_id, status);

-- parent_id is cycle-free (concurrent re-parenting is resolved on projection);
-- active = 0 when the tag or one of its ancestors is in the trash.
CREATE TABLE tags (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  parent_id      TEXT,
  name           TEXT NOT NULL,
  color          TEXT,
  icon           TEXT,
  osm_categories TEXT NOT NULL DEFAULT '[]',
  deleted_at     INTEGER,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE INDEX tags_parent ON tags (parent_id);

CREATE TABLE save_tags (
  save_id  TEXT NOT NULL REFERENCES saves (id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (save_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX save_tags_tag ON save_tags (tag_id, save_id);

CREATE TABLE tag_mappings (
  person_id TEXT NOT NULL,
  their_tag TEXT NOT NULL,
  my_tag_id TEXT NOT NULL,
  PRIMARY KEY (person_id, their_tag)
) WITHOUT ROWID;

CREATE TABLE lists (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility  TEXT NOT NULL DEFAULT 'link' CHECK (visibility IN ('link', 'public')),
  link_key    TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('filter', 'manual')),
  filter      TEXT NOT NULL DEFAULT '{}',
  manual      TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  items_dirty INTEGER NOT NULL DEFAULT 1
);

-- Materialized membership, recomputed lazily when items_dirty = 1.
CREATE TABLE list_items (
  list_id TEXT NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  save_id TEXT NOT NULL REFERENCES saves (id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, save_id)
) WITHOUT ROWID;
CREATE INDEX list_items_save ON list_items (save_id);

-- Who can open what (used later to compute key wraps).
CREATE TABLE access (
  save_id   TEXT REFERENCES saves (id) ON DELETE CASCADE,
  list_id   TEXT REFERENCES lists (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  CHECK ((save_id IS NULL) <> (list_id IS NULL))
);
CREATE UNIQUE INDEX access_save ON access (save_id, person_id) WHERE save_id IS NOT NULL;
CREATE UNIQUE INDEX access_list ON access (list_id, person_id) WHERE list_id IS NOT NULL;
CREATE INDEX access_person ON access (person_id);

CREATE TABLE media (
  id         TEXT PRIMARY KEY,
  save_id    TEXT NOT NULL REFERENCES saves (id) ON DELETE CASCADE,
  file       TEXT NOT NULL,
  blurhash   TEXT,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX media_save ON media (save_id);
`;

const RTREE = `
CREATE VIRTUAL TABLE places_rtree USING rtree (pk, min_lon, max_lon, min_lat, max_lat);
CREATE TRIGGER places_rtree_ai AFTER INSERT ON places BEGIN
  INSERT INTO places_rtree (pk, min_lon, max_lon, min_lat, max_lat)
  VALUES (new.pk, new.min_lon, new.max_lon, new.min_lat, new.max_lat);
END;
CREATE TRIGGER places_rtree_au AFTER UPDATE OF min_lon, max_lon, min_lat, max_lat ON places BEGIN
  UPDATE places_rtree SET min_lon = new.min_lon, max_lon = new.max_lon, min_lat = new.min_lat, max_lat = new.max_lat
  WHERE pk = new.pk;
END;
CREATE TRIGGER places_rtree_ad AFTER DELETE ON places BEGIN
  DELETE FROM places_rtree WHERE pk = old.pk;
END;
INSERT INTO places_rtree (pk, min_lon, max_lon, min_lat, max_lat)
  SELECT pk, min_lon, max_lon, min_lat, max_lat FROM places;
`;

const NO_RTREE = `CREATE INDEX places_bbox ON places (min_lat, min_lon);`;

const FTS = `
CREATE VIRTUAL TABLE places_fts USING fts5 (
  search_text, content = 'places', content_rowid = 'pk', tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER places_fts_ai AFTER INSERT ON places BEGIN
  INSERT INTO places_fts (rowid, search_text) VALUES (new.pk, new.search_text);
END;
CREATE TRIGGER places_fts_au AFTER UPDATE OF search_text ON places BEGIN
  INSERT INTO places_fts (places_fts, rowid, search_text) VALUES ('delete', old.pk, old.search_text);
  INSERT INTO places_fts (rowid, search_text) VALUES (new.pk, new.search_text);
END;
CREATE TRIGGER places_fts_ad AFTER DELETE ON places BEGIN
  INSERT INTO places_fts (places_fts, rowid, search_text) VALUES ('delete', old.pk, old.search_text);
END;
INSERT INTO places_fts (places_fts) VALUES ('rebuild');
`;

/**
 * V2 (T-204 review R-02): the shared place row no longer carries anyone's
 * description by default.
 *
 * - `saves.place_snapshot`: the place as this save's owner describes it
 *   (name, category, kind, edge, geometry; JSON). For my saves it is the
 *   snapshot of my document, for a friend's save the one from their pack.
 *   What I publish comes from mine, never from the shared row.
 * - `places.osm_fields`: which identity fields of the row come from my own
 *   OSM cache (`updatePlaceOsmData`), comma-separated among `name`,
 *   `category`, `geom`. Only those override snapshots. Rows synced before V2
 *   kept all three (the old rule), so they are marked so.
 */
const V2 = `
ALTER TABLE saves ADD COLUMN place_snapshot TEXT;
ALTER TABLE places ADD COLUMN osm_fields TEXT NOT NULL DEFAULT '';
UPDATE places SET osm_fields = 'name,category,geom' WHERE osm_synced_at IS NOT NULL;
`;

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db, caps) {
      db.exec(V1);
      db.exec(caps.rtree ? RTREE : NO_RTREE);
      if (caps.fts5) db.exec(FTS);
      db.run(`INSERT INTO meta (key, value) VALUES ('capabilities', ?)`, [JSON.stringify(caps)]);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(V2);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export interface MigrateOptions {
  /** Force a module off (tests of the fallback paths, or a known-broken build). */
  disable?: readonly (keyof Capabilities)[];
}

/** Brings the database to SCHEMA_VERSION and returns the capabilities in use. */
export function migrate(db: SqlDriver, options: MigrateOptions = {}): Capabilities {
  const current = Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema ${current} is newer than this code (${SCHEMA_VERSION})`);
  }
  let caps: Capabilities;
  if (current === 0) {
    const found = detectCapabilities(db);
    caps = {
      rtree: found.rtree && !options.disable?.includes('rtree'),
      fts5: found.fts5 && !options.disable?.includes('fts5'),
    };
  } else {
    caps = readCapabilities(db);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db, caps);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return caps;
}

export function readCapabilities(db: SqlDriver): Capabilities {
  const row = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'capabilities'`);
  if (!row) throw new Error('database has no capabilities record');
  return JSON.parse(row.value) as Capabilities;
}

/**
 * Re-creates the optional indexes to match `wanted` (e.g. the app was rebuilt
 * with R*Tree enabled). Safe to call at any time; data is not touched.
 */
export function rebuildIndexes(db: SqlDriver, wanted: Capabilities): Capabilities {
  const found = detectCapabilities(db);
  const caps = { rtree: wanted.rtree && found.rtree, fts5: wanted.fts5 && found.fts5 };
  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS places_rtree_ai; DROP TRIGGER IF EXISTS places_rtree_au; DROP TRIGGER IF EXISTS places_rtree_ad;
      DROP TABLE IF EXISTS places_rtree; DROP INDEX IF EXISTS places_bbox;
      DROP TRIGGER IF EXISTS places_fts_ai; DROP TRIGGER IF EXISTS places_fts_au; DROP TRIGGER IF EXISTS places_fts_ad;
      DROP TABLE IF EXISTS places_fts;
    `);
    db.exec(caps.rtree ? RTREE : NO_RTREE);
    if (caps.fts5) db.exec(FTS);
    db.run(`UPDATE meta SET value = ? WHERE key = 'capabilities'`, [JSON.stringify(caps)]);
  });
  return caps;
}
