// SPDX-License-Identifier: MPL-2.0
import { newLocalPlaceId } from '@triangulair/data';
import { describe, expect, it } from 'vitest';

import {
  buildPlan,
  classify,
  matchPlaces,
  osmLookupFromClient,
  readImportFile,
  resolveItem,
  summarizePlan,
  tileBBox,
  tileKey,
  type ImportedPlace,
  type OsmClientLike,
  type ParseResult,
} from '../src/index.ts';
import { fixtureBytes, fixtureLookup, maraisCandidates, openStore } from './helpers.ts';

const place = (name: string, lat?: number, lon?: number, extra: Partial<ImportedPlace> = {}): ImportedPlace => ({
  key: name,
  name,
  ...(lat !== undefined && { lat, lon: lon! }),
  tags: [],
  ids: {},
  ...extra,
});

function parse(rel: string): ParseResult {
  const o = readImportFile({ name: rel.split('/').pop()!, bytes: fixtureBytes(rel) });
  if (o.kind !== 'parsed') throw new Error(o.kind);
  return o.result;
}

describe('classify (pure)', () => {
  const pois = maraisCandidates();

  it('same name at the same spot: matched automatically', () => {
    const m = classify(place('Trattoria Da Lucia', 48.8591, 2.36215), pois);
    expect(m.kind).toBe('matched');
    if (m.kind === 'matched') expect(m.best.ref).toEqual({ type: 'node', id: 9123456702 });
  });

  it('a slightly different name nearby is still automatic', () => {
    const m = classify(place('Trattoria Lucia', 48.85912, 2.36218), pois);
    expect(m.kind).toBe('matched');
  });

  it('the right name but 130 m away: to check', () => {
    const m = classify(place('Musée des Cartes', 48.8573, 2.3639), pois);
    expect(m.kind).toBe('ambiguous');
    expect(m.candidates[0]!.ref).toEqual({ type: 'way', id: 412345678 });
  });

  it('two similar candidates: to check, both offered', () => {
    const twins = [...pois, { ...pois.find((p) => p.name === 'Café Pendule')!, ref: { type: 'node' as const, id: 1 }, name: 'Café Pendule Bis', lat: 48.85906 }];
    const m = classify(place('Cafe Pendule', 48.85904, 2.36199), twins);
    expect(m.kind).toBe('ambiguous');
    expect(m.candidates.map((c) => c.name)).toEqual(expect.arrayContaining(['Café Pendule', 'Café Pendule Bis']));
  });

  it('no similar name around: manual point (nearby POIs still listed)', () => {
    const m = classify(place('Chez Mamie Rose', 48.8591, 2.3622), pois);
    expect(m.kind).toBe('manual');
  });

  it('a similar name too far away is not considered', () => {
    expect(classify(place('Trattoria Da Lucia', 48.87, 2.38), pois).kind).toBe('manual');
  });

  it('the address helps when the name is generic', () => {
    const withAddress = classify(place('Trattoria', 48.8592, 2.3622, { address: '12 Rue de Bretagne, 75003 Paris' }), pois);
    expect(withAddress.candidates[0]?.name).toBe('Trattoria Da Lucia');
  });
});

describe('tiles', () => {
  it('a tile bbox contains the tile and its margin, and stays under the Overpass area limit', () => {
    const k = tileKey(48.8591, 2.3621, 0.01);
    const b = tileBBox(k, 0.01, 250);
    expect(b.south).toBeLessThan(48.85);
    expect(b.north).toBeGreaterThan(48.86);
    expect((b.north - b.south) * (b.east - b.west)).toBeLessThan(0.0006);
  });
});

