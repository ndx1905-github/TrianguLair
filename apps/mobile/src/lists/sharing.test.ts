import { describe, expect, it } from 'vitest';
import type { PlaceRecord } from '@triangulair/data';
import type { FollowedListInfo, PlaceFeature } from '@triangulair/sync';

import { buildListLink, featurePins, goneKey, groupByAuthor, homeLikePlaces, listFragmentOf } from './sharing';

const placeRec = (p: Partial<PlaceRecord>): PlaceRecord => ({ id: 'osm:node/1', osmType: 'node', osmId: 1, name: 'X', category: 'amenity=cafe', kind: 'place', address: null, ...p }) as PlaceRecord;

describe('list links', () => {
  it('builds and finds list links in any text', () => {
    const l = buildListLink('AQEabc_-');
    expect(l).toBe('https://triangulair.app/l#AQEabc_-');
    expect(listFragmentOf(`Look: ${l} (my brunch list)`)).toBe('AQEabc_-');
    expect(listFragmentOf('triangulair://l#AQEabc')).toBe('AQEabc');
    expect(listFragmentOf('https://triangulair.app/i#AQEabc')).toBeNull(); // an invitation
    expect(listFragmentOf('nothing')).toBeNull();
    expect(() => buildListLink('a b')).toThrow();
  });
});

describe('before going public', () => {
  it('flags places that may be a home: dwellings, addresses without category, points placed by hand', () => {
    const homes = homeLikePlaces([
      placeRec({ id: 'osm:node/1', name: 'Cafe' }),
      placeRec({ id: 'osm:way/2', name: 'House', category: 'building=house' }),
      placeRec({ id: 'osm:node/3', name: 'Address', category: null, address: '3 rue X' }),
      placeRec({ id: 'local:abcdefgh', osmType: null, osmId: null, name: 'Pin', category: null }),
      placeRec({ id: 'local:zzzzzzzz', osmType: null, osmId: null, name: 'Hand cafe', category: 'amenity=cafe' }),
      placeRec({ id: 'local:zoneaaaa', osmType: null, osmId: null, name: 'Zone', category: null, kind: 'zone' }),
    ]);
    expect(homes.map((p) => p.name)).toEqual(['House', 'Address', 'Pin']);
  });
});

describe('followed lists', () => {
  const info = (id: string, owner: string, name: string, author?: string): FollowedListInfo => ({
    id,
    link: 'x',
    kind: 'link',
    owner,
    location: 'https://a.example/',
    name,
    count: 1,
    gone: null,
    lastSuccess: null,
    lastError: null,
    ...(author && { author }),
  });

  it('groups by author, with my name for them first', () => {
    const g = groupByAuthor([info('1', 'ed25519:b', 'Zinc'), info('2', 'ed25519:a', 'Brunch', 'Anna'), info('3', 'ed25519:b', 'Apéro', 'Ben')], (o) => (o === 'ed25519:b' ? 'Benoît' : undefined));
    expect(g.map((x) => [x.name, x.lists.map((l) => l.name)])).toEqual([
      ['Anna', ['Brunch']],
      ['Benoît', ['Apéro', 'Zinc']],
    ]);
    expect(goneKey('deleted')).toBe('sharing.gone.deleted');
    expect(goneKey('link-dead')).toBe('sharing.gone.linkDead');
  });

  it('preview pins carry the author tag colors and a zone badge', () => {
    const f = (id: string, kind?: 'zone'): PlaceFeature => ({
      type: 'Feature',
      id,
      geometry: kind ? { type: 'Polygon', coordinates: [[[2, 48], [2.1, 48], [2.1, 48.1], [2, 48]]] } : { type: 'Point', coordinates: [2.35, 48.85] },
      properties: { name: id, created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', ...(kind && { kind }), tags: [{ name: 'Pizza', color: '#EF4444', icon: 'pizza' }] },
    });
    const [p, z] = featurePins([f('osm:node/1'), f('local:zoneaaaa', 'zone')]);
    expect(p).toMatchObject({ id: 'osm:node/1', lat: 48.85, lon: 2.35, colors: ['#EF4444'], faded: false });
    expect(z!.badge).toBe(true);
  });
});
