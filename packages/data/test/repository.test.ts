import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '../src/driver/node.ts';
import { saveIdFor } from '../src/ids.ts';
import { normalizeSnapshot } from '../src/place.ts';
import { Repository } from '../src/sqlite/repository.ts';
import { migrate, rebuildIndexes, readCapabilities, SCHEMA_VERSION } from '../src/sqlite/schema.ts';
import { FRIEND, ME, localPoint, osmPoint, rect } from './helpers.ts';
import { ALL_MODES, openRepo, tagRec, writeMySave } from './fixtures.ts';

describe('schema and migrations', () => {
  it('creates every table from the data model, idempotently', () => {
    const db = new NodeSqliteDriver();
    const caps = migrate(db);
    expect(caps).toEqual({ rtree: true, fts5: true });
    expect(migrate(db)).toEqual(caps);
    const tables = db
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .map((r) => r.name);
    for (const t of [
      'people', 'groups', 'group_members', 'places', 'saves', 'tags', 'save_tags', 'tag_mappings', 'lists',
      'list_items', 'access', 'media', 'places_rtree', 'places_fts', 'doc_chunks', 'meta',
    ]) {
      expect(tables).toContain(t);
    }
    expect(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION);
  });

  it('falls back to plain indexes without R*Tree / FTS5, and can upgrade later', () => {
    const db = new NodeSqliteDriver();
    expect(migrate(db, { disable: ['rtree', 'fts5'] })).toEqual({ rtree: false, fts5: false });
    const names = () => db.all<{ name: string }>(`SELECT name FROM sqlite_master`).map((r) => r.name);
    expect(names()).not.toContain('places_rtree');
    expect(names()).toContain('places_bbox');
    // Reopening keeps the layout chosen at creation.
    expect(migrate(db)).toEqual({ rtree: false, fts5: false });
    expect(rebuildIndexes(db, { rtree: true, fts5: true })).toEqual({ rtree: true, fts5: true });
    expect(readCapabilities(db)).toEqual({ rtree: true, fts5: true });
    expect(names()).toContain('places_rtree');
  });

  it('refuses a database from a newer version', () => {
    const db = new NodeSqliteDriver();
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer/);
  });

  it('a database belongs to one identity', () => {
    const db = new NodeSqliteDriver();
    Repository.open(db, { meId: ME });
    expect(() => Repository.open(db, { meId: 'ed25519:someone-else' })).toThrow(/belongs/);
  });

  it('rebuildIndexes repopulates indexes from existing rows', () => {
    const db = new NodeSqliteDriver();
    const repo = Repository.open(db, { meId: ME, disable: ['rtree', 'fts5'] });
    writeMySave(repo, osmPoint(1, 'Chez Paul', 48.85, 2.35));
    rebuildIndexes(db, { rtree: true, fts5: true });
    const repo2 = Repository.open(db, { meId: ME });
    expect(repo2.capabilities).toEqual({ rtree: true, fts5: true });
    expect(repo2.queryPlaces({ bbox: [2, 48, 3, 49] }).length).toBe(1);
    expect(repo2.search('paul').length).toBe(1);
  });
});

