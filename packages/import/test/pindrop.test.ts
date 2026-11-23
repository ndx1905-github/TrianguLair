// SPDX-License-Identifier: MPL-2.0
/**
 * Pin Drop export (verified layout, T-009), on an INVENTED fixture that mirrors a real export:
 * test/fixtures/pindrop/ (see make_fixtures.py). Photos: a fake fetcher, never the network.
 */
import { describe, expect, it } from 'vitest';

import {
  applyImport,
  buildPlan,
  exportGeoJson,
  isPinDropJson,
  matchPlaces,
  maybeClosedItems,
  parsePinDrop,
  parsePinDropDate,
  PhotoDownloadBlockedError,
  pinDropIconCategory,
  readImportFile,
  remotePhotoCount,
  remotePhotoId,
  setDownloadRemotePhotos,
  setMergeExisting,
  summarizePlan,
  undoImport,
  type ApplyOptions,
  type ClosureSignalLike,
  type OsmCandidate,
  type OsmLookup,
  type ParseResult,
  type PlanOptions,
  type ReadOutcome,
} from '../src/index.ts';
import { fixtureBytes, fixtureText, openStore } from './helpers.ts';

const noYield = () => Promise.resolve();
const FILE = 'pindrop/pindrop.json';
const PHOTO_HOST = 'pins.example.org';
const NOW = () => Date.UTC(2026, 10, 23);

function parsed(o: ReadOutcome): ParseResult {
  if (o.kind !== 'parsed') throw new Error(`expected a parse result, got ${JSON.stringify(o).slice(0, 300)}`);
  return o.result;
}
const read = () => parsed(readImportFile({ name: 'pindrop.json', bytes: fixtureBytes(FILE) }));
const byName = (r: ParseResult, name: string) => {
  const p = r.places.find((x) => x.name === name);
  if (!p) throw new Error(`no ${name}`);
  return p;
};

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

const OSM_SOURCE = new URL('../../osm/src/closure/signals.ts', import.meta.url).href;
const { osmSignals } = (await import(OSM_SOURCE)) as {
  osmSignals: (obs: { kind: 'present'; element: { type: string; id: number; tags: Record<string, string> } }, previous: undefined, now: Date) => ClosureSignalLike[];
};
const closureSignals: PlanOptions['closureSignals'] = (c, now) =>
  osmSignals({ kind: 'present', element: { type: c.ref.type, id: c.ref.id, tags: c.tags ?? {} } }, undefined, now);

