import { describe, expect, it } from 'vitest';
import { OsmError } from '../src/errors.ts';
import { NominatimClient, PhotonClient, PlaceSearch, SearchSession } from '../src/search.ts';
import { deferredResponse, fakeFetch, fixture, json, testHttp, type FakeFetch } from './support/fake.ts';

const PHOTON = 'https://photon.test';
const NOMINATIM = 'https://nominatim.test';
const near = { lat: 48.859, lon: 2.362 };

function setup(ff: FakeFetch) {
  const http = testHttp(ff);
  const photon = new PhotonClient({ http, baseUrl: PHOTON });
  const nominatim = new NominatimClient({ http, baseUrl: NOMINATIM, email: 'dev@triangulair.example' });
  return { photon, nominatim, search: new PlaceSearch(photon, nominatim) };
}

describe('Photon (recorded responses)', () => {
  it('search: params and parsed results', async () => {
    const ff = fakeFetch().on(`${PHOTON}/api`, fixture('search/photon-trattoria.json'));
    const { photon } = setup(ff);
    const r = await photon.search('trattoria lucia', { near, lang: 'fr-FR', limit: 5 });
    const url = new URL(ff.calls[0]!.url);
    expect(url.pathname).toBe('/api');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'trattoria lucia', limit: '5', lang: 'fr', lat: '48.859', lon: '2.362' });

    expect(r[0]).toMatchObject({
      source: 'photon',
      ref: { type: 'node', id: 9123456702 },
      name: 'Trattoria Da Lucia',
      label: '12 Rue de Bretagne, 75003 Paris',
      kind: 'poi',
      category: 'restaurant',
      address: { country: 'FR', city: 'Paris' },
    });
    expect(r[0]!.distance).toBeLessThan(50);
    expect(r[1]!.extent).toEqual({ south: 45.7577, west: 4.8319, north: 45.7579, east: 4.8321 });
    expect(r[2]).toMatchObject({ kind: 'street', category: null, label: 'Paris, Île-de-France, France' });
  });

  it('drops unsupported languages instead of getting a 400', async () => {
    const ff = fakeFetch().on(`${PHOTON}/api`, fixture('search/photon-trattoria.json'));
    await setup(ff).photon.search('x', { lang: 'ja' });
    expect(new URL(ff.calls[0]!.url).searchParams.has('lang')).toBe(false);
  });

  it('reverse geocoding of a long press', async () => {
    const ff = fakeFetch().on(`${PHOTON}/reverse`, fixture('search/photon-reverse.json'));
    const r = await setup(ff).photon.reverse({ lat: 48.85924, lon: 2.36253 });
    expect(r).toMatchObject({ name: '16 Rue de Bretagne', kind: 'address' });
  });
});

describe('Nominatim (recorded responses)', () => {
  it('search: jsonv2, addressdetails, email, viewbox', async () => {
    const ff = fakeFetch().on(`${NOMINATIM}/search`, fixture('search/nominatim-trattoria.json'));
    const r = await setup(ff).nominatim.search('trattoria lucia', {
      mode: 'submit',
      near,
      bbox: { south: 48.85, west: 2.35, north: 48.87, east: 2.37 },
      lang: 'fr',
    });
    const p = new URL(ff.calls[0]!.url).searchParams;
    expect(p.get('format')).toBe('jsonv2');
    expect(p.get('addressdetails')).toBe('1');
    expect(p.get('email')).toBe('dev@triangulair.example');
    expect(p.get('accept-language')).toBe('fr');
    expect(p.get('viewbox')).toBe('2.35,48.87,2.37,48.85');
    expect(r[0]).toMatchObject({
      source: 'nominatim',
      ref: { type: 'node', id: 9123456702 },
      name: 'Trattoria Da Lucia',
      kind: 'poi',
      category: 'restaurant',
      location: { lat: 48.8591004, lon: 2.3621507 },
      label: '12 Rue de Bretagne, 75003 Paris',
    });
    expect(r[1]).toMatchObject({ kind: 'street', extent: { south: 48.8531, north: 48.8537, west: 2.348, east: 2.3495 } });
  });

  it('refuses autocomplete (usage policy)', async () => {
    const ff = fakeFetch();
    await expect(setup(ff).nominatim.search('tra', { mode: 'autocomplete' })).rejects.toBeInstanceOf(OsmError);
    expect(ff.calls).toHaveLength(0);
  });

  it('reverse', async () => {
    const ff = fakeFetch().on(`${NOMINATIM}/reverse`, fixture('search/nominatim-reverse.json'));
    const r = await setup(ff).nominatim.reverse({ lat: 48.85924, lon: 2.36253 });
    expect(r).toMatchObject({ name: '16 Rue de Bretagne, 75003 Paris', kind: 'address', address: { housenumber: '16' } });
    const ff2 = fakeFetch().on(`${NOMINATIM}/reverse`, json({ error: 'Unable to geocode' }));
    expect(await setup(ff2).nominatim.reverse({ lat: 0, lon: 0 })).toBeNull();
  });
});

