// SPDX-License-Identifier: MPL-2.0
/**
 * Mapstr export (verified layout, T-009), on INVENTED fixtures that mirror a real export:
 * test/fixtures/mapstr/ (see make_fixtures.py).
 */
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  applyImport,
  buildPlan,
  exportGeoJson,
  isMapstrCsv,
  isMapstrGeoJson,
  joinMapstrRows,
  mapstrIconCategory,
  matchPlaces,
  maybeClosedItems,
  parseCsv,
  parseMapstrDate,
  ratedCount,
  ratingsInComments,
  readImportFile,
  remotePhotoCount,
  setMaybeClosedSkipped,
  setMergeExisting,
  splitMapstrTags,
  summarizePlan,
  tagRole,
  type ClosureSignalLike,
  type OsmCandidate,
  type OsmLookup,
  type ParseResult,
  type PlanOptions,
  type ReadOutcome,
} from '../src/index.ts';
import { fixtureBytes, fixtureText, openStore } from './helpers.ts';

const noYield = () => Promise.resolve();
const ZIP = 'mapstr/mapstr.zip';
const CSV = 'mapstr/mapstr/mapstr.csv';
const GEOJSON = 'mapstr/mapstr/mapstr.geojson';
const PHOTO_HOST = 'images.example.invalid';

function parsed(o: ReadOutcome): ParseResult {
  if (o.kind !== 'parsed') throw new Error(`expected a parse result, got ${JSON.stringify(o).slice(0, 300)}`);
  return o.result;
}
const read = (rel: string) => parsed(readImportFile({ name: rel.split('/').pop()!, bytes: fixtureBytes(rel) }));
const byName = (r: ParseResult, name: string) => {
  const p = r.places.find((x) => x.name === name);
  if (!p) throw new Error(`no ${name}`);
  return p;
};
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

/** A ZIP from the fixture's two files (optionally changed), with macOS junk. */
function zipOf(files: { csv?: string; geojson?: string }, junk = true): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  if (files.csv !== undefined) entries['mapstr/mapstr.csv'] = strToU8(files.csv);
  if (files.geojson !== undefined) entries['mapstr/mapstr.geojson'] = strToU8(files.geojson);
  if (junk) {
    // A "._" file with a Mapstr-like name and content must be ignored.
    entries['__MACOSX/mapstr/._mapstr.csv'] = strToU8('date,name,address,icon,userComment,rating,tags,photos\n1/1/20 0:00,Junk,,,,,,\n');
    entries['mapstr/._mapstr.geojson'] = new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]);
    entries['mapstr/.DS_Store'] = new Uint8Array([0, 0, 0, 1]);
  }
  return zipSync(entries);
}