describe('Pin Drop: reading', () => {
  it('pins, tags by name with colors, statuses, secret, comments, dates, categories; messages ignored', () => {
    const r = read();
    expect(r.format).toBe('pindrop');
    expect(r.places.map((p) => p.name)).toEqual(['Café Pendule', 'Boulangerie des Remparts Fictifs', 'Le Bar Imaginaire', 'Kiosque Sans Nom']);
    // Only tags some place uses; colors upper case; a known icon gives the tag a category.
    expect(r.tags).toEqual([
      { key: 'À essayer', name: 'À essayer', color: '#FFB300' },
      { key: 'Salon de thé / café', name: 'Salon de thé / café', color: '#8D6E63', osmCategories: ['amenity=cafe'] },
      { key: 'Openair', name: 'Openair', color: '#4CAF50' },
      { key: 'Boulangerie Pâtisserie', name: 'Boulangerie Pâtisserie', color: '#FF9800', osmCategories: ['shop=bakery'] },
      { key: 'Cocktails', name: 'Cocktails', color: '#7E57C2', osmCategories: ['amenity=bar'] },
      { key: 'Lire commentaire', name: 'Lire commentaire', color: '#9E9E9E' },
      { key: 'Perso', name: 'Perso', color: '#607D8B' },
    ]);

    const cafe = byName(r, 'Café Pendule');
    expect(cafe).toMatchObject({
      lat: 48.8590377,
      lon: 2.3619902,
      tags: ['Salon de thé / café', 'Openair'],
      mainTag: 'Salon de thé / café',
      comment: 'Quiet in the morning\nGood filter coffee',
      status: 'favorite',
      category: 'amenity=cafe',
      createdAt: Date.UTC(2024, 10, 5, 9, 12, 31, 582),
      ids: { sourceId: 'c622b7f1-6c02-466a-bdb6-0c8a685fab5c' },
    });
    expect(cafe.sharing).toBeUndefined();
    // The media item and the hero image are the same photo: one, full size first.
    expect(cafe.remotePhotos).toEqual([
      {
        urls: [
          'https://pins.example.org/v1/image?file=1c9e1534-2d71-4d94-955a-c5aad5da750e.jpg&mode=full&oid=cdcfe0c034ba4cd3cbd03ec5',
          'https://pins.example.org/v1/image?file=1c9e1534-2d71-4d94-955a-c5aad5da750e.jpg&mode=thumb&oid=cdcfe0c034ba4cd3cbd03ec5',
        ],
        key: '1c9e1534-2d71-4d94-955a-c5aad5da750e.jpg',
        mime: 'image/jpeg',
      },
    ]);

    const bakery = byName(r, 'Boulangerie des Remparts Fictifs');
    // Missing description; secret → private; the tag absent from the file is left out.
    expect(bakery).toMatchObject({
      tags: ['À essayer', 'Boulangerie Pâtisserie'],
      address: '5 Rue des Remparts Fictifs, 75003 Paris, France',
      sharing: 'private',
      commentVisibility: 'private',
      category: 'shop=bakery',
      createdAt: Date.UTC(2024, 5, 3, 8, 15, 2),
    });
    expect(bakery.comment).toBeUndefined();
    expect(bakery.status).toBeUndefined();
    expect(bakery.remotePhotos).toBeUndefined();

    const bar = byName(r, 'Le Bar Imaginaire');
    // wishList → to try; empty description; microseconds and a +02:00 offset; hero image only.
    expect(bar).toMatchObject({ tags: ['Cocktails', 'Lire commentaire'], status: 'to_try', category: 'amenity=bar', createdAt: Date.UTC(2023, 8, 17, 19, 4, 11, 0) });
    expect(bar.comment).toBeUndefined();
    expect(bar.remotePhotos?.map((p) => p.key)).toEqual(['97d9cd32-abd7-4744-b8ac-fe194ed9be2e.jpg']);

    const kiosk = byName(r, 'Kiosque Sans Nom');
    // Secret and favourite; a tag without icon gives no category; the comment trimmed.
    expect(kiosk).toMatchObject({ tags: ['Perso'], status: 'favorite', sharing: 'private', comment: 'Newspapers and postcards' });
    expect(kiosk.category).toBeUndefined();

    expect(r.warnings).toEqual([
      { code: 'missing-tags', at: 'p1' },
      { code: 'missing-tags', at: 'p2' },
      { code: 'missing-tags', at: 'p3' },
      { code: 'secret-places', detail: '2' },
      { code: 'remote-photos', detail: '2' },
    ]);
    // Nothing of the export's owner or org.
    expect(JSON.stringify(r)).not.toContain('Alex Example');
  });

  it('a bare array of items, a pin without coordinates (location Point, then none), a pin without a name', () => {
    const items = [
      { type: 'tag', id: 't1', name: '', color: '#000000', icon: 'coffee' },
      { type: 'pin', id: 'a', name: 'From location', lat: null, lng: null, tag_ids: ['t1'], date_dropped: '2024-01-02T03:04:05Z', location: { type: 'Point', coordinates: [2.35, 48.86] } },
      { type: 'pin', id: 'b', name: 'Nowhere', address: '1 Rue Exemple, Paris', tag_ids: [], date_dropped: 'yesterday' },
      { type: 'pin', id: 'c', name: '', lat: 48.8, lng: 2.3, tag_ids: [] },
    ];
    const r = parsed(readImportFile({ name: 'export', text: JSON.stringify(items) }));
    expect(r.format).toBe('pindrop');
    expect(r.places).toHaveLength(2);
    expect(r.places[0]).toMatchObject({ lat: 48.86, lon: 2.35, tags: [], createdAt: Date.UTC(2024, 0, 2, 3, 4, 5) });
    expect(r.places[1]).toMatchObject({ name: 'Nowhere', address: '1 Rue Exemple, Paris' });
    expect(r.places[1]!.lat).toBeUndefined();
    expect(r.places[1]!.createdAt).toBeUndefined();
    // A nameless tag is never created: its references count as missing.
    expect(r.tags).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['missing-tags', 'no-coordinates', 'no-name']);
  });

  it('dates: ISO with an offset and any number of fraction digits; nonsense rejected', () => {
    expect(parsePinDropDate('2024-11-05T09:12:31+00:00')).toBe(Date.UTC(2024, 10, 5, 9, 12, 31));
    expect(parsePinDropDate('2024-11-05T09:12:31.582000+00:00')).toBe(Date.UTC(2024, 10, 5, 9, 12, 31, 582));
    expect(parsePinDropDate('2024-11-05T09:12:31.5+01:00')).toBe(Date.UTC(2024, 10, 5, 8, 12, 31, 500));
    expect(parsePinDropDate('2024-11-05T09:12:31Z')).toBe(Date.UTC(2024, 10, 5, 9, 12, 31));
    expect(parsePinDropDate('2024-02-30T10:00:00+00:00')).toBeUndefined();
    expect(parsePinDropDate('28/12/2024')).toBeUndefined();
    expect(parsePinDropDate(null)).toBeUndefined();
  });

  it('icons: obvious ones become OSM categories, others none', () => {
    expect(pinDropIconCategory('coffee')).toBe('amenity=cafe');
    expect(pinDropIconCategory('croissant')).toBe('shop=bakery');
    expect(pinDropIconCategory('martini-glass')).toBe('amenity=bar');
    expect(pinDropIconCategory('ice-cream')).toBe('amenity=ice_cream');
    expect(pinDropIconCategory('building-columns')).toBe('tourism=museum');
    expect(pinDropIconCategory('bench-tree')).toBe('leisure=park');
    expect(pinDropIconCategory('bed')).toBe('tourism=hotel');
    expect(pinDropIconCategory('cart-shopping')).toBe('shop=supermarket');
    expect(pinDropIconCategory('hotdog')).toBe('amenity=fast_food');
    for (const i of ['sparkles', 'hand', 'thought-bubble', null, undefined]) expect(pinDropIconCategory(i)).toBeUndefined();
  });
});

