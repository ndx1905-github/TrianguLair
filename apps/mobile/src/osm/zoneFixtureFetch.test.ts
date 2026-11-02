import { describe, expect, it } from 'vitest';

import { neighbourhoodQuery, nominatimAreaUrl, streetsQuery } from '../zones/osmZones';
import { withZoneFixtures } from './zoneFixtureFetch';
import { loadZoneFixtures } from './zoneFixtures';

describe('zone fixture fetch', () => {
  const next = async () => new Response('next', { status: 200 });
  const f = withZoneFixtures(loadZoneFixtures(), next, 0);
  const post = (ql: string) => ({ method: 'POST', body: `data=${encodeURIComponent(ql)}` });

  it('answers neighbourhood and street queries, passes the rest on', async () => {
    const n = await (await f('https://overpass/api/interpreter', post(neighbourhoodQuery([2.35, 48.85, 2.37, 48.87])))).json();
    expect(n.elements).toHaveLength(4);
    const s = await (await f('https://overpass/api/interpreter', post(streetsQuery([2.35, 48.85, 2.37, 48.87])))).json();
    expect(s.elements.length).toBeGreaterThan(4);
    expect(await (await f('https://overpass/api/interpreter', post('node(id:1);'))).text()).toBe('next');
  });

  it('answers Nominatim polygon searches by name', async () => {
    const r = await (await f(nominatimAreaUrl('https://nominatim.openstreetmap.org', 'Enfants Rouges'))).json();
    expect(r.map((a: { name: string }) => a.name)).toEqual(['Enfants-Rouges']);
    const paris = await (await f(nominatimAreaUrl('https://nominatim.openstreetmap.org', 'paris'))).json();
    expect(paris.length).toBe(5); // the four quarters are "…, Paris" too
  });
});