describe.each(ALL_MODES)('queries ($name)', ({ disable }) => {
  function seed() {
    const repo = openRepo(disable);
    repo.writeOwnTags([tagRec('t-food', 'Food'), tagRec('t-pizza', 'Pizza napolitaine', 't-food')]);
    writeMySave(repo, osmPoint(1, 'Pizzeria Napoli', 48.8500, 2.3500), { tagIds: ['t-pizza'], updatedAt: 10, comment: 'Pâte légère' });
    writeMySave(repo, osmPoint(2, 'Café de Flore', 48.8541, 2.3326, 'amenity=cafe'), { updatedAt: 30 });
    writeMySave(repo, osmPoint(3, 'Musée Rodin', 48.8553, 2.3158, 'tourism=museum'), { updatedAt: 20, deletedAt: 25 });
    writeMySave(repo, osmPoint(4, 'Le Perchoir', 48.8612, 2.3811, 'amenity=bar'), { updatedAt: 5 });
    writeMySave(repo, osmPoint(5, 'Sunset bar', -16.5, 179.9, 'amenity=bar'), { updatedAt: 1 }); // Fiji, east of the antimeridian
    repo.upsertForeignSave({
      id: 'f1', ownerId: FRIEND, place: normalizeSnapshot(osmPoint(4, 'Le Perchoir', 48.8612, 2.3811, 'amenity=bar')),
      comment: 'Rooftop', createdAt: 40, updatedAt: 40,
    });
    repo.upsertForeignSave({
      id: 'f2', ownerId: FRIEND,
      place: { id: 'osm:node/6', osmType: 'node', osmId: 6, name: 'Buttes-Chaumont', category: 'leisure=park', kind: 'place', edge: 'sharp', geometry: { type: 'Point', coordinates: [2.3828, 48.8809] } },
      createdAt: 50, updatedAt: 50,
    });
    // A zone (street segment) crossing the box below without a vertex in it.
    writeMySave(repo, { id: 'local:zonestreet', name: 'Rue des Martyrs', kind: 'zone', geometry: { type: 'LineString', coordinates: [[2.30, 48.70], [2.30, 48.75]] } }, { updatedAt: 3 });
    return repo;
  }

  const paris: [number, number, number, number] = [2.2, 48.8, 2.45, 48.9];

  it('bbox: one row per place, mine and friends, trash excluded', () => {
    const repo = seed();
    const hits = repo.queryPlaces({ bbox: paris });
    expect(hits.map((h) => h.id)).toEqual(['osm:node/6', 'osm:node/4', 'osm:node/2', 'osm:node/1']);
    const perchoir = hits.find((h) => h.id === 'osm:node/4')!;
    expect(perchoir.friendsCount).toBe(1);
    expect(perchoir.mine?.saveId).toBe(saveIdFor(ME, 'osm:node/4'));
    expect(perchoir.lastUpdatedAt).toBe(40);
    expect(hits.find((h) => h.id === 'osm:node/6')!.mine).toBeNull();
  });

  it('map pins agree with queryPlaces', () => {
    const repo = seed();
    for (const source of ['all', 'mine', 'friends'] as const) {
      const pins = repo.mapPins(paris, source);
      expect(pins.map((p) => p.id).sort()).toEqual(repo.queryPlaces({ bbox: paris, source }).map((h) => h.id).sort());
    }
    const pins = Object.fromEntries(repo.mapPins(paris).map((p) => [p.id, p]));
    expect(pins['osm:node/1']).toMatchObject({ mine: true, friends: false, mainTagId: 't-pizza', kind: 'place' });
    expect(pins['osm:node/4']).toMatchObject({ mine: true, friends: true });
    expect(pins['osm:node/6']).toMatchObject({ mine: false, friends: true, mainTagId: null });
    expect(repo.mapPins([179, -17, -179, -16]).map((p) => p.id)).toEqual(['osm:node/5']);
  });

  it('source filter: mine / friends', () => {
    const repo = seed();
    expect(repo.queryPlaces({ bbox: paris, source: 'mine' }).map((h) => h.id).sort()).toEqual(['osm:node/1', 'osm:node/2', 'osm:node/4']);
    expect(repo.queryPlaces({ bbox: paris, source: 'friends' }).map((h) => h.id).sort()).toEqual(['osm:node/4', 'osm:node/6']);
  });

  it('bbox across the antimeridian', () => {
    const repo = seed();
    expect(repo.queryPlaces({ bbox: [179, -17, -179, -16] }).map((h) => h.id)).toEqual(['osm:node/5']);
    expect(repo.queryPlaces({ bbox: [-179, -17, 179, -16] }).map((h) => h.id)).toEqual([]); // the rest of the world
  });

  it('within a polygon: exact test after the index, lines crossing count', () => {
    const repo = seed();
    const box = rect(2.33, 48.84, 2.36, 48.86);
    expect(repo.queryPlaces({ within: box }).map((h) => h.id).sort()).toEqual(['osm:node/1', 'osm:node/2']);
    const triangle = { type: 'Polygon' as const, coordinates: [[[2.33, 48.84], [2.36, 48.84], [2.36, 48.86], [2.33, 48.84]]] };
    expect(repo.queryPlaces({ within: triangle }).map((h) => h.id)).toEqual(['osm:node/1']);
    expect(repo.queryPlaces({ within: rect(2.2, 48.72, 2.4, 48.73) }).map((h) => h.id)).toEqual(['local:zonestreet']);
  });

  it('sorts by recent, name, distance', () => {
    const repo = seed();
    expect(repo.queryPlaces({ bbox: paris, sort: 'name' }).map((h) => h.name)).toEqual([
      'Buttes-Chaumont', 'Café de Flore', 'Le Perchoir', 'Pizzeria Napoli',
    ]);
    const near = repo.queryPlaces({ bbox: paris, sort: 'distance', from: { lat: 48.8613, lon: 2.381 } });
    expect(near[0]!.id).toBe('osm:node/4');
    expect(near[0]!.distanceM!).toBeLessThan(20);
    const ds = near.map((h) => h.distanceM!);
    expect([...ds].sort((a, b) => a - b)).toEqual(ds);
    expect(repo.queryPlaces({ bbox: paris, limit: 2, offset: 1 }).map((h) => h.id)).toEqual(['osm:node/4', 'osm:node/2']);
  });

  it('full-text search: accents, prefixes, comments, tag names, friends comments', () => {
    const repo = seed();
    const ids = (q: string) => repo.search(q).map((h) => h.id).sort();
    expect(ids('cafe flo')).toEqual(['osm:node/2']);
    expect(ids('CAFÉ')).toEqual(['osm:node/2']);
    expect(ids('pate legere')).toEqual(['osm:node/1']); // my comment
    expect(ids('napolitaine')).toEqual(['osm:node/1']); // my tag name
    expect(ids('rooftop')).toEqual(['osm:node/4']); // a friend's comment
    expect(ids('museum')).toEqual([]); // in the trash
    expect(ids('bar')).toEqual(['osm:node/4', 'osm:node/5']); // category
    expect(ids('')).toHaveLength(6);
    expect(ids('"; DROP TABLE places; --')).toEqual([]);
  });

  it('tag rename and deletion update search text', () => {
    const repo = seed();
    repo.writeOwnTags([tagRec('t-food', 'Food'), tagRec('t-pizza', 'Pizza al taglio', 't-food')]);
    expect(repo.search('taglio').map((h) => h.id)).toEqual(['osm:node/1']);
    expect(repo.search('napolitaine')).toEqual([]);
    repo.writeOwnTags([tagRec('t-food', 'Food', null, { deletedAt: 1, active: false }), tagRec('t-pizza', 'Pizza al taglio', 't-food', { active: false })]);
    expect(repo.search('taglio')).toEqual([]);
    expect(repo.getSave(saveIdFor(ME, 'osm:node/1'))!.tagIds).toEqual([]); // inactive tags hidden
  });

  it('OSM cache wins over snapshots once synced', () => {
    const repo = seed();
    repo.updatePlaceOsmData('osm:node/2', { name: 'Café de Flore (Saint-Germain)', openingHours: 'Mo-Su 07:30-01:30', status: 'open' });
    writeMySave(repo, osmPoint(2, 'Old name', 48.8541, 2.3326, 'amenity=cafe'));
    const p = repo.getPlace('osm:node/2')!;
    expect(p.name).toBe('Café de Flore (Saint-Germain)');
    expect(p.openingHours).toBe('Mo-Su 07:30-01:30');
    expect(repo.search('saint germain').map((h) => h.id)).toEqual(['osm:node/2']);
  });

  it('friends: deletion marker and removing a person', () => {
    const repo = seed();
    repo.deleteForeignSave('f2');
    expect(repo.queryPlaces({ bbox: paris, source: 'friends' }).map((h) => h.id)).toEqual(['osm:node/4']);
    repo.removePerson(FRIEND);
    expect(repo.queryPlaces({ bbox: paris, source: 'friends' })).toEqual([]);
    expect(repo.search('rooftop')).toEqual([]);
    expect(repo.pruneOrphanPlaces()).toBe(1); // node/6
    expect(() => repo.upsertForeignSave({ id: 'x', ownerId: ME, place: null as never, createdAt: 0, updatedAt: 0 })).toThrow();
  });

  it('duplicate suggestions use the spatial index', () => {
    const repo = seed();
    writeMySave(repo, localPoint('manual01', 'Pizzeria Napoli', 48.85015, 2.35));
    const out = repo.findDuplicateSuggestions({ id: 'local:manual01', name: 'Pizzeria Napoli', lat: 48.85015, lon: 2.35 });
    expect(out.map((s) => s.id)).toEqual(['osm:node/1']);
    expect(out[0]!.distanceM).toBeLessThan(30);
  });

  it('people stub', () => {
    const repo = seed();
    repo.upsertPerson({ id: FRIEND, displayName: 'Alex', iFollow: true, requestState: 'accepted' });
    expect(repo.getPerson(FRIEND)).toMatchObject({ displayName: 'Alex', iFollow: true, followsMe: false, isMe: false });
    expect(repo.getPerson(ME)!.isMe).toBe(true);
  });
});
