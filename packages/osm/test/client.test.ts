import { describe, expect, it } from 'vitest';
import * as osm from '../src/index.ts';
import { TEST_UA, fakeClock, fakeFetch, fixture, fixtureJson } from './support/fake.ts';

describe('createOsmClient', () => {
  it('runs without a DOM (React Native-like environment)', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    expect(osm.detectPlatform()).toBe('native');
  });

  it('refuses to start without an identifying User-Agent', () => {
    expect(() => osm.createOsmClient({ userAgent: '' })).toThrow(osm.OsmError);
  });

  it('uses configured endpoints, never hardcoded ones', async () => {
    const ff = fakeFetch()
      .on('https://my-overpass.example/api/interpreter', fixture('overpass/nearby-marais.json'))
      .on('https://my-photon.example/api', fixture('search/photon-trattoria.json'));
    const c = osm.createOsmClient({
      userAgent: TEST_UA,
      fetch: ff.fetch,
      platform: 'native',
      endpoints: { overpass: ['https://my-overpass.example/api/interpreter/'], photon: 'https://my-photon.example/' },
      http: { clock: fakeClock() },
    });
    expect((await c.overpass.nearby({ lat: 48.859, lon: 2.362 })).length).toBeGreaterThan(0);
    expect((await c.search.search('trattoria')).length).toBe(3);
    expect(ff.calls.map((x) => new URL(x.url).host)).toEqual(['my-overpass.example', 'my-photon.example']);
    expect(ff.calls.every((x) => x.headers['user-agent'] === TEST_UA)).toBe(true);
  });

  it('placePhotos: Commons first, Panoramax only as a fallback', async () => {
    const ff = fakeFetch()
      .on('wikidata', fixture('photos/wikidata-Q99999901.json'))
      .on('generator=categorymembers', fixture('photos/commons-category-museum.json'))
      .on('commons', fixture('photos/commons-imageinfo-museum.json'))
      .on('panoramax', fixture('photos/panoramax-search.json'));
    const c = osm.createOsmClient({ userAgent: TEST_UA, fetch: ff.fetch, platform: 'native', http: { clock: fakeClock() } });
    const museum = osm.normalizeElement(
      fixtureJson<{ elements: osm.OsmElement[] }>('overpass/nearby-marais.json').elements.find((e) => e.id === 412345678)!,
    )!;
    const photos = await c.placePhotos(museum);
    expect(photos.every((p) => p.source === 'wikimedia_commons')).toBe(true);

    const cafe = { tags: { amenity: 'cafe' }, location: { lat: 48.8591, lon: 2.36215 } };
    const street = await c.placePhotos(cafe);
    expect(street.map((p) => p.source)).toEqual(['panoramax', 'panoramax']);
    expect(street.every((p) => p.attribution.includes('via Panoramax'))).toBe(true);
  });

  it('exposes OSM attribution text', () => {
    expect(osm.ATTRIBUTIONS.osm.text).toBe('© OpenStreetMap contributors');
  });
});
