/**
 * Performance on the reference volume (spec "Performance targets": 10,000
 * personal places). Targets checked here, on Node + better-sqlite3:
 *
 * - bbox query of a map viewport: under 100 ms ("applying a filter in under
 *   100 ms", "Map displayed with its places in under 2 s")
 * - local text search: under 300 ms
 * - list filter evaluation: under 100 ms
 *
 * Timings are the median of several runs and are printed (see README).
 * Set PERF_REPORT=1 to print the table.
 */
import * as A from '@automerge/automerge';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import { NodeSqliteDriver } from '../src/driver/node.ts';
import { DataStore } from '../src/store.ts';
import type { BBox, SaveStatus } from '../src/types.ts';
import { hexActor, ME, seqIds } from './helpers.ts';

const N = 10_000;

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'pizzeria', 'trattoria', 'café', 'bistrot', 'boulangerie', 'brasserie', 'musée', 'galerie', 'librairie',
  'jardin', 'parc', 'bar', 'cave', 'fromagerie', 'marché', 'crêperie', 'ramen', 'sushi', 'tacos', 'kebab',
  'napoli', 'roma', 'lisboa', 'tokyo', 'chez', 'paul', 'marie', 'du', 'coin', 'petit', 'grand', 'vieux',
  'soleil', 'lune', 'étoile', 'rouge', 'bleu', 'vert', 'or', 'argent',
];
const CATEGORIES = ['amenity=restaurant', 'amenity=cafe', 'amenity=bar', 'shop=books', 'tourism=museum', 'leisure=park'];
const STATUSES: (SaveStatus | null)[] = [null, 'to_try', 'tried', 'favorite'];

const timings: Record<string, number> = {};

function median(fn: () => unknown, runs = 7): number {
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)]!;
}

function once<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  timings[name] = performance.now() - t0;
  return out;
}

// Paris viewport at street level (~4 km × 2.5 km) and the whole of Paris.
const VIEWPORT: BBox = [2.32, 48.85, 2.37, 48.872];
const PARIS: BBox = [2.22, 48.81, 2.47, 48.91];
const PARIS_SHAPE: Polygon = {
  type: 'Polygon',
  coordinates: [[[2.25, 48.83], [2.33, 48.815], [2.42, 48.83], [2.45, 48.86], [2.4, 48.9], [2.3, 48.9], [2.24, 48.87], [2.25, 48.83]]],
};