describe('Pin Drop: detection and invalid files', () => {
  it('by content, whatever the file name; GeoJSON and other JSON are not taken', () => {
    expect(isPinDropJson(JSON.parse(fixtureText(FILE)))).toBe(true);
    expect(parsed(readImportFile({ name: 'download (3).json', text: fixtureText(FILE) })).format).toBe('pindrop');
    expect(parsed(readImportFile({ name: 'x.txt', bytes: fixtureBytes(FILE) })).format).toBe('pindrop');
    expect(isPinDropJson({ type: 'FeatureCollection', features: [] })).toBe(false);
    expect(isPinDropJson({ data: [{ type: 'message', id: 'm' }] })).toBe(false);
    expect(isPinDropJson({ data: [] })).toBe(false);
    expect(isPinDropJson([1, 2])).toBe(false);
  });

  it('a file cut short (or broken by hand) is a clear Pin Drop error', () => {
    expect(readImportFile({ name: 'pindrop.json', text: fixtureText('pindrop/invalid.json') })).toEqual({ kind: 'error', code: 'invalid-pindrop' });
    // Other JSON keeps the generic error.
    expect(readImportFile({ name: 'x.json', text: '{"type":"FeatureCollection","features":[' })).toEqual({ kind: 'error', code: 'invalid-json' });
  });

  it('a file whose pins are all gone says it is empty', () => {
    const r = parsePinDrop({ data: [{ type: 'tag', id: 't', name: 'Bar', color: '#ffffff', icon: null }] });
    expect(r.places).toEqual([]);
    expect(r.warnings).toEqual([{ code: 'empty' }]);
  });
});