describe('Mapstr: reading', () => {
  it('the ZIP: positions, tag colors, icon and comment from the GeoJSON; date, rating, photos from the CSV', () => {
    const r = read(ZIP);
    expect(r.format).toBe('mapstr');
    expect(r.places.map((p) => p.name)).toEqual(['Crêperie des Lanternes', 'Le Comptoir Inventé', 'Salon Thé Fictif', 'Musée des Objets Perdus']);
    const crepe = byName(r, 'Crêperie des Lanternes');
    expect(crepe).toMatchObject({
      lat: 48.86021,
      lon: 2.36312,
      address: '14 Rue des Lanternes, 75003 Paris, France',
      comment: 'Buckwheat crêpes, cider, friendly staff',
      tags: ['Restaurant', 'À essayer', 'Openair', 'Brunch'],
      mainTag: 'Restaurant',
      category: 'amenity=restaurant',
      createdAt: local(2022, 3, 5, 19, 7),
      ids: {},
    });
    expect(crepe.rating).toBeUndefined();
    expect(crepe.remotePhotos).toHaveLength(2);
    expect(byName(r, 'Le Comptoir Inventé')).toMatchObject({ rating: '4', comment: 'Natural wines; ask for the "wine of the day"', category: 'amenity=bar' });
    // Unknown icon key: no category.
    expect(byName(r, 'Salon Thé Fictif').category).toBeUndefined();
    expect(byName(r, 'Salon Thé Fictif').comment).toBeUndefined();
    // Tags with their colors, once each.
    expect(r.tags).toEqual([
      { key: 'Restaurant', name: 'Restaurant', color: '#FF5161' },
      { key: 'À essayer', name: 'À essayer', color: '#FFB300' },
      { key: 'Openair', name: 'Openair', color: '#4CAF50' },
      { key: 'Brunch', name: 'Brunch', color: '#FF9800' },
      { key: 'Bar', name: 'Bar', color: '#7E57C2' },
      { key: 'Salon de thé / café', name: 'Salon de thé / café', color: '#8D6E63' },
      { key: 'Lire commentaire', name: 'Lire commentaire', color: '#9E9E9E' },
      { key: 'Musée', name: 'Musée', color: '#2196F3' },
    ]);
    expect(r.warnings).toEqual([{ code: 'remote-photos', detail: '2' }]);
  });

  it('ignores macOS junk in the ZIP (__MACOSX, ._ files, .DS_Store)', () => {
    const r = parsed(readImportFile({ name: 'mapstr.zip', bytes: zipOf({ csv: fixtureText(CSV), geojson: fixtureText(GEOJSON) }) }));
    expect(r.places).toHaveLength(4);
    expect(r.places.some((p) => p.name === 'Junk')).toBe(false);
    // The committed fixture carries the junk entries too.
    expect(Object.keys(unzipSync(fixtureBytes(ZIP))).filter((n) => n.startsWith('__MACOSX/'))).toHaveLength(3);
  });

  it('the CSV alone: no positions, so places are searched by name and address; the ZIP is recommended', () => {
    const r = read(CSV);
    expect(r.format).toBe('mapstr');
    expect(r.places).toHaveLength(4);
    expect(r.places.every((p) => p.lat === undefined && p.address)).toBe(true);
    expect(r.warnings).toContainEqual({ code: 'positions-from-address', detail: '4' });
    // Tags without colors (the CSV has none): the plan gives them palette colors.
    expect(r.tags.every((t) => !t.color)).toBe(true);
    expect(byName(r, 'Crêperie des Lanternes')).toMatchObject({ tags: ['Restaurant', 'À essayer', 'Openair', 'Brunch'], mainTag: 'Restaurant', createdAt: local(2022, 3, 5, 19, 7) });
  });

  it('the GeoJSON alone: positions and colors, no date, rating or photos', () => {
    const r = read(GEOJSON);
    expect(r.format).toBe('mapstr');
    expect(r.places).toHaveLength(4);
    expect(r.places.every((p) => p.lat !== undefined && p.createdAt === undefined && !p.rating && !p.remotePhotos)).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('several tags per place: "#" separates them, names keep spaces, accents and "/"', () => {
    expect(splitMapstrTags('Bar#Openair#Salon de thé / café#Restaurant#Petit-dejeuner#Hotel / Airbnb')).toEqual([
      'Bar',
      'Openair',
      'Salon de thé / café',
      'Restaurant',
      'Petit-dejeuner',
      'Hotel / Airbnb',
    ]);
    expect(splitMapstrTags('À essayer#Restaurant#Snack')).toEqual(['À essayer', 'Restaurant', 'Snack']);
    expect(splitMapstrTags(' Boulangerie Pâtisserie ## Bar #bar')).toEqual(['Boulangerie Pâtisserie', 'Bar']);
    expect(splitMapstrTags('')).toEqual([]);
    // The join keeps every tag of the GeoJSON array, in order.
    expect(read(ZIP).places.map((p) => p.tags.length)).toEqual([4, 2, 2, 1]);
  });

  it('dates: month/day/2-digit year in local time, seconds and AM/PM tolerated, nonsense rejected', () => {
    expect(parseMapstrDate('6/17/23 18:36')).toBe(local(2023, 6, 17, 18, 36));
    expect(parseMapstrDate('12/1/19 0:05')).toBe(local(2019, 12, 1, 0, 5));
    expect(parseMapstrDate('6/17/2023 6:36:10 PM')).toBe(new Date(2023, 5, 17, 18, 36, 10).getTime());
    expect(parseMapstrDate('6/17/23')).toBe(local(2023, 6, 17, 0, 0));
    for (const bad of ['17/6/23 18:36', '2/30/23 10:00', '6/17/23 25:00', '2023-06-17', '', undefined]) expect(parseMapstrDate(bad)).toBeUndefined();
  });

  it('icons: obvious Mapstr keys become OSM categories, others none', () => {
    expect(mapstrIconCategory('restaurant')).toBe('amenity=restaurant');
    expect(mapstrIconCategory('Bar')).toBe('amenity=bar');
    expect(mapstrIconCategory('museum')).toBe('tourism=museum');
    expect(mapstrIconCategory('ice_cream')).toBe('amenity=ice_cream');
    expect(mapstrIconCategory('tea')).toBeUndefined();
    expect(mapstrIconCategory(undefined)).toBeUndefined();
  });
});

describe('Mapstr: joining the CSV and the GeoJSON', () => {
  const rows = [
    { name: 'A', address: '1 Rue X' },
    { name: 'B', address: '2 Rue Y' },
    { name: 'B', address: '9 Rue Z' },
  ];

  it('by order when counts and names agree, else by normalized name and address', () => {
    expect(joinMapstrRows(rows, rows.map((r) => ({ ...r })))).toEqual({ pairs: [0, 1, 2], byOrder: true });
    const shuffled = [rows[2]!, { name: ' a ', address: '1 RUE X' }, rows[1]!];
    expect(joinMapstrRows(rows, shuffled)).toEqual({ pairs: [1, 2, 0], byOrder: false });
    expect(joinMapstrRows(rows, [rows[1]!])).toEqual({ pairs: [-1, 0, -1], byOrder: false });
  });

  it('a GeoJSON in another order with a missing feature: joined by name; the CSV row keeps no position', () => {
    const geo = JSON.parse(fixtureText(GEOJSON)) as { features: unknown[] };
    geo.features = [geo.features[3], geo.features[1], geo.features[0]];
    const r = parsed(readImportFile({ name: 'mapstr.zip', bytes: zipOf({ csv: fixtureText(CSV), geojson: JSON.stringify(geo) }) }));
    expect(r.places.map((p) => p.name)).toEqual(['Crêperie des Lanternes', 'Le Comptoir Inventé', 'Salon Thé Fictif', 'Musée des Objets Perdus']);
    expect(byName(r, 'Musée des Objets Perdus')).toMatchObject({ lat: 48.8619, createdAt: local(2024, 7, 14, 8, 30), rating: '5' });
    expect(byName(r, 'Crêperie des Lanternes').remotePhotos).toHaveLength(2);
    const salon = byName(r, 'Salon Thé Fictif');
    expect(salon.lat).toBeUndefined();
    expect(salon.tags).toEqual(['Salon de thé / café', 'Lire commentaire']);
    expect(r.warnings).toContainEqual({ code: 'row-not-joined', at: salon.key });
    expect(r.warnings).toContainEqual({ code: 'positions-from-address', detail: '1' });
  });
});

describe('Mapstr: detection and invalid files', () => {
  it('a CSV with exactly the Mapstr header; a GeoJSON with userComment and tags {name, color}', () => {
    expect(isMapstrCsv(parseCsv(fixtureText(CSV)))).toBe(true);
    expect(isMapstrCsv(parseCsv('date,name,address,icon,userComment,rating,tags\n'))).toBe(false);
    expect(isMapstrGeoJson(JSON.parse(fixtureText(GEOJSON)))).toBe(true);
    const plain = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'X', tags: ['a'] }, geometry: null }] };
    expect(isMapstrGeoJson(plain)).toBe(false);
    // Any file name.
    expect(parsed(readImportFile({ name: 'export (1).csv', text: fixtureText(CSV) })).format).toBe('mapstr');
    expect(parsed(readImportFile({ name: 'places.json', text: fixtureText(GEOJSON) })).format).toBe('mapstr');
    expect(parsed(readImportFile({ name: 'download.zip', bytes: fixtureBytes(ZIP) })).format).toBe('mapstr');
  });

  it('an invalid GeoJSON is a clear error; in the ZIP, the CSV is still used and the preview says why', () => {
    const cut = fixtureText('mapstr/invalid.geojson');
    expect(readImportFile({ name: 'mapstr.geojson', text: cut })).toEqual({ kind: 'error', code: 'invalid-json' });
    const r = parsed(readImportFile({ name: 'mapstr.zip', bytes: zipOf({ csv: fixtureText(CSV), geojson: cut }) }));
    expect(r.places).toHaveLength(4);
    expect(r.places.every((p) => p.lat === undefined)).toBe(true);
    expect(r.warnings.map((w) => w.code).filter((c) => c !== 'no-coordinates')).toEqual(['invalid-geojson', 'positions-from-address', 'remote-photos']);
    expect(readImportFile({ name: 'mapstr.zip', bytes: zipOf({ geojson: cut }) })).toMatchObject({ kind: 'error', code: 'invalid-json' });
  });
});

