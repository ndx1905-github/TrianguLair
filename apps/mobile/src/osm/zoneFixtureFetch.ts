/**
 * Fixture mode for zones: answers the neighbourhood and street Overpass
 * queries and Nominatim polygon searches with `zoneFixtures`, and passes
 * every other request to the general fixture fetch. Pure routing, tested.
 */
import { NEIGHBOURHOOD_MARK, STREETS_MARK } from '../zones/osmZones';
import type { ZoneFixtures } from './zoneFixtures';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export function withZoneFixtures(fx: ZoneFixtures, next: FetchFn, delayMs = 150): FetchFn {
  return async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? decodeURIComponent(init.body.replace(/\+/g, ' ')) : '';
    const zoneQuery = body.includes(NEIGHBOURHOOD_MARK) || body.includes(STREETS_MARK);
    const areaSearch = url.includes('polygon_geojson=1');
    if (!zoneQuery && !areaSearch) return next(input, init);
    await new Promise((r) => setTimeout(r, delayMs));
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (body.includes(NEIGHBOURHOOD_MARK)) return json({ version: 0.6, elements: fx.neighbourhoods.elements });
    if (body.includes(STREETS_MARK)) return json({ version: 0.6, elements: fx.streets.elements });
    const q = fold(new URL(url).searchParams.get('q') ?? '').trim();
    const words = q.split(/[\s,-]+/).filter(Boolean);
    return json(fx.nominatimAreas.filter((a) => words.every((w) => fold(a.display_name ?? a.name ?? '').includes(w))));
  };
}
