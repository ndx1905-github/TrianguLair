import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { DataStore, placeIdFromOsm } from '@triangulair/data';

import { listQuery } from '../places/list';
import { buildPin } from '../pins/build';
import { placeFacts, toAppTag } from '../places/model';
import { DEMO_FRIEND, DEMO_PLACES, FIXTURE_SAVED_PLACE, hasAnyData, seedDemoData } from './demo';
import { SqlJsDriver } from './sqljsDriver';
import { TAGS } from '../theme/tags';

const SQL = await initSqlJs();

function openStore(bytes?: Uint8Array, onWrite?: () => void) {
  const driver = new SqlJsDriver(bytes ? new SQL.Database(bytes) : new SQL.Database(), onWrite);
  let n = 0;
  const store = DataStore.open({ driver, meId: 'local-me', actor: 'aa'.repeat(16), newId: () => `id${String(++n).padStart(8, '0')}` });
  return { driver, store };
}

describe('sql.js driver', () => {
  it('runs the data package (fallback indexes: no R*Tree / FTS5 in sql.js)', () => {
    const { store } = openStore();
    expect(store.repo.capabilities).toMatchObject({ rtree: false, fts5: false });
    const tag = store.createTag({ name: 'Pizza', color: '#EF4444' });
    store.putSave({ place: { osm: { type: 'node', id: 42 }, name: 'Da Lucia', category: 'amenity=restaurant', geometry: { type: 'Point', coordinates: [2.36, 48.86] } }, tagIds: [tag] });
    expect(store.repo.mapPins([2.3, 48.8, 2.4, 48.9]).map((p) => p.id)).toEqual(['osm:node/42']);
    expect(store.repo.search('luc').map((h) => h.name)).toEqual(['Da Lucia']);
  });

  it('reports writes once per transaction, and a file round trip keeps the data', () => {
    let writes = 0;
    const { driver, store } = openStore(undefined, () => writes++);
    writes = 0;
    store.createTag({ name: 'Bar' });
    expect(writes).toBe(1);
    const bytes = driver.export();
    const reopened = openStore(bytes).store;
    expect(reopened.repo.tags().map((t) => t.name)).toEqual(['Bar']);
    // The store still works after export (sql.js reopens the database).
    store.createTag({ name: 'Café' });
    expect(store.repo.tags()).toHaveLength(2);
  });

  it('rolls back a failed transaction', () => {
    const { driver } = openStore();
    driver.exec('CREATE TABLE t (x INTEGER)');
    expect(() =>
      driver.transaction(() => {
        driver.run('INSERT INTO t VALUES (?)', [1]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(driver.get<{ n: number }>('SELECT count(*) AS n FROM t')!.n).toBe(0);
    expect(driver.run('INSERT INTO t VALUES (?)', [2]).changes).toBe(1);
  });
});

describe('demo data', () => {
  it('seeds tags, my saves, a friend and OSM-like info once', () => {
    const { store } = openStore();
    expect(hasAnyData(store)).toBe(false);
    expect(seedDemoData(store, { tagName: (id) => TAGS[id].label, fixtures: true, now: 1_700_000_000_000 })).toBe(true);
    expect(seedDemoData(store, { tagName: (id) => TAGS[id].label, fixtures: true })).toBe(false);

    const repo = store.repo;
    expect(repo.tags()).toHaveLength(10);
    const mine = repo.queryPlaces({ source: 'mine', limit: 100 });
    expect(mine).toHaveLength(DEMO_PLACES.filter((p) => p.ownerIsMe).length + 1);
    const friendsOnly = repo.queryPlaces({ source: 'friends', limit: 100 }).filter((h) => !h.mine);
    expect(friendsOnly.map((h) => h.name).sort()).toEqual(DEMO_PLACES.filter((p) => !p.ownerIsMe).map((p) => p.name).sort());
    expect(repo.getPerson(DEMO_FRIEND.id)?.displayName).toBe('Léa');

    const baron = mine.find((h) => h.name === 'Le Baron Rouge')!;
    expect(baron.mine?.status).toBe('favorite');
    expect(repo.getPlace(baron.id)?.osmTags?.happy_hours).toBe('Tu-Fr 17:00-19:00');
    const trattoria = repo.getMySaveForPlace(placeIdFromOsm('node', FIXTURE_SAVED_PLACE.osm.id));
    expect(trattoria?.status).toBe('to_try');
  });

  it('pins: main tag first; friends-only places faded and colored by category', () => {
    const { store } = openStore();
    seedDemoData(store, { tagName: (id) => TAGS[id].label, fixtures: false });
    const repo = store.repo;
    const tags = repo.tags().filter((t) => t.active).map(toAppTag);
    const byId = new Map(tags.map((t) => [t.id, t]));
    const active = new Set(byId.keys());
    const pins = repo.mapPins([2.2, 48.8, 2.5, 48.95]);
    expect(pins).toHaveLength(DEMO_PLACES.length);
    const shakespeare = DEMO_PLACES.find((p) => p.name === 'Shakespeare and Company')!;
    const facts = placeFacts(repo.getPlace(shakespeare.id)!, repo.getMySaveForPlace(shakespeare.id), false, active);
    const pin = buildPin({ facts, match: 'match' }, { tagIds: [], criteria: [] }, tags, byId, false);
    // Main tag (shop, pink) first; the other tags follow.
    expect(pin.colors[0]).toBe(TAGS.shop.color);
    expect(pin.colors).toHaveLength(3);
    expect(pin.faded).toBe(false);
    const greyed = buildPin({ facts, match: 'nomatch' }, { tagIds: ['x'], criteria: [] }, tags, byId, true);
    expect(greyed.greyed).toBe(true);
  });
});

describe('list query', () => {
  it('passes the search text, sort and reference point', () => {
    const from = { lat: 48.86, lon: 2.35 };
    expect(listQuery({ text: '  pizza ', sort: 'name', from })).toMatchObject({ text: 'pizza', sort: 'name', from });
    expect(listQuery({ text: ' ', sort: 'recent', from })).not.toHaveProperty('text');
  });

  it('sorts my places by distance and by name on the demo data', () => {
    const { store } = openStore();
    seedDemoData(store, { tagName: (id) => TAGS[id].label, fixtures: false });
    const louvre = { lat: 48.8606, lon: 2.3376 };
    const byDistance = store.repo.queryPlaces(listQuery({ text: '', sort: 'distance', from: louvre }));
    expect(byDistance[0]!.name).toBe('Musée d’Orsay');
    const byName = store.repo.queryPlaces(listQuery({ text: '', sort: 'name', from: louvre })).map((h) => h.name);
    expect(byName[0]).toBe('Café de Flore');
    expect(store.repo.queryPlaces(listQuery({ text: 'oysters', sort: 'recent', from: louvre })).map((h) => h.name)).toEqual(['Le Baron Rouge']);
  });
});
