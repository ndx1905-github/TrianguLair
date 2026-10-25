import { describe, expect, it } from 'vitest';
import { rankByDistance, type SearchResult } from '@triangulair/osm';

import { annotate, byDistance, canSave, defaultForm, fromNearby, fromSearch, makeMain, manualCandidate, nearbyRadius, suggestTags, toSaveInput } from './add';
import type { AppTag } from './model';

const center = { lat: 48.8592, lon: 2.3625 };
const nearby = rankByDistance(
  [
    { type: 'node', id: 2, lat: 48.8591, lon: 2.3621, tags: { name: 'Trattoria', amenity: 'restaurant', 'addr:street': 'Rue de Bretagne', 'addr:housenumber': '12' } },
    { type: 'node', id: 1, lat: 48.8596, lon: 2.3632, tags: { name: 'Comptoir', amenity: 'bar' } },
    { type: 'node', id: 3, lat: 48.8581, lon: 2.3655, tags: { name: 'Far café', amenity: 'cafe' } },
  ],
  center,
  10,
);
const TAGS: AppTag[] = [
  { id: 't-resto', name: 'Restaurant', color: '#EF4444', icon: 'restaurant', parentId: null, osmCategories: ['amenity=restaurant'] },
  { id: 't-bar', name: 'Bar', color: '#8B5CF6', icon: 'bar', parentId: null, osmCategories: ['amenity=bar'] },
];

describe('candidates', () => {
  it('nearby places become candidates with their OSM identity and category', () => {
    const c = nearby.map(fromNearby).filter((x) => x !== null);
    expect(c.map((x) => x!.name)).toEqual(['Trattoria', 'Comptoir', 'Far café']);
    expect(c[0]).toMatchObject({ placeId: 'osm:node/2', osmCategory: 'amenity=restaurant', ref: { type: 'node', id: 2 } });
    expect(c[0]!.address).toContain('Rue de Bretagne');
    expect(c[0]!.tags?.amenity).toBe('restaurant');
  });

  it('marks places already in my places or saved by friends, and drops duplicates', () => {
    const c = nearby.map(fromNearby).filter((x) => x !== null) as ReturnType<typeof fromNearby>[];
    const out = annotate([...c, c[0]!] as never, (id) => (id === 'osm:node/2' ? { mine: true, friendsCount: 2 } : null));
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ alreadyMine: true, friendsCount: 2 });
    expect(out[1]).toMatchObject({ alreadyMine: false, friendsCount: 0 });
  });

  it('search results: POIs keep their OSM id, addresses become new points', () => {
    const poi: SearchResult = { source: 'photon', ref: { type: 'node', id: 7 }, name: 'Trattoria', label: 'Paris', location: center, kind: 'poi', category: 'restaurant', osmKey: 'amenity', osmValue: 'restaurant', address: {}, distance: 40 };
    const street: SearchResult = { ...poi, ref: { type: 'way', id: 8 }, kind: 'street', name: 'Rue de Bretagne' };
    expect(fromSearch(poi, 0)).toMatchObject({ placeId: 'osm:node/7', osmCategory: 'amenity=restaurant', distance: 40 });
    expect(fromSearch(street, 1)).toMatchObject({ placeId: null, ref: null });
  });

  it('sorts by distance, unknown distances last', () => {
    const a = manualCandidate(center);
    const list = [{ ...a, key: 'x', distance: null }, { ...a, key: 'y', distance: 50 }, { ...a, key: 'z', distance: 10 }];
    expect(list.sort(byDistance).map((x) => x.key)).toEqual(['z', 'y', 'x']);
  });
});

describe('form and save', () => {
  it('pre-selects my tags linked to the OSM category; spec defaults', () => {
    const c = fromNearby(nearby[0]!)!;
    const form = defaultForm(c, suggestTags(c, TAGS));
    expect(form).toMatchObject({ tagIds: ['t-resto'], commentVisibility: 'friends', sharing: 'friends', status: null, priceLevel: null });
  });

  it('an OSM candidate saves under its OSM id with tags, status, price and comment visibility', () => {
    const c = fromNearby(nearby[0]!)!;
    const input = toSaveInput(c, { ...defaultForm(c, ['t-bar', 't-resto']), status: 'to_try', priceLevel: 2, comment: ' Ask for the terrace ', commentVisibility: 'public', sharing: 'private' });
    expect(input.place).toMatchObject({ osm: { type: 'node', id: 2 }, name: 'Trattoria', category: 'amenity=restaurant' });
    expect(input).toMatchObject({ tagIds: ['t-bar', 't-resto'], mainTagId: 't-bar', status: 'to_try', priceLevel: 2, comment: 'Ask for the terrace', commentVisibility: 'public', sharing: 'private' });
  });

  it('a manual point needs a name and gets a local id', () => {
    const c = manualCandidate({ lat: 48.86, lon: 2.35 });
    const form = defaultForm(c, []);
    expect(canSave(c, form)).toBe(false);
    const input = toSaveInput(c, { ...form, name: 'Secret garden' }, () => 'abcdefgh12345678');
    expect(input.place).toMatchObject({ id: 'local:abcdefgh12345678', name: 'Secret garden', geometry: { type: 'Point', coordinates: [2.35, 48.86] } });
    expect(input.comment).toBeUndefined();
  });

  it('makeMain moves a tag first', () => {
    expect(makeMain(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('nearby radius follows the visible area within 150 m–1 km', () => {
    expect(nearbyRadius(null)).toBe(250);
    expect(nearbyRadius(300)).toBe(150);
    expect(nearbyRadius(1500)).toBe(500);
    expect(nearbyRadius(50_000)).toBe(1000);
  });
});