describe.each([
  { name: 'rtree+fts5', disable: [] as ('rtree' | 'fts5')[] },
  { name: 'fallback', disable: ['rtree', 'fts5'] as ('rtree' | 'fts5')[] },
])(`performance with ${N} places ($name)`, ({ name, disable }) => {
  let store: DataStore;
  let pizzaTag = '';
  const key = (k: string) => `${name}: ${k}`;
  const dir = mkdtempSync(join(tmpdir(), 'triangulair-perf-'));
  const file = join(dir, 'perf.db');

  beforeAll(() => {
    const rand = rng(42);
    store = DataStore.open({
      driver: new NodeSqliteDriver(file),
      meId: ME,
      actor: hexActor(1),
      newId: seqIds('id'),
      now: (() => {
        let t = 1_700_000_000_000;
        return () => (t += 1000);
      })(),
      disable,
    });
    const tags: string[] = [];
    store.change((tx) => {
      const parents = ['Food', 'Drinks', 'Culture', 'Shops', 'Outdoors'].map((n) => tx.createTag({ name: n }));
      tags.push(...parents);
      for (let i = 0; i < 15; i++) tags.push(tx.createTag({ name: `Sub ${i}`, parentId: parents[i % 5]! }));
    });
    pizzaTag = tags[0]!; // "Food" and its sub-tags
    const BATCH = 500;
    once(key(`import 10k saves (${N / BATCH} changes of ${BATCH}, with projection)`), () => {
      for (let b = 0; b < N / BATCH; b++) {
        store.change((tx) => {
        for (let i = b * BATCH + 1; i <= (b + 1) * BATCH; i++) {
          const inParis = rand() < 0.6;
          const lat = inParis ? 48.81 + rand() * 0.1 : 43 + rand() * 7;
          const lon = inParis ? 2.22 + rand() * 0.25 : -1.5 + rand() * 9;
          const name = Array.from({ length: 2 + Math.floor(rand() * 2) }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ');
          const zone = rand() < 0.02;
          const nTags = 1 + Math.floor(rand() * 3);
          tx.putSave({
            place: zone
              ? { id: `local:zone${i.toString().padStart(6, '0')}`, name, kind: 'zone', geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + 0.004, lat], [lon + 0.004, lat + 0.003], [lon, lat + 0.003], [lon, lat]]] } }
              : { osm: { type: 'node', id: i }, name, category: CATEGORIES[i % CATEGORIES.length]!, geometry: { type: 'Point', coordinates: [lon, lat] } },
            comment: rand() < 0.3 ? `${WORDS[Math.floor(rand() * WORDS.length)]} vraiment bien` : '',
            status: STATUSES[Math.floor(rand() * 4)]!,
            sharing: rand() < 0.1 ? 'private' : 'friends',
            tagIds: Array.from({ length: nTags }, () => tags[Math.floor(rand() * tags.length)]!),
          });
          if (rand() < 0.05) tx.deleteSave(zone ? `local:zone${i.toString().padStart(6, '0')}` : `osm:node/${i}`);
        }
        });
      }
    });
    store.compact();
  });

  afterAll(() => {
    if (process.env.PERF_REPORT) {
      process.stdout.write(`\n${Object.entries(timings).filter(([k]) => k.startsWith(name)).map(([k, v]) => `${k.padEnd(70)} ${v.toFixed(1).padStart(8)} ms`).join('\n')}\n`);
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('cold open of the 10k database + first viewport query (document not loaded)', () => {
    const t0 = performance.now();
    const again = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, disable });
    const hits = again.repo.queryPlaces({ bbox: VIEWPORT });
    const t = performance.now() - t0;
    timings[key('cold open + first viewport query')] = t;
    expect(again.docLoaded).toBe(false);
    expect(hits.length).toBeGreaterThan(200);
    expect(t).toBeLessThan(500);
    const t1 = performance.now();
    void again.doc;
    timings[key('lazy document load (snapshot)')] = performance.now() - t1;
    again.repo.db.close();
  });

  it('bbox query of a street-level viewport < 100 ms', () => {
    const hits = store.repo.queryPlaces({ bbox: VIEWPORT });
    expect(hits.length).toBeGreaterThan(200);
    const t = median(() => store.repo.queryPlaces({ bbox: VIEWPORT }));
    timings[key(`bbox viewport (${hits.length} places)`)] = t;
    expect(t).toBeLessThan(100);
  });

  it('bbox query of all of Paris (≈6,000 pins) < 100 ms', () => {
    const hits = store.repo.queryPlaces({ bbox: PARIS });
    expect(hits.length).toBeGreaterThan(5000);
    const t = median(() => store.repo.queryPlaces({ bbox: PARIS }), 5);
    timings[key(`bbox Paris (${hits.length} places)`)] = t;
    expect(t).toBeLessThan(100);
  });

  it('map pins of all of Paris (compact rows for the map layer) < 100 ms', () => {
    const pins = store.repo.mapPins(PARIS);
    expect(pins.length).toBeGreaterThan(5000);
    const t = median(() => store.repo.mapPins(PARIS), 5);
    timings[key(`map pins Paris (${pins.length} pins)`)] = t;
    expect(t).toBeLessThan(100);
  });

  it('all places, sorted by distance (list view) < 300 ms', () => {
    const t = median(() => store.repo.queryPlaces({ sort: 'distance', from: { lat: 48.86, lon: 2.35 }, limit: 100 }), 5);
    timings[key('list view: nearest 100 of all, by distance')] = t;
    expect(t).toBeLessThan(300);
  });

  it('polygon query (exact test) < 100 ms', () => {
    const hits = store.repo.queryPlaces({ within: PARIS_SHAPE });
    expect(hits.length).toBeGreaterThan(3000);
    const t = median(() => store.repo.queryPlaces({ within: PARIS_SHAPE }), 5);
    timings[key(`polygon (${hits.length} places)`)] = t;
    expect(t).toBeLessThan(100);
  });

  it('text search < 300 ms', () => {
    for (const q of ['pizz', 'cafe soleil', 'vraiment', 'sub 3']) {
      const hits = store.repo.search(q);
      expect(hits.length).toBeGreaterThan(0);
      const t = median(() => store.repo.search(q));
      timings[key(`search "${q}" (top 50)`)] = t;
      expect(t).toBeLessThan(300);
    }
  });

  it('list filter evaluation < 100 ms', () => {
    const list = store.createList({
      name: 'Food in Paris',
      kind: 'filter',
      filter: { tags: [pizzaTag], statuses: ['tried', 'favorite'], zones: [{ kind: 'drawn', geometry: PARIS_SHAPE }] },
    });
    const def = store.repo.getList(list)!;
    const ids = store.repo.evaluateList(def);
    expect(ids.length).toBeGreaterThan(300);
    timings[key(`list filter: tag tree + statuses + zone (${ids.length} saves)`)] = median(() => store.repo.evaluateList(def));
    expect(timings[key(`list filter: tag tree + statuses + zone (${ids.length} saves)`)]).toBeLessThan(100);
    const broad = { ...def, filter: { tags: [pizzaTag] } };
    const n = store.repo.evaluateList(broad).length;
    timings[key(`list filter: tag tree only (${n} saves)`)] = median(() => store.repo.evaluateList(broad));
    expect(timings[key(`list filter: tag tree only (${n} saves)`)]).toBeLessThan(100);
    store.repo.markListsDirty();
    timings[key('list items: recompute and materialize')] = median(() => {
      store.repo.markListsDirty();
      store.repo.listItems(list);
    }, 3);
    timings[key('list items: read materialized')] = median(() => store.repo.listItems(list));
    expect(timings[key('list items: read materialized')]).toBeLessThan(100);
  });

  it('single edit (one change + incremental projection)', () => {
    let i = 0;
    const t = median(() => store.updateSave(`osm:node/${(i++ % 50) + 1}`, { comment: `edit ${i}` }), 9);
    timings[key('single edit')] = t;
    expect(t).toBeLessThan(100);
  });

  it('document: size, load, full projection', () => {
    const bytes = once(key('document save()'), () => A.save(store.doc));
    timings[key(`document size (KB) = ${(bytes.byteLength / 1024).toFixed(0)}`)] = 0;
    const doc = once(key('document load()'), () => A.load<{ saves: object }>(bytes));
    expect(Object.keys(doc.saves).length).toBe(N);
    const fresh = DataStore.open({ driver: new NodeSqliteDriver(':memory:'), meId: ME, disable });
    once(key('new device: merge the 10k document + full projection'), () => fresh.merge(bytes));
    expect(fresh.repo.dumpOwnData()).toBe(store.repo.dumpOwnData());
    fresh.close();
  });
});