describe('matchPlaces (fixture lookup, offline)', () => {
  it('one bbox query per tile, searches only for places without coordinates', async () => {
    const lookup = fixtureLookup();
    const ps = [
      place('Trattoria Da Lucia', 48.8591, 2.36215),
      place('Café Pendule', 48.85904, 2.36199),
      place('Le Comptoir des Archives', 48.85961, 2.36319),
      place('Fromagerie Martin'),
      place('Nowhere at all'),
    ];
    const progress: [number, number][] = [];
    const m = await matchPlaces(ps, lookup, { onProgress: (d, t) => progress.push([d, t]) });
    expect(lookup.bboxCalls).toBe(1);
    expect(lookup.searchCalls).toEqual(['Fromagerie Martin', 'Nowhere at all']);
    expect(m.get('Trattoria Da Lucia')!.kind).toBe('matched');
    // Found by name only: never automatic.
    expect(m.get('Fromagerie Martin')!.kind).toBe('ambiguous');
    expect(m.get('Nowhere at all')!.kind).toBe('unlocated');
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it('source ids and zones are not looked up', async () => {
    const lookup = fixtureLookup();
    const m = await matchPlaces(
      [
        place('A', 48.8, 2.3, { ids: { osm: { type: 'node', id: 5 } } }),
        place('Zone', 48.8, 2.3, { shape: { geometry: { type: 'LineString', coordinates: [[2.3, 48.8], [2.31, 48.81]] } } }),
      ],
      lookup,
    );
    expect(lookup.bboxCalls).toBe(0);
    expect(m.get('A')!.kind).toBe('source');
    expect(m.get('Zone')!.kind).toBe('manual');
  });

  it('offline: places stay manual points, flagged', async () => {
    const m = await matchPlaces([place('Trattoria Da Lucia', 48.8591, 2.36215)], fixtureLookup({ failBBox: true }));
    expect(m.get('Trattoria Da Lucia')).toEqual({ kind: 'manual', candidates: [], lookupFailed: true });
  });

  it('cancel stops the matching', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(matchPlaces([place('X', 48.8, 2.3)], fixtureLookup(), { signal: ac.signal })).rejects.toThrow();
  });
});

describe('osmLookupFromClient', () => {
  it('adapts the osm client (bbox limit, Photon-only search)', async () => {
    const calls: unknown[] = [];
    const client: OsmClientLike = {
      overpass: {
        async inBBox(b, o) {
          calls.push(['bbox', b, o?.limit]);
          return [
            { ref: { type: 'node', id: 1 }, name: 'A', location: { lat: 1, lon: 2 }, primaryTag: { key: 'amenity', value: 'bar' }, address: { formatted: '1 Rue X' }, tags: { name: 'A' } },
            { ref: { type: 'node', id: 2 }, location: { lat: 1, lon: 2 }, address: {}, tags: {} },
          ];
        },
      },
      search: {
        async search(q, o) {
          calls.push(['search', q, o?.mode]);
          return [{ ref: { type: 'way', id: 3 }, name: 'B', label: 'Paris', location: { lat: 3, lon: 4 }, kind: 'poi', osmKey: 'shop', osmValue: 'books' }];
        },
      },
    };
    const l = osmLookupFromClient(client);
    expect(await l.inBBox({ south: 0, west: 0, north: 1, east: 1 })).toEqual([
      { ref: { type: 'node', id: 1 }, name: 'A', lat: 1, lon: 2, category: 'amenity=bar', address: '1 Rue X', tags: { name: 'A' } },
    ]);
    expect(await l.search!('B', {})).toEqual([{ ref: { type: 'way', id: 3 }, name: 'B', lat: 3, lon: 4, category: 'shop=books', address: 'Paris', kind: 'poi' }]);
    expect(calls).toEqual([
      ['bbox', { south: 0, west: 0, north: 1, east: 1 }, 500],
      ['search', 'B', 'autocomplete'],
    ]);
  });
});

describe('plan: preview groups, choices, duplicates, existing saves, tags', () => {
  it('My Maps file against the Marais fixture: matched / to check / manual', async () => {
    const r = parse('kml/my-maps.kml');
    const plan = buildPlan(r, await matchPlaces(r.places, fixtureLookup()), null);
    const s = summarizePlan(plan);
    expect(s).toMatchObject({ total: 5, matched: 1, ambiguous: 1, manual: 3, toCreate: 5, linkedToOsm: 2 });
    // The doubtful museum is pre-selected (same name), but stays "to check".
    const musee = plan.items.find((i) => i.place.name === 'Musée des Cartes')!;
    expect(musee.resolution.kind).toBe('osm');
    // Tags: folders → new tags with the My Maps colors.
    expect(plan.tags.map((t) => [t.source.name, t.count, t.action])).toEqual([
      ['Restaurants', 2, { kind: 'create', name: 'Restaurants', color: '#E65100' }],
      ['Culture', 3, { kind: 'create', name: 'Culture', color: '#0288D1' }],
    ]);
  });

  it('two entries for the same OSM place are folded; choosing a candidate refreshes it', async () => {
    const ps = [place('Trattoria Da Lucia', 48.8591, 2.36215), place('Trattoria Lucia', 48.85912, 2.36218), place('Café Pendule!', 48.8572, 2.3655)];
    const r: ParseResult = { format: 'csv', places: ps, tags: [], warnings: [] };
    let plan = buildPlan(r, await matchPlaces(ps, fixtureLookup()), null);
    expect(plan.items[1]!.duplicateOf).toBe(plan.items[0]!.key);
    const third = plan.items[2]!;
    expect(third.resolution.kind).toBe('manual');
    plan = resolveItem(plan, third.key, { kind: 'osm', candidate: maraisCandidates().find((c) => c.name === 'Trattoria Da Lucia')! }, null);
    expect(plan.items[2]!.duplicateOf).toBe(plan.items[0]!.key);
    plan = resolveItem(plan, plan.items[0]!.key, { kind: 'skip' }, null);
    expect(plan.items[1]!.duplicateOf).toBeNull();
    expect(plan.items[2]!.duplicateOf).toBe(plan.items[1]!.key);
  });

  it('two manual points within 30 m with similar names are folded', () => {
    const ps = [place('Chez Mamie Rose', 48.8648, 2.3555), place('Chez Mamie-Rose', 48.86482, 2.35552), place('Chez Mamie Rose', 48.87, 2.36)];
    const plan = buildPlan({ format: 'csv', places: ps, tags: [], warnings: [] }, new Map(), null);
    expect(plan.items.map((i) => i.duplicateOf)).toEqual([null, ps[0]!.key, null]);
  });

  it('existing saves are recognized: same OSM place, or a manual point nearby with a similar name; tags map by name', async () => {
    const store = openStore();
    const pizza = store.createTag({ name: 'Restaurants', color: '#111111' });
    store.putSave({ place: { osm: { type: 'node', id: 9123456702 }, name: 'Trattoria Da Lucia', geometry: { type: 'Point', coordinates: [2.3621507, 48.8591004] } }, tagIds: [pizza] });
    const mamie = newLocalPlaceId();
    store.putSave({ place: { id: mamie, name: 'Chez Mamie Rose', geometry: { type: 'Point', coordinates: [2.35551, 48.86481] } } });
    const r = parse('kml/my-maps.kml');
    const plan = buildPlan(r, await matchPlaces(r.places, fixtureLookup()), store.repo);
    const by = (n: string) => plan.items.find((i) => i.place.name === n)!;
    expect(by('Trattoria Da Lucia').existing).toMatchObject({ placeId: 'osm:node/9123456702', reason: 'same-place' });
    expect(by('Chez Mamie Rose').existing).toMatchObject({ placeId: mamie, reason: 'nearby-similar' });
    expect(plan.tags.find((t) => t.source.name === 'Restaurants')!.action).toEqual({ kind: 'map', tagId: pizza });
    expect(summarizePlan(plan)).toMatchObject({ toMerge: 2, toCreate: 3 });
  });
});