describe('Pin Drop: plan and writing', () => {
  it('"À essayer" becomes the status; criteria and "Lire commentaire" stay tags; secret places are private', async () => {
    const store = openStore();
    const r = read();
    const plan = buildPlan(r, await matchPlaces(r.places, lookupWith()), store.repo, { now: NOW });
    expect(plan.verified).toBe(true);
    const by = new Map(plan.tags.map((t) => [t.source.name, t]));
    expect(by.get('À essayer')).toMatchObject({ action: { kind: 'status', status: 'to_try' }, count: 1 });
    expect(by.get('Openair')).toMatchObject({ action: { kind: 'create', color: '#4CAF50' }, role: { kind: 'criterion', criterion: 'terrace' } });
    expect(by.get('Lire commentaire')).toMatchObject({ action: { kind: 'create' }, role: null });
    expect(plan.tags.some((t) => t.action.kind === 'skip')).toBe(false);
    expect(plan.downloadRemotePhotos).toBe(false);
    expect(remotePhotoCount(plan)).toBe(2);

    const report = await applyImport(store, plan, { yieldFn: noYield, fetchPhoto: () => Promise.reject(new Error('must not be called')) });
    expect(report.counts).toMatchObject({ created: 4, remotePhotos: 0, remotePhotosFailed: 0 });
    const save = (name: string) => store.repo.getMySaveForPlace(store.repo.queryPlaces({ source: 'mine' }).find((p) => p.name === name)!.id)!;
    expect(save('Boulangerie des Remparts Fictifs')).toMatchObject({ status: 'to_try', sharing: 'private', commentVisibility: 'private', createdAt: Date.UTC(2024, 5, 3, 8, 15, 2) });
    expect(save('Kiosque Sans Nom')).toMatchObject({ status: 'favorite', sharing: 'private', comment: 'Newspapers and postcards' });
    expect(save('Café Pendule')).toMatchObject({ status: 'favorite', sharing: 'friends', comment: 'Quiet in the morning\nGood filter coffee' });
    expect(save('Le Bar Imaginaire')).toMatchObject({ status: 'to_try', comment: '' });
    const tags = store.repo.tags();
    expect(tags.map((t) => t.name).sort()).toEqual(['Boulangerie Pâtisserie', 'Cocktails', 'Lire commentaire', 'Openair', 'Perso', 'Salon de thé / café']);
    expect(tags.find((t) => t.name === 'Salon de thé / café')!.osmCategories).toEqual(['amenity=cafe']);
    // Photos and their URLs are not written unless asked.
    const doc = JSON.stringify(exportGeoJson(store));
    expect(doc).not.toContain(PHOTO_HOST);
    expect(doc).not.toContain('1c9e1534');
  });

  it('no duplicates: the same file twice adds nothing; two pins for the same place are folded (private wins)', async () => {
    const store = openStore();
    const r = read();
    await applyImport(store, buildPlan(r, await matchPlaces(r.places, lookupWith()), store.repo, { now: NOW }), { yieldFn: noYield });
    const again = buildPlan(r, await matchPlaces(r.places, lookupWith()), store.repo, { now: NOW });
    expect(summarizePlan(again)).toMatchObject({ total: 4, toCreate: 0, toMerge: 4 });
    expect((await applyImport(store, again, { yieldFn: noYield })).counts).toMatchObject({ created: 0, alreadySaved: 4 });

    const json = JSON.parse(fixtureText(FILE)) as { data: Record<string, unknown>[] };
    const twin = { ...json.data.find((i) => i.name === 'Café Pendule')!, id: 'twin', lat: 48.859, isSecret: true, favourite: false };
    json.data.push(twin);
    const r2 = parsePinDrop(json);
    const store2 = openStore();
    const plan = buildPlan(r2, await matchPlaces(r2.places, lookupWith()), store2.repo, { now: NOW });
    expect(summarizePlan(plan)).toMatchObject({ total: 5, toCreate: 4, duplicates: 1 });
    await applyImport(store2, plan, { yieldFn: noYield });
    const cafe = store2.repo.queryPlaces({ source: 'mine' }).find((p) => p.name === 'Café Pendule')!;
    expect(store2.repo.getMySaveForPlace(cafe.id)).toMatchObject({ status: 'favorite', sharing: 'private' });
  });

  it('maybe closed: a categorized pin OpenStreetMap does not know nearby, or an OSM object tagged closed', async () => {
    const closedBar: OsmCandidate = {
      ref: { type: 'node', id: 5150 },
      name: 'Le Bar Imaginaire',
      lat: 48.85812,
      lon: 2.35982,
      category: 'amenity=bar',
      tags: { name: 'Le Bar Imaginaire', amenity: 'bar', end_date: '2025-01' },
    };
    const r = read();
    const plan = buildPlan(r, await matchPlaces(r.places, lookupWith([closedBar])), null, { now: NOW, closureSignals });
    const flagged = Object.fromEntries(maybeClosedItems(plan).map((i) => [i.place.name, i.closure.map((s) => s.code)]));
    // The kiosk has no category to go by.
    expect(flagged).toEqual({ 'Café Pendule': ['not_found_nearby'], 'Boulangerie des Remparts Fictifs': ['not_found_nearby'], 'Le Bar Imaginaire': ['end_date_past'] });
  });
});

