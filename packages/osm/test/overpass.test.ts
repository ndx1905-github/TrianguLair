import { describe, expect, it } from 'vitest';
import { AbortError, InvalidArgumentError, RateLimitedError } from '../src/errors.ts';
import { MemoryCache } from '../src/http/cache.ts';
import { OverpassClient, OverpassRuntimeError, buildAroundQuery, buildElementsQuery } from '../src/overpass.ts';
import { fakeFetch, fixture, testHttp } from './support/fake.ts';

const A = 'https://overpass-a.test/api/interpreter';
const B = 'https://overpass-b.test/api/interpreter';
const center = { lat: 48.859, lon: 2.362 };

const decode = (body: string | undefined) => decodeURIComponent((body ?? '').replace(/^data=/, ''));

describe('query builders', () => {
  it('around query: named POIs, center for ways, capped output', () => {
    expect(buildAroundQuery(center, 150)).toBe(
      [
        '[out:json][timeout:25];',
        'nwr(around:150,48.859,2.362)[name][~"^(amenity|shop|tourism|leisure|historic|craft|office|natural)$"~"."];',
        'out tags center qt 500;',
      ].join('\n'),
    );
  });

  it('elements query groups and sorts ids by type', () => {
    expect(
      buildElementsQuery([
        { type: 'way', id: 5 },
        { type: 'node', id: 3 },
        { type: 'node', id: 1 },
        { type: 'relation', id: 9 },
        { type: 'node', id: 3 },
      ]),
    ).toBe('[out:json][timeout:25];\n(node(id:1,3);way(id:5);rel(id:9););\nout meta center;');
  });

  it('refuses invalid input instead of injecting it into QL', () => {
    expect(() => buildAroundQuery({ lat: Number.NaN, lon: 0 }, 10)).toThrow(InvalidArgumentError);
    expect(() => buildElementsQuery([{ type: 'node', id: -1 }])).toThrow(InvalidArgumentError);
    expect(() => buildElementsQuery([{ type: 'node);out;' as 'node', id: 1 }])).toThrow(InvalidArgumentError);
  });
});

describe('OverpassClient against recorded responses', () => {
  it('nearby: POSTs the query, drops non-places, sorts by distance', async () => {
    const ff = fakeFetch().on('around', fixture('overpass/nearby-marais.json'));
    const client = new OverpassClient({ http: testHttp(ff), endpoints: [A] });
    const places = await client.nearby(center, { radius: 150 });

    expect(ff.calls[0]).toMatchObject({ url: A, method: 'POST' });
    expect(ff.calls[0]!.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(decode(ff.calls[0]!.body)).toContain('nwr(around:150,48.859,2.362)');

    const names = places.map((p) => p.name);
    expect(names).not.toContain('Parking Saint-Gilles');
    expect(names[0]).toBe('Café Pendule');
    for (let i = 1; i < places.length; i++) expect(places[i]!.distance).toBeGreaterThanOrEqual(places[i - 1]!.distance);
    expect(places.find((p) => p.ref.type === 'way')?.category).toBe('museum');
  });

  it('nearby honors limit and caches the answer', async () => {
    const ff = fakeFetch().on('around', fixture('overpass/nearby-marais.json'));
    const client = new OverpassClient({ http: testHttp(ff, { cache: new MemoryCache() }), endpoints: [A] });
    expect(await client.nearby(center, { limit: 3 })).toHaveLength(3);
    await client.nearby(center, { limit: 3 });
    expect(ff.calls).toHaveLength(1);
  });

  it('getPlace returns a normalized card with meta', async () => {
    const ff = fakeFetch().on('node(id:9123456702)', fixture('overpass/element-restaurant.json'));
    const client = new OverpassClient({ http: testHttp(ff), endpoints: [A] });
    const p = await client.getPlace({ type: 'node', id: 9123456702 });
    expect(p).toMatchObject({ name: 'Trattoria Da Lucia', version: 5, address: { country: 'FR' } });
  });

  it('getElements reports missing elements and batches the ids', async () => {
    const ff = fakeFetch()
      .on('node(id:9123456702,9123456720)', fixture('overpass/elements-refresh.json'))
      .on('node(id:9123456730)', fixture('overpass/empty.json'));
    const client = new OverpassClient({ http: testHttp(ff), endpoints: [A] });
    const r = await client.getElements(
      [
        { type: 'node', id: 9123456702 },
        { type: 'node', id: 9123456720 },
        { type: 'node', id: 9123456730 },
      ],
      { batchSize: 2 },
    );
    expect(ff.calls).toHaveLength(2);
    expect(r.found.has('node/9123456702')).toBe(true);
    expect(r.missing).toEqual([{ type: 'node', id: 9123456730 }]);
    expect(r.dataTimestamp).toBe('2026-10-25T06:41:12Z');
  });

  it('fails over to the next endpoint on 429 and on runtime errors, without caching errors', async () => {
    const ff = fakeFetch()
      .on((c) => c.url === A, new Response('Too Many Requests', { status: 429 }), 1)
      .on((c) => c.url === A, fixture('overpass/runtime-error.json'), 1)
      .on((c) => c.url === B, fixture('overpass/nearby-marais.json'));
    const cache = new MemoryCache();
    const client = new OverpassClient({ http: testHttp(ff, { cache }), endpoints: [A, B] });
    expect((await client.nearby(center)).length).toBeGreaterThan(0);
    expect(ff.calls.map((c) => c.url)).toEqual([A, B]);
    // Cached under an endpoint-independent key: served from cache next time.
    await client.nearby(center);
    expect(ff.calls).toHaveLength(2);

    await client.nearby({ lat: 48.86, lon: 2.36 });
    expect(ff.calls.map((c) => c.url)).toEqual([A, B, A, B]);
  });

  it('throws OverpassRuntimeError on a timed-out query when no endpoint is left', async () => {
    const ff = fakeFetch().on('around', fixture('overpass/runtime-error.json'));
    const client = new OverpassClient({ http: testHttp(ff, { maxRetries: 0 }), endpoints: [A] });
    await expect(client.nearby(center)).rejects.toBeInstanceOf(OverpassRuntimeError);
  });

  it('surfaces RateLimitedError after the last endpoint', async () => {
    const ff = fakeFetch().on('around', new Response('', { status: 429 }));
    const client = new OverpassClient({ http: testHttp(ff, { maxRetries: 0 }), endpoints: [A, B] });
    await expect(client.nearby(center)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('does not fail over when the caller aborts', async () => {
    const ff = fakeFetch().on('around', () => new Promise<Response>(() => {}));
    const client = new OverpassClient({ http: testHttp(ff), endpoints: [A, B] });
    const ac = new AbortController();
    const p = client.nearby(center, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(ff.calls.map((c) => c.url)).toEqual([A]);
  });

  it('refuses too large areas', async () => {
    const client = new OverpassClient({ http: testHttp(fakeFetch()), endpoints: [A] });
    await expect(client.inBBox({ south: 48, west: 2, north: 49, east: 3 })).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('inBBox sorts by distance from the given center', async () => {
    const ff = fakeFetch().on('nwr(48.858', fixture('overpass/nearby-marais.json'));
    const client = new OverpassClient({ http: testHttp(ff), endpoints: [A] });
    const places = await client.inBBox(
      { south: 48.858, west: 2.36, north: 48.861, east: 2.365 },
      { center: { lat: 48.8601, lon: 2.3633 } },
    );
    expect(places[0]!.name).toBe('Fromagerie Martin');
  });
});