// ------------------------------------------------------------------ plan and writing

/** OSM answers that know none of the invented places, except what a test adds. */
function lookupWith(extra: OsmCandidate[] = []): OsmLookup {
  return {
    async inBBox(b) {
      return extra.filter((c) => c.lat >= b.south && c.lat <= b.north && c.lon >= b.west && c.lon <= b.east);
    },
    async search() {
      return [];
    },
  };
}

// The osm package's own closure signals, as the app passes them (loaded by path: this package does
// not depend on @triangulair/osm, and its sources are type-checked under their own options).
const OSM_SOURCE = new URL('../../osm/src/closure/signals.ts', import.meta.url).href;
const { osmSignals } = (await import(OSM_SOURCE)) as {
  osmSignals: (obs: { kind: 'present'; element: { type: string; id: number; tags: Record<string, string> } }, previous: undefined, now: Date) => ClosureSignalLike[];
};
const closureSignals: PlanOptions['closureSignals'] = (c, now) =>
  osmSignals({ kind: 'present', element: { type: c.ref.type, id: c.ref.id, tags: c.tags ?? {} } }, undefined, now);
const NOW = () => Date.UTC(2026, 10, 23);

describe('Mapstr: tags that are not categories', () => {
  it('"À essayer" becomes the status to try; criteria and other tags stay tags (none skipped)', async () => {
    const store = openStore();
    const r = read(ZIP);
    const plan = buildPlan(r, await matchPlaces(r.places, lookupWith()), store.repo, { now: NOW });
    const by = new Map(plan.tags.map((t) => [t.source.name, t]));
    expect(by.get('À essayer')).toMatchObject({ action: { kind: 'status', status: 'to_try' }, role: { kind: 'status', status: 'to_try' } });
    expect(by.get('Openair')).toMatchObject({ action: { kind: 'create', color: '#4CAF50' }, role: { kind: 'criterion', criterion: 'terrace' } });
    expect(by.get('Lire commentaire')).toMatchObject({ action: { kind: 'create' }, role: null });
    expect(plan.tags.some((t) => t.action.kind === 'skip')).toBe(false);
    await applyImport(store, plan, { yieldFn: noYield });
    const crepe = store.repo.queryPlaces({ source: 'mine' }).find((p) => p.name === 'Crêperie des Lanternes')!;
    const save = store.repo.getMySaveForPlace(crepe.id)!;
    expect(save.status).toBe('to_try');
    const names = new Map(store.repo.tags().map((t) => [t.id, t.name]));
    expect(save.tagIds.map((id) => names.get(id))).toEqual(['Restaurant', 'Brunch', 'Openair']);
    expect(save.mainTagId && names.get(save.mainTagId)).toBe('Restaurant');
    expect([...names.values()]).not.toContain('À essayer');
    expect(save.createdAt).toBe(local(2022, 3, 5, 19, 7));
  });

  it('role names in English and French', () => {
    for (const n of ['À essayer', 'a tester', 'To try']) expect(tagRole(n)).toEqual({ kind: 'status', status: 'to_try' });
    for (const n of ['Openair', 'open air', 'Terrasse', 'terrace']) expect(tagRole(n)).toEqual({ kind: 'criterion', criterion: 'terrace' });
    for (const n of ['Vege friendly', 'veggie', 'Végétarien']) expect(tagRole(n)).toEqual({ kind: 'criterion', criterion: 'vegetarian' });
    for (const n of ['A emporter', 'take away', 'Takeaway']) expect(tagRole(n)).toEqual({ kind: 'criterion', criterion: 'takeaway' });
    for (const n of ['Lire commentaire', 'Restaurant', 'Salon de thé / café']) expect(tagRole(n)).toBeNull();
  });
});

