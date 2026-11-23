// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';

import {
  applyImport,
  buildPlan,
  matchPlaces,
  readImportFile,
  setMergeExisting,
  setTagAction,
  undoImport,
  type ImportedPlace,
  type ParseResult,
} from '../src/index.ts';
import { fixtureBytes, fixtureLookup, openStore } from './helpers.ts';

const noYield = () => Promise.resolve();

function parse(rel: string): ParseResult {
  const o = readImportFile({ name: rel.split('/').pop()!, bytes: fixtureBytes(rel) });
  if (o.kind !== 'parsed') throw new Error(o.kind);
  return o.result;
}

function many(n: number): ParseResult {
  const places: ImportedPlace[] = [];
  for (let i = 0; i < n; i++) {
    places.push({ key: `p${i}`, name: `Place ${i}`, lat: 45 + (i % 100) * 0.01, lon: 4 + Math.floor(i / 100) * 0.01, tags: [i % 2 ? 'Odd' : 'Even'], ids: {} });
  }
  return { format: 'csv', places, tags: [], warnings: [] };
}

describe('applyImport', () => {
  it('writes in batches of 200 by default, reports progress', async () => {
    const store = openStore();
    const r = many(450);
    const plan = buildPlan(r, await matchPlaces(r.places, null), store.repo);
    let changes = 0;
    const orig = store.change.bind(store);
    store.change = ((fn, m) => {
      changes++;
      return orig(fn, m);
    }) as typeof store.change;
    const progress: number[] = [];
    const report = await applyImport(store, plan, { onProgress: (w) => progress.push(w), yieldFn: noYield });
    // 1 change for the tags + 3 batches (200, 200, 50).
    expect(changes).toBe(4);
    expect(progress).toEqual([0, 200, 400, 450]);
    expect(report.counts).toMatchObject({ imported: 450, created: 450, manual: 450, linkedToOsm: 0 });
    expect(store.repo.queryPlaces({ source: 'mine', limit: 1000 })).toHaveLength(450);
    expect(store.repo.tags().map((t) => t.name).sort()).toEqual(['Even', 'Odd']);
  });

  it('cancel keeps the batches written, and undo removes them', async () => {
    const store = openStore();
    const r = many(30);
    const plan = buildPlan(r, new Map(), store.repo);
    const ac = new AbortController();
    const report = await applyImport(store, plan, {
      batchSize: 10,
      signal: ac.signal,
      yieldFn: noYield,
      onProgress: (w) => {
        if (w === 20) ac.abort();
      },
    });
    expect(report.cancelled).toBe(true);
    expect(report.createdPlaceIds).toHaveLength(20);
    expect(store.repo.queryPlaces({ source: 'mine' })).toHaveLength(20);
    await undoImport(store, report, { yieldFn: noYield });
    expect(store.repo.queryPlaces({ source: 'mine' })).toHaveLength(0);
    expect(store.repo.trash()).toHaveLength(20);
    expect(store.repo.tags().every((t) => t.deletedAt !== null)).toBe(true);
  });

  it('Google + My Maps in a row: OSM-linked, merged, no duplicates; tag mapping honored', async () => {
    const store = openStore();
    const lookup = fixtureLookup();
    const g = parse('google/Saved Places.json');
    const gPlan = buildPlan(g, await matchPlaces(g.places, lookup), store.repo);
    const gReport = await applyImport(store, gPlan, { yieldFn: noYield });
    expect(gReport.counts).toMatchObject({ created: 3, linkedToOsm: 2, manual: 1 });
    const trattoria = store.repo.getMySaveForPlace('osm:node/9123456702')!;
    expect(trattoria.createdAt).toBe(Date.UTC(2021, 5, 12, 19, 3, 11));
    // The OSM tags of the match are cached on the place card.
    expect(store.repo.getPlace('osm:node/9123456702')!.osmTags?.amenity).toBe('restaurant');

    const k = parse('kml/my-maps.kml');
    let kPlan = buildPlan(k, await matchPlaces(k.places, lookup), store.repo);
    // Map "Culture" onto my "Saved places" tag; skip "Restaurants".
    const saved = store.repo.tags().find((t) => t.name === 'Saved places')!;
    kPlan = setTagAction(kPlan, 'Culture', { kind: 'map', tagId: saved.id });
    kPlan = setTagAction(kPlan, 'Restaurants', { kind: 'skip' });
    // The user chose to add the file's tags and comments to the places already saved.
    kPlan = setMergeExisting(kPlan, true);
    const kReport = await applyImport(store, kPlan, { yieldFn: noYield });
    expect(kReport.counts).toMatchObject({ created: 4, merged: 1, toCheck: 1 });
    const t2 = store.repo.getMySaveForPlace('osm:node/9123456702')!;
    expect(t2.comment).toBe('Fresh pasta\nBook on weekends');
    expect(t2.status).toBe('tried');
    expect(store.repo.tags().map((t) => t.name)).toEqual(['Saved places']);
    const museum = store.repo.getMySaveForPlace('osm:way/412345678')!;
    expect(museum.tagIds).toEqual([saved.id]);

    // Re-importing the same file adds nothing.
    const again = buildPlan(k, await matchPlaces(k.places, lookup), store.repo);
    const before = store.repo.queryPlaces({ source: 'mine' }).length;
    const r3 = await applyImport(store, again, { yieldFn: noYield });
    expect(r3.counts.created).toBe(0);
    expect(r3.counts.alreadySaved).toBe(5);
    expect(store.repo.queryPlaces({ source: 'mine' }).length).toBe(before);
    expect(store.repo.getMySaveForPlace('osm:node/9123456702')!.comment).toBe('Fresh pasta\nBook on weekends');

    // Undo of the KML import restores the merged save.
    await undoImport(store, kReport, { yieldFn: noYield });
    const t3 = store.repo.getMySaveForPlace('osm:node/9123456702')!;
    expect(t3.comment).toBe('');
    expect(t3.status).toBeNull();
    expect(t3.deletedAt).toBeNull();
  });

  it('places without a position are skipped, never written', async () => {
    const store = openStore();
    const r = parse('google/Want to go.csv');
    const plan = buildPlan(r, await matchPlaces(r.places, null), store.repo);
    const report = await applyImport(store, plan, { yieldFn: noYield });
    expect(report.counts).toMatchObject({ created: 1, skipped: 2 });
  });
});
