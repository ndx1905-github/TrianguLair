// SPDX-License-Identifier: MPL-2.0
/**
 * The shared place row and each save's own description (T-204 review R-02):
 * a friend's data never overwrites a row that someone else's save uses, each
 * save keeps the description its owner gave, and only fields that came from
 * my own OSM cache override snapshots.
 */
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '../src/driver/node.ts';
import { saveIdFor } from '../src/ids.ts';
import { normalizeSnapshot } from '../src/place.ts';
import { migrate, SCHEMA_VERSION } from '../src/sqlite/schema.ts';
import { DataStore } from '../src/store.ts';
import { FRIEND, ME, osmPoint } from './helpers.ts';
import { openRepo, writeMySave } from './fixtures.ts';

const OTHER = 'ed25519:other-friend';
const foreign = (owner: string, id: string, name: string, lat: number, lon: number, extra: Partial<{ kind: 'zone'; edge: 'blurred' }> = {}) => ({
  id: `${owner}:${id}`,
  ownerId: owner,
  place: { ...normalizeSnapshot(osmPoint(Number(id), name, lat, lon)), ...extra },
  createdAt: 1,
  updatedAt: 1,
});

describe('place rows and per-save descriptions', () => {
  it('a friend never changes a place row that one of my saves uses (name, geometry, kind, edge)', () => {
    const repo = openRepo();
    writeMySave(repo, osmPoint(1, 'Chez Lili', 48.85, 2.35));
    repo.upsertForeignSave(foreign(FRIEND, '1', 'RENAMED', 10, 10, { edge: 'blurred' }));
    const p = repo.getPlace('osm:node/1')!;
    expect(p.name).toBe('Chez Lili');
    expect(p.geometry).toEqual({ type: 'Point', coordinates: [2.35, 48.85] });
    expect(p.edge).toBe('sharp');
    // Each save keeps its owner's description.
    expect(repo.savePlaceSnapshot(saveIdFor(ME, 'osm:node/1'))!.name).toBe('Chez Lili');
    expect(repo.savePlaceSnapshot(`${FRIEND}:1`)).toMatchObject({ name: 'RENAMED', edge: 'blurred', geometry: { coordinates: [10, 10] } });
  });

  it('kind and edge are not overwritten by a friend even on an OSM-synced row', () => {
    const repo = openRepo();
    writeMySave(repo, osmPoint(2, 'Mine', 48.85, 2.35));
    repo.updatePlaceOsmData('osm:node/2', { openingHours: 'Mo-Fr 09:00-18:00' });
    repo.upsertForeignSave(foreign(FRIEND, '2', 'Theirs', 48.85, 2.35, { kind: 'zone', edge: 'blurred' }));
    const p = repo.getPlace('osm:node/2')!;
    expect(p.kind).toBe('place');
    expect(p.edge).toBe('sharp');
    expect(p.name).toBe('Mine');
  });

  it('a friend cannot change a row that another friend\'s save uses; a row only theirs follows their edits', () => {
    const repo = openRepo();
    repo.upsertForeignSave(foreign(FRIEND, '3', 'First', 48.85, 2.35));
    repo.upsertForeignSave(foreign(FRIEND, '3', 'First, edited', 48.85, 2.35));
    expect(repo.getPlace('osm:node/3')!.name).toBe('First, edited');
    repo.upsertForeignSave(foreign(OTHER, '3', 'Second', 1, 1));
    expect(repo.getPlace('osm:node/3')!.name).toBe('First, edited');
    repo.upsertForeignSave(foreign(FRIEND, '3', 'First, again', 48.85, 2.35));
    expect(repo.getPlace('osm:node/3')!.name).toBe('First, edited');
    // My own save takes the row over.
    writeMySave(repo, osmPoint(3, 'My name', 48.851, 2.351));
    expect(repo.getPlace('osm:node/3')!.name).toBe('My name');
  });

  it('only the identity fields my own OSM cache provided override snapshots', () => {
    const repo = openRepo();
    repo.upsertForeignSave(foreign(FRIEND, '4', 'Friend name', 48.85, 2.35));
    // An OSM refresh without a name (opening hours only) must not freeze the friend's name.
    repo.updatePlaceOsmData('osm:node/4', { openingHours: '24/7' });
    writeMySave(repo, osmPoint(4, 'My name', 48.85, 2.35));
    expect(repo.getPlace('osm:node/4')!.name).toBe('My name');
    // Once OSM gave a name, it wins over every snapshot.
    repo.updatePlaceOsmData('osm:node/4', { name: 'OSM name' });
    writeMySave(repo, osmPoint(4, 'My other name', 48.85, 2.35));
    expect(repo.getPlace('osm:node/4')!.name).toBe('OSM name');
    expect(repo.savePlaceSnapshot(saveIdFor(ME, 'osm:node/4'))!.name).toBe('My other name');
  });

  it('migration 2 keeps the old "OSM wins" rule for rows synced before it', () => {
    const db = new NodeSqliteDriver();
    migrate(db);
    expect(SCHEMA_VERSION).toBe(3);
    // Back to a version-1 database with one OSM-synced row and one that is not.
    db.exec(`ALTER TABLE saves DROP COLUMN place_snapshot; ALTER TABLE places DROP COLUMN osm_fields;
      ALTER TABLE media DROP COLUMN thumb; ALTER TABLE media DROP COLUMN mime; ALTER TABLE media DROP COLUMN bytes;
      ALTER TABLE media DROP COLUMN upload; PRAGMA user_version = 1`);
    const ins = `INSERT INTO places (id, osm_type, osm_id, name, geom, lat, lon, min_lon, min_lat, max_lon, max_lat, osm_synced_at)
      VALUES (?, 'node', ?, 'x', '{"type":"Point","coordinates":[0,0]}', 0, 0, 0, 0, 0, 0, ?)`;
    db.run(ins, ['osm:node/1', 1, 123]);
    db.run(ins, ['osm:node/2', 2, null]);
    migrate(db);
    expect(db.all<{ name: string }>(`PRAGMA table_info(saves)`).map((c) => c.name)).toContain('place_snapshot');
    expect(db.all<{ name: string }>(`PRAGMA table_info(media)`).map((c) => c.name)).toEqual(expect.arrayContaining(['thumb', 'mime', 'bytes', 'upload']));
    expect(db.all<{ id: string; f: string }>(`SELECT id, osm_fields AS f FROM places ORDER BY id`)).toEqual([
      { id: 'osm:node/1', f: 'name,category,geom' },
      { id: 'osm:node/2', f: '' },
    ]);
  });
});

describe('DataStore.wipe', () => {
  it('erases every row and closes the store', () => {
    const driver = new NodeSqliteDriver(':memory:');
    const store = DataStore.open({ driver, meId: ME, actor: 'a' });
    store.putSave({ place: osmPoint(1, 'Secret place', 48.85, 2.35), comment: 'private note' });
    store.repo.upsertForeignSave(foreign(FRIEND, '2', 'Friend place', 48.86, 2.36));
    store.createTag({ name: 'Pizza' });
    const count = (t: string) => driver.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n;
    expect(count('saves')).toBe(2);
    // Read the table list before closing.
    const tables = driver
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('saves','places','tags','people','doc_chunks','meta')`)
      .map((r) => r.name);
    const counts: Record<string, number> = {};
    const spy = driver.close.bind(driver);
    driver.close = () => {
      for (const t of tables) counts[t] = count(t);
      counts.metaKeys = driver.all<{ key: string }>(`SELECT key FROM meta`).filter((r) => r.key !== 'capabilities').length;
      spy();
    };
    store.wipe();
    expect(counts).toEqual({ saves: 0, places: 0, tags: 0, people: 0, doc_chunks: 0, meta: 1, metaKeys: 0 });
  });
});