describe('Mapstr: rating and photos', () => {
  it('the rating is not written unless asked; photos stay on Mapstr and their URLs are never written', async () => {
    const store = openStore();
    const r = read(ZIP);
    const plan = buildPlan(r, await matchPlaces(r.places, lookupWith()), store.repo, { now: NOW });
    expect(ratedCount(plan)).toBe(2);
    expect(remotePhotoCount(plan)).toBe(2);
    const withRatings = ratingsInComments(plan, (v) => `Mapstr rating: ${v}`);
    expect(withRatings.items.find((i) => i.place.name === 'Le Comptoir Inventé')!.place.comment).toBe('Natural wines; ask for the "wine of the day"\n\nMapstr rating: 4');
    expect(withRatings.items.find((i) => i.place.name === 'Crêperie des Lanternes')!.place.comment).toBe('Buckwheat crêpes, cider, friendly staff');
    await applyImport(store, plan, { yieldFn: noYield });
    const doc = JSON.stringify(exportGeoJson(store));
    expect(doc).not.toContain(PHOTO_HOST);
    expect(doc).not.toContain('Mapstr rating');
    expect(doc).toContain('Buckwheat crêpes, cider, friendly staff');
  });
});

describe('Mapstr: no duplicates', () => {
  it('importing the same ZIP twice adds nothing the second time, and says so', async () => {
    const store = openStore();
    const r = read(ZIP);
    const first = await applyImport(store, buildPlan(r, await matchPlaces(r.places, lookupWith()), store.repo, { now: NOW }), { yieldFn: noYield });
    expect(first.counts).toMatchObject({ created: 4, alreadySaved: 0 });
    const before = store.repo.queryPlaces({ source: 'mine' }).length;
    const again = buildPlan(r, await matchPlaces(r.places, lookupWith()), store.repo, { now: NOW });
    expect(summarizePlan(again)).toMatchObject({ total: 4, toCreate: 0, toMerge: 4, duplicates: 0 });
    expect(again.items.every((i) => i.existing?.reason === 'nearby-similar')).toBe(true);
    const second = await applyImport(store, again, { yieldFn: noYield });
    expect(second.counts).toMatchObject({ created: 0, merged: 0, alreadySaved: 4 });
    expect(store.repo.queryPlaces({ source: 'mine' })).toHaveLength(before);
    // Merging on request: nothing new either.
    const third = await applyImport(store, setMergeExisting(again, true), { yieldFn: noYield });
    expect(third.counts).toMatchObject({ created: 0, merged: 4, unchanged: 4 });
  });

  it('a place already saved (same name within 50 m) is "already in my places": merged only if the user chooses', async () => {
    const store = openStore();
    // My own manual point 40 m from the imported position, with my own comment.
    store.change((tx) =>
      tx.putSave({ place: { id: 'local:mine0001', name: 'Le Comptoir Inventé', category: null, kind: 'place', geometry: { type: 'Point', coordinates: [2.35788, 48.85908] } }, comment: 'Mine' }),
    );
    const r = read(ZIP);
    const plan = buildPlan(r, await matchPlaces(r.places, lookupWith()), store.repo, { now: NOW });
    const item = plan.items.find((i) => i.place.name === 'Le Comptoir Inventé')!;
    expect(item.existing).toMatchObject({ placeId: 'local:mine0001', reason: 'nearby-similar' });
    expect(summarizePlan(plan)).toMatchObject({ toCreate: 3, toMerge: 1 });
    expect(plan.mergeExisting).toBe(false);
    const left = await applyImport(store, plan, { yieldFn: noYield });
    expect(left.counts).toMatchObject({ created: 3, alreadySaved: 1, merged: 0 });
    expect(store.repo.getMySaveForPlace('local:mine0001')!.comment).toBe('Mine');
    expect(store.repo.getMySaveForPlace('local:mine0001')!.tagIds).toEqual([]);
    const merged = await applyImport(store, setMergeExisting(buildPlan(r, await matchPlaces(r.places, lookupWith()), store.repo, { now: NOW }), true), { yieldFn: noYield });
    expect(merged.counts.merged).toBe(4);
    const mine = store.repo.getMySaveForPlace('local:mine0001')!;
    expect(mine.comment).toBe('Mine\n\nNatural wines; ask for the "wine of the day"');
    expect(mine.tagIds).toHaveLength(2);
  });

  it('a place already saved as the same OSM object is not created again', async () => {
    const store = openStore();
    const osm: OsmCandidate = { ref: { type: 'node', id: 777 }, name: 'Musée des Objets Perdus', lat: 48.8619, lon: 2.35455, category: 'tourism=museum', tags: { name: 'Musée des Objets Perdus', tourism: 'museum' } };
    store.change((tx) => tx.putSave({ place: { osm: osm.ref, name: osm.name, category: osm.category, geometry: { type: 'Point', coordinates: [osm.lon, osm.lat] } } }));
    const r = read(ZIP);
    const plan = buildPlan(r, await matchPlaces(r.places, lookupWith([osm])), store.repo, { now: NOW });
    expect(plan.items.find((i) => i.place.name === 'Musée des Objets Perdus')!.existing).toMatchObject({ placeId: 'osm:node/777', reason: 'same-place' });
    expect((await applyImport(store, plan, { yieldFn: noYield })).counts).toMatchObject({ created: 3, alreadySaved: 1 });
  });

  it('two rows of the file for the same place (same name, 20 m apart) are folded', async () => {
    const geo = JSON.parse(fixtureText(GEOJSON)) as { features: { properties: { name: string }; geometry: { coordinates: number[] } }[] };
    const twin = structuredClone(geo.features[1]!);
    twin.geometry.coordinates = [2.35788, 48.85890];
    geo.features.push(twin);
    const r = parsed(readImportFile({ name: 'mapstr.geojson', text: JSON.stringify(geo) }));
    const plan = buildPlan(r, await matchPlaces(r.places, lookupWith()), null, { now: NOW });
    expect(summarizePlan(plan)).toMatchObject({ total: 5, toCreate: 4, duplicates: 1 });
    expect(plan.items[4]!.duplicateOf).toBe(plan.items[1]!.key);
  });
});