// ------------------------------------------------------------------ photos

/** A tiny JPEG-looking file (the fake store does not decode it). */
const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function fakePhotos(store: ReturnType<typeof openStore>, fetcher: ApplyOptions['fetchPhoto']) {
  const calls: string[] = [];
  const opts: ApplyOptions = {
    yieldFn: noYield,
    fetchPhoto: async (url, signal) => {
      calls.push(url);
      return fetcher!(url, signal);
    },
    addDownloadedPhoto: async (placeId, image, info) => {
      expect(image).toBe(IMAGE);
      return store.addMedia(placeId, { id: info.id, file: `b2b256:${info.id}`, mime: info.mime ?? 'image/jpeg' });
    },
  };
  return { calls, opts };
}

async function planFor(store: ReturnType<typeof openStore>, r: ParseResult = read()) {
  return setDownloadRemotePhotos(buildPlan(r, await matchPlaces(r.places, lookupWith()), store.repo, { now: NOW }), true);
}

const mediaOf = (store: ReturnType<typeof openStore>, name: string) => {
  const p = store.repo.queryPlaces({ source: 'mine' }).find((x) => x.name === name)!;
  return store.repo.getMedia(store.repo.getMySaveForPlace(p.id)!.id);
};

describe('Pin Drop: photos on its server, downloaded on request', () => {
  it('full size first; added with a stable id; URLs never written; a re-import adds no photo twice', async () => {
    const store = openStore();
    const { calls, opts } = fakePhotos(store, async () => IMAGE);
    const report = await applyImport(store, await planFor(store), opts);
    expect(report.counts).toMatchObject({ created: 4, remotePhotos: 2, remotePhotosFailed: 0 });
    expect(calls.every((u) => u.includes('mode=full'))).toBe(true);
    expect(calls).toHaveLength(2);
    const cafe = mediaOf(store, 'Café Pendule');
    expect(cafe).toHaveLength(1);
    const cafeId = store.repo.queryPlaces({ source: 'mine' }).find((p) => p.name === 'Café Pendule')!.id;
    expect(cafe[0]!.id).toBe(remotePhotoId(cafeId, '1c9e1534-2d71-4d94-955a-c5aad5da750e.jpg'));
    const doc = JSON.stringify(exportGeoJson(store));
    expect(doc).not.toContain(PHOTO_HOST);
    expect(doc).not.toContain('1c9e1534');

    // Again, merging into my places: the photos are already there, nothing is downloaded.
    const again = setMergeExisting(await planFor(store), true);
    const second = fakePhotos(store, async () => IMAGE);
    const r2 = await applyImport(store, again, second.opts);
    expect(second.calls).toEqual([]);
    expect(r2.counts).toMatchObject({ merged: 4, remotePhotos: 0 });
    expect(mediaOf(store, 'Café Pendule')).toHaveLength(1);
  });

  it('a failed full-size download falls back to the thumbnail; failures are counted, never an import error', async () => {
    const store = openStore();
    const { calls, opts } = fakePhotos(store, async (url) => {
      if (url.includes('1c9e1534') && url.includes('mode=full')) throw new Error('HTTP 500');
      if (url.includes('97d9cd32')) throw new Error('HTTP 404');
      return IMAGE;
    });
    const report = await applyImport(store, await planFor(store), opts);
    expect(report.counts).toMatchObject({ created: 4, remotePhotos: 1, remotePhotosFailed: 1 });
    expect(report.photoDownloadBlocked).toBeUndefined();
    expect(calls.filter((u) => u.includes('97d9cd32'))).toHaveLength(2);
    expect(mediaOf(store, 'Café Pendule')).toHaveLength(1);
    expect(mediaOf(store, 'Le Bar Imaginaire')).toHaveLength(0);
  });

  it('a download that never answers is given up after the timeout', async () => {
    const store = openStore();
    const { opts } = fakePhotos(store, () => new Promise<Uint8Array>(() => undefined));
    const report = await applyImport(store, await planFor(store), { ...opts, photoTimeoutMs: 20 });
    expect(report.counts).toMatchObject({ created: 4, remotePhotos: 0, remotePhotosFailed: 2 });
  });

  it('blocked by the platform (web: cross-origin): stops at the first one, says so; the places are imported', async () => {
    const store = openStore();
    const { calls, opts } = fakePhotos(store, async () => {
      throw new PhotoDownloadBlockedError();
    });
    const report = await applyImport(store, await planFor(store), { ...opts, photoConcurrency: 1 });
    expect(calls).toHaveLength(1);
    expect(report.photoDownloadBlocked).toBe(true);
    expect(report.cancelled).toBe(false);
    expect(report.counts).toMatchObject({ created: 4, remotePhotos: 0, remotePhotosFailed: 2 });
  });

  it('cancel stops the downloads', async () => {
    const store = openStore();
    const ac = new AbortController();
    const { calls, opts } = fakePhotos(store, (_url, signal) => {
      ac.abort();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const report = await applyImport(store, await planFor(store), { ...opts, signal: ac.signal, photoConcurrency: 1 });
    expect(calls).toHaveLength(1);
    expect(report.cancelled).toBe(true);
    expect(report.counts.remotePhotos).toBe(0);
  });

  it('undo: new places go to the trash with their photos; photos added to my existing places are removed', async () => {
    const store = openStore();
    // My own save of the café, 10 m away: the import merges into it.
    store.change((tx) => tx.putSave({ place: { id: 'local:mine0001', name: 'Café Pendule', category: null, kind: 'place', geometry: { type: 'Point', coordinates: [2.36199, 48.85913] } } }));
    const { opts } = fakePhotos(store, async () => IMAGE);
    const plan = setMergeExisting(await planFor(store), true);
    const report = await applyImport(store, plan, opts);
    expect(report.counts).toMatchObject({ created: 3, merged: 1, remotePhotos: 2 });
    const mine = store.repo.getMySaveForPlace('local:mine0001')!;
    expect(store.repo.getMedia(mine.id)).toHaveLength(1);
    expect(report.merged[0]!.addedMediaIds).toHaveLength(1);
    await undoImport(store, report, { yieldFn: noYield });
    expect(store.repo.getMedia(store.repo.getMySaveForPlace('local:mine0001')!.id)).toHaveLength(0);
    const bar = store.repo.getMySaveForPlace(report.createdPlaceIds.find((id) => store.repo.getPlace(id)?.name === 'Le Bar Imaginaire')!)!;
    expect(bar.deletedAt).not.toBeNull();
  });

  it('remotePhotoId: stable, per place and photo, a valid photo id', () => {
    const a = remotePhotoId('local:abc', 'x.jpg');
    expect(a).toBe(remotePhotoId('local:abc', 'x.jpg'));
    expect(a).not.toBe(remotePhotoId('local:abd', 'x.jpg'));
    expect(a).not.toBe(remotePhotoId('local:abc', 'y.jpg'));
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