describe('PlaceSearch fallback', () => {
  it('autocomplete never calls Nominatim, even if Photon is down', async () => {
    const ff = fakeFetch().on(PHOTON, new Response('', { status: 502 }));
    const { search } = setup(ff);
    await expect(search.search('trattoria')).rejects.toBeInstanceOf(OsmError);
    expect(ff.calls.every((c) => c.url.startsWith(PHOTON))).toBe(true);
  });

  it('submit falls back to Nominatim when Photon is down', async () => {
    const ff = fakeFetch()
      .on(PHOTON, new Response('', { status: 503 }))
      .on(NOMINATIM, fixture('search/nominatim-trattoria.json'));
    const r = await setup(ff).search.search('trattoria', { mode: 'submit' });
    expect(r[0]!.source).toBe('nominatim');
  });

  it('submit falls back to Nominatim when Photon finds nothing', async () => {
    const ff = fakeFetch()
      .on(PHOTON, json({ type: 'FeatureCollection', features: [] }))
      .on(NOMINATIM, fixture('search/nominatim-trattoria.json'));
    const r = await setup(ff).search.search('trattoria', { mode: 'submit' });
    expect(r[0]!.source).toBe('nominatim');
  });

  it('submit does not hide client errors behind the fallback', async () => {
    const ff = fakeFetch().on(PHOTON, new Response('bad', { status: 400 }));
    await expect(setup(ff).search.search('x', { mode: 'submit' })).rejects.toBeInstanceOf(OsmError);
    expect(ff.calls).toHaveLength(1);
  });

  it('reverse falls back to Nominatim', async () => {
    const ff = fakeFetch()
      .on(PHOTON, new Response('', { status: 500 }))
      .on(NOMINATIM, fixture('search/nominatim-reverse.json'));
    expect((await setup(ff).search.reverse(near))?.source).toBe('nominatim');
  });
});

describe('SearchSession (search as you type)', () => {
  it('debounces keystrokes: only the last text is sent', async () => {
    const ff = fakeFetch().on(PHOTON, fixture('search/photon-trattoria.json'));
    const s = new SearchSession(setup(ff).search, { debounceMs: 5 });
    const p1 = s.update('tra');
    const p2 = s.update('trat');
    const p3 = s.update('tratt');
    expect(await p1).toBeNull();
    expect(await p2).toBeNull();
    expect((await p3)?.length).toBe(3);
    expect(ff.calls).toHaveLength(1);
    expect(new URL(ff.calls[0]!.url).searchParams.get('q')).toBe('tratt');
  });

  it('aborts the in-flight request when the text changes', async () => {
    const d = deferredResponse({ type: 'FeatureCollection', features: [] });
    const ff = fakeFetch()
      .on('q=trat&', d.respond)
      .on('q=tratt&', fixture('search/photon-trattoria.json'));
    const s = new SearchSession(setup(ff).search, { debounceMs: 1 });
    const p1 = s.update('trat');
    await new Promise((r) => setTimeout(r, 10));
    const p2 = s.update('tratt');
    expect(await p1).toBeNull();
    expect(ff.calls[0]!.signal!.aborted).toBe(true);
    expect((await p2)?.[0]?.name).toBe('Trattoria Da Lucia');
  });

  it('ignores text shorter than minLength', async () => {
    const ff = fakeFetch();
    const s = new SearchSession(setup(ff).search, { minLength: 3 });
    expect(await s.update('tr')).toBeNull();
    expect(ff.calls).toHaveLength(0);
  });
});
