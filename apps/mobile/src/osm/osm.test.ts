import { describe, expect, it } from 'vitest';
import { createOsmClient, NetworkError, OsmError, RateLimitedError } from '@triangulair/osm';

import { classifyOsmError } from './errors';
import { createFixtureFetch } from './fixtureFetch';
import { loadFixtures } from './fixtures';

const FIXTURES = loadFixtures();
const client = () =>
  createOsmClient({
    userAgent: 'TrianguLair-tests/0.0.1 (+https://github.com/ndx1905-github/TrianguLair)',
    fetch: createFixtureFetch(FIXTURES, { delayMs: 0 }),
    platform: 'web',
    rateLimits: { overpass: { minIntervalMs: 0, maxConcurrent: 4 }, nominatim: { minIntervalMs: 0, maxConcurrent: 4 } },
  });
const MARAIS = { lat: 48.8592, lon: 2.3625 };

describe('fixture mode', () => {
  it('serves nearby places, nearest first', async () => {
    const list = await client().overpass.nearby(MARAIS, { radius: 300 });
    expect(list.length).toBeGreaterThan(3);
    expect(list.map((p) => p.distance)).toEqual([...list.map((p) => p.distance)].sort((a, b) => a - b));
    expect(list.some((p) => p.name === 'Trattoria Da Lucia')).toBe(true);
  });

  it('search as you type finds fixture places by name, accent-insensitive', async () => {
    const osm = client();
    const r = await osm.photon.search('trattoria', { near: MARAIS });
    expect(r.map((x) => x.name)).toContain('Trattoria Da Lucia');
    const cafe = await osm.photon.search('cafe pendule', { near: MARAIS });
    expect(cafe.map((x) => x.name)).toEqual(['Café Pendule']);
  });

  it('element lookups return the requested elements only', async () => {
    const place = await client().overpass.getPlace({ type: 'way', id: 412345678 });
    expect(place?.name).toBe('Musée des Cartes Anciennes');
    expect(await client().overpass.getPlace({ type: 'node', id: 1 })).toBeNull();
  });

  it('photos come with their credit lines', async () => {
    const osm = client();
    const museum = await osm.overpass.getPlace({ type: 'way', id: 412345678 });
    const photos = await osm.placePhotos(museum!);
    expect(photos.length).toBeGreaterThan(0);
    for (const p of photos) expect(p.attribution).toMatch(/via (Wikimedia Commons|Panoramax)/);
  });
});

describe('error messages', () => {
  it('maps failures to what the user is told', () => {
    expect(classifyOsmError(new NetworkError('https://overpass-api.de', new Error('down')))).toBe('offline');
    expect(classifyOsmError(new TypeError('Failed to fetch'))).toBe('offline');
    expect(classifyOsmError(new DOMException('aborted', 'AbortError'))).toBe('aborted');
    expect(classifyOsmError(new OsmError('bad_response', 'x'))).toBe('unavailable');
    expect(classifyOsmError(new RateLimitedError(429, 'https://overpass-api.de', '', 1000))).toBe('busy');
  });
});