describe('Mapstr: places that may no longer exist according to OpenStreetMap', () => {
  const closedBar: OsmCandidate = {
    ref: { type: 'node', id: 4242 },
    name: 'Le Comptoir Inventé',
    lat: 48.85875,
    lon: 2.3579,
    category: 'amenity=bar',
    tags: { name: 'Le Comptoir Inventé', amenity: 'bar', end_date: '2025-03' },
  };
  const liveMuseum: OsmCandidate = { ref: { type: 'way', id: 99 }, name: 'Musée des Objets Perdus', lat: 48.8619, lon: 2.35455, category: 'tourism=museum', tags: { name: 'Musée des Objets Perdus', tourism: 'museum' } };

  it('flags an OSM object tagged closed, and a categorized place OSM does not know nearby; nothing is dropped', async () => {
    const store = openStore();
    const r = read(ZIP);
    const plan = buildPlan(r, await matchPlaces(r.places, lookupWith([closedBar, liveMuseum])), store.repo, { now: NOW, closureSignals });
    const flagged = new Map(maybeClosedItems(plan).map((i) => [i.place.name, i.closure.map((s) => s.code)]));
    // The bar: end date passed (osm package's closure signals). The crêperie: a restaurant OSM has nothing of that name near.
    // The museum is in OSM and live; the salon has no category to go by.
    expect(Object.fromEntries(flagged)).toEqual({ 'Crêperie des Lanternes': ['not_found_nearby'], 'Le Comptoir Inventé': ['end_date_past'] });
    expect(summarizePlan(plan)).toMatchObject({ maybeClosed: 2, toCreate: 4, skipped: 0 });

    // "Leave them out", then "Keep them".
    const out = setMaybeClosedSkipped(plan, true, store.repo);
    expect(summarizePlan(out)).toMatchObject({ maybeClosed: 2, toCreate: 2, skipped: 2 });
    const back = setMaybeClosedSkipped(out, false, store.repo);
    expect(summarizePlan(back)).toMatchObject({ maybeClosed: 2, toCreate: 4, skipped: 0 });
    expect(back.items[1]!.resolution).toEqual(plan.items[1]!.resolution);

    // Kept: written with the closure system's flag (the card's "Maybe closed" badge).
    const report = await applyImport(store, back, { yieldFn: noYield });
    expect(report.counts).toMatchObject({ created: 4, maybeClosed: 2 });
    const bar = store.repo.getPlace('osm:node/4242')!;
    expect(bar.status).toBe('maybe_closed');
    expect((bar.closedSignals as { code: string }[])[0]!.code).toBe('end_date_past');
    expect(store.repo.getPlace('osm:way/99')!.status).toBe('open');
  });

  it('no flag when OpenStreetMap could not be reached', async () => {
    const offline: OsmLookup = {
      async inBBox() {
        throw new Error('offline');
      },
    };
    const r = read(ZIP);
    const plan = buildPlan(r, await matchPlaces(r.places, offline), null, { now: NOW, closureSignals });
    expect(maybeClosedItems(plan)).toEqual([]);
  });
});
