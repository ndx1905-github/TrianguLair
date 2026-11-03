import { describe, expect, it } from 'vitest';
import { normalizeElement } from '@triangulair/osm';

import {
  categoryOf,
  chargeValue,
  criterionValue,
  dietValue,
  effectiveTagSelection,
  expandTagSelection,
  filteredTagOf,
  matchPlace,
  pruneSubFilters,
  subDimensionsFor,
  summarize,
  type FilterablePlace,
  type FilterState,
} from './filters';
import type { AppTag } from './model';

const tag = (id: string, parentId: string | null = null): AppTag => ({ id, name: id, color: '#EF4444', icon: 'restaurant', parentId, osmCategories: [] });
const TAGS = [tag('food'), tag('pizza', 'food'), tag('neapolitan', 'pizza'), tag('bar')];
const info = (tags: Record<string, string>) => normalizeElement({ type: 'node', id: 1, lat: 48.85, lon: 2.35, tags: { name: 'X', amenity: 'restaurant', ...tags } });
// Saturday 24 October 2026, 19:30 local time.
const SAT_EVENING = new Date(2026, 9, 24, 19, 30);

describe('tag selection', () => {
  it('includes sub-tags, and survives cycles', () => {
    expect([...expandTagSelection(['food'], TAGS)].sort()).toEqual(['food', 'neapolitan', 'pizza']);
    const cyclic = [tag('a', 'b'), tag('b', 'a')];
    expect([...expandTagSelection(['a'], cyclic)].sort()).toEqual(['a', 'b']);
  });

  it('the pin takes the filtered tag, sub-tags included', () => {
    const f: FilterState = { tagIds: ['bar', 'food'], criteria: [] };
    expect(filteredTagOf({ tagIds: ['neapolitan'] }, f, TAGS)).toBe('food');
    expect(filteredTagOf({ tagIds: ['bar', 'neapolitan'] }, f, TAGS)).toBe('bar');
    expect(filteredTagOf({ tagIds: [] }, f, TAGS)).toBeNull();
  });
});

describe('criteria', () => {
  it('open now from opening_hours, unknown without it', () => {
    expect(criterionValue('openNow', info({ opening_hours: 'Mo-Su 19:00-22:30' }), SAT_EVENING)).toBe(true);
    expect(criterionValue('openNow', info({ opening_hours: 'Mo-Fr 08:00-18:00' }), SAT_EVENING)).toBe(false);
    expect(criterionValue('openNow', info({}), SAT_EVENING)).toBeNull();
    expect(criterionValue('openNow', null, SAT_EVENING)).toBeNull();
  });

  it('terrace, happy hour, vegetarian', () => {
    expect(criterionValue('terrace', info({ outdoor_seating: 'sidewalk' }), SAT_EVENING)).toBe(true);
    expect(criterionValue('terrace', info({ outdoor_seating: 'no' }), SAT_EVENING)).toBe(false);
    expect(criterionValue('terrace', info({}), SAT_EVENING)).toBeNull();
    expect(criterionValue('happyHour', info({ happy_hours: 'Mo-Sa 17:00-20:00' }), SAT_EVENING)).toBe(true);
    expect(criterionValue('happyHour', info({ happy_hours: 'Mo-Fr 17:00-20:00' }), SAT_EVENING)).toBe(false);
    expect(criterionValue('vegetarian', info({ 'diet:vegan': 'only' }), SAT_EVENING)).toBe(true);
    expect(criterionValue('vegetarian', info({ 'diet:vegetarian': 'no' }), SAT_EVENING)).toBe(false);
  });
});

describe('matching', () => {
  const ctx = (f: FilterState) => ({ tagSet: expandTagSelection(f.tagIds, TAGS), now: SAT_EVENING });

  it('tags OR, criteria AND, missing info is "unknown" (not silently excluded)', () => {
    const f: FilterState = { tagIds: ['food', 'bar'], criteria: ['terrace'] };
    expect(matchPlace({ tagIds: ['pizza'], info: info({ outdoor_seating: 'yes' }) }, f, ctx(f))).toBe('match');
    expect(matchPlace({ tagIds: ['pizza'], info: info({ outdoor_seating: 'no' }) }, f, ctx(f))).toBe('nomatch');
    expect(matchPlace({ tagIds: ['pizza'], info: info({}) }, f, ctx(f))).toBe('unknown');
    expect(matchPlace({ tagIds: ['other'], info: info({ outdoor_seating: 'yes' }) }, f, ctx(f))).toBe('nomatch');
  });

  it('no filter: everything matches', () => {
    const f: FilterState = { tagIds: [], criteria: [] };
    expect(matchPlace({ tagIds: [], info: null }, f, ctx(f))).toBe('match');
  });
});

describe('summary', () => {
  const places = [
    { tagIds: ['neapolitan'], info: info({ outdoor_seating: 'yes', opening_hours: 'Mo-Su 12:00-23:00' }) },
    { tagIds: ['bar'], info: info({ outdoor_seating: 'no' }) },
    { tagIds: ['bar'], info: null },
  ];

  it('counts places per tag (sub-tags included) and only offers documented criteria', () => {
    const s = summarize(places, { tagIds: [], criteria: [] }, TAGS, SAT_EVENING);
    expect(Object.fromEntries(s.tags.map((x) => [x.tag.id, x.count]))).toEqual({ food: 1, pizza: 1, neapolitan: 1, bar: 2 });
    expect(s.criteria.map((c) => [c.criterion, c.count, c.known])).toEqual([
      ['openNow', 1, 1],
      ['terrace', 1, 2],
    ]);
    expect(s.matching).toBe(3);
  });

  it('counts matching and unknown places for the active filter', () => {
    const s = summarize(places, { tagIds: ['bar'], criteria: ['terrace'] }, TAGS, SAT_EVENING);
    expect(s.matching).toBe(0);
    expect(s.unknown).toBe(1);
    expect(s.total).toBe(3);
  });
});

// ---------------------------------------------------------------- full filter bar (T-109)


const osm = (tags: Record<string, string>) => normalizeElement({ type: 'node', id: 1, lat: 48.85, lon: 2.35, tags: { name: 'X', ...tags } });
const base = (over: Partial<FilterablePlace> = {}): FilterablePlace => ({
  tagIds: [],
  info: null,
  category: null,
  mine: true,
  friends: false,
  status: 'open',
  saveStatus: null,
  sharing: 'friends',
  priceLevel: null,
  searchText: '',
  friendTags: [],
  ...over,
});
const run = (p: FilterablePlace, f: FilterState) => matchPlace(p, f, { tagSet: expandTagSelection(f.tagIds, TAGS), now: SAT_EVENING });

describe('tags: narrowing and friends’ tags', () => {
  it('a chosen sub-tag narrows its chosen parent', () => {
    expect(effectiveTagSelection(['food', 'pizza'], TAGS)).toEqual(['pizza']);
    expect(effectiveTagSelection(['food', 'bar'], TAGS)).toEqual(['food', 'bar']);
    expect([...expandTagSelection(['food', 'neapolitan'], TAGS)]).toEqual(['neapolitan']);
    const f: FilterState = { tagIds: ['food', 'pizza'], criteria: [] };
    expect(run(base({ tagIds: ['pizza'] }), f)).toBe('match');
    expect(run(base({ tagIds: ['food'] }), f)).toBe('nomatch');
  });

  it('friends’ unmapped tags are ORed with my tags', () => {
    const lea = { key: 'lea\nrooftop', personId: 'lea', name: 'Rooftop', color: '#0891B2', icon: 'view' };
    const f: FilterState = { tagIds: ['bar'], criteria: [], friendTags: [lea.key] };
    expect(run(base({ friendTags: [lea], mine: false }), f)).toBe('match');
    expect(run(base({ tagIds: ['bar'] }), f)).toBe('match');
    expect(run(base({ tagIds: ['food'] }), f)).toBe('nomatch');
  });
});

describe('categories and sub-filters', () => {
  it('category from OSM info or from the stored key=value', () => {
    expect(categoryOf({ category: null, info: osm({ amenity: 'bar' }) })).toEqual({ id: 'bar', group: 'food_drink' });
    expect(categoryOf({ category: 'tourism=museum', info: null })).toEqual({ id: 'museum', group: 'culture' });
    expect(categoryOf({ category: null, info: null })).toBeNull();
  });

  it('category group, then cuisine: a restaurant without cuisine is unknown, a museum is out', () => {
    const f: FilterState = { tagIds: [], criteria: [], categories: ['food_drink'], cuisines: ['pizza'] };
    expect(run(base({ info: osm({ amenity: 'restaurant', cuisine: 'italian;pizza' }) }), f)).toBe('match');
    expect(run(base({ info: osm({ amenity: 'restaurant', cuisine: 'chinese' }) }), f)).toBe('nomatch');
    expect(run(base({ info: osm({ amenity: 'restaurant' }) }), f)).toBe('unknown');
    expect(run(base({ info: osm({ tourism: 'museum' }) }), f)).toBe('nomatch');
  });

  it('museum and shop types, kinds', () => {
    expect(run(base({ info: osm({ tourism: 'museum', museum: 'art' }) }), { tagIds: [], criteria: [], categories: ['culture'], museums: ['art'] })).toBe('match');
    expect(run(base({ info: osm({ tourism: 'museum' }) }), { tagIds: [], criteria: [], museums: ['art'] })).toBe('unknown');
    expect(run(base({ info: osm({ shop: 'cheese' }) }), { tagIds: [], criteria: [], shops: ['cheese', 'wine'] })).toBe('match');
    expect(run(base({ info: osm({ amenity: 'bar' }) }), { tagIds: [], criteria: [], kinds: ['restaurant'] })).toBe('nomatch');
  });

  it('sub-filters only show under their category and are pruned with it', () => {
    expect(subDimensionsFor([])).toEqual([]);
    expect(subDimensionsFor(['food_drink', 'culture'])).toEqual(['kinds', 'cuisines', 'museums']);
    const f = pruneSubFilters({ tagIds: [], criteria: [], categories: ['culture'], kinds: ['museum', 'bar'], cuisines: ['pizza'], museums: ['art'] });
    expect(f).toEqual({ tagIds: [], criteria: [], categories: ['culture'], kinds: ['museum'], museums: ['art'] });
  });
});

describe('practical criteria, diets, entry price', () => {
  it('reservation, free entry, second-hand, organic, friends', () => {
    expect(criterionValue('reservation', osm({ reservation: 'recommended' }), SAT_EVENING)).toBe(true);
    expect(criterionValue('reservation', osm({ reservation: 'no' }), SAT_EVENING)).toBe(false);
    expect(criterionValue('freeEntry', osm({ fee: 'no' }), SAT_EVENING)).toBe(true);
    expect(criterionValue('freeEntry', osm({ charge: '12 EUR' }), SAT_EVENING)).toBe(false);
    expect(criterionValue('freeEntry', osm({}), SAT_EVENING)).toBeNull();
    expect(criterionValue('secondHand', osm({ shop: 'books', second_hand: 'only' }), SAT_EVENING)).toBe(true);
    expect(criterionValue('organic', osm({ organic: 'no' }), SAT_EVENING)).toBe(false);
    expect(criterionValue('friends', null, SAT_EVENING, undefined, { friends: true })).toBe(true);
  });

  it('diets: options or exclusively; several diets are all required', () => {
    expect(dietValue('vegan', osm({ 'diet:vegan': 'limited' }))).toBe(true);
    expect(dietValue('vegetarian', osm({ 'diet:vegan': 'only' }))).toBe(true);
    expect(dietValue('gluten_free', osm({ 'diet:gluten_free': 'no' }))).toBe(false);
    const f: FilterState = { tagIds: [], criteria: [], diets: ['vegetarian', 'gluten_free'] };
    expect(run(base({ info: osm({ 'diet:vegetarian': 'yes', 'diet:gluten_free': 'yes' }) }), f)).toBe('match');
    expect(run(base({ info: osm({ 'diet:vegetarian': 'yes' }) }), f)).toBe('unknown');
    expect(run(base({ info: osm({ 'diet:vegetarian': 'yes', 'diet:gluten_free': 'no' }) }), f)).toBe('nomatch');
  });

  it('entry under €X: free matches, the lowest price counts, unknown otherwise', () => {
    expect(chargeValue(10, osm({ fee: 'no' }))).toBe(true);
    expect(chargeValue(10, osm({ charge: '12 EUR; 8 EUR reduced' }))).toBe(true);
    expect(chargeValue(5, osm({ charge: '12 EUR' }))).toBe(false);
    expect(chargeValue(5, osm({ fee: 'yes' }))).toBeNull();
    expect(run(base({ info: osm({ tourism: 'museum', charge: '16 EUR' }) }), { tagIds: [], criteria: [], maxCharge: 15 })).toBe('nomatch');
  });
});

describe('my data: status, closed places, visibility, price, text', () => {
  it('status (none included), visibility and price level', () => {
    expect(run(base({ saveStatus: 'favorite' }), { tagIds: [], criteria: [], statuses: ['favorite', 'to_try'] })).toBe('match');
    expect(run(base({ saveStatus: null }), { tagIds: [], criteria: [], statuses: ['none'] })).toBe('match');
    expect(run(base({ sharing: 'private' }), { tagIds: [], criteria: [], visibility: ['shared'] })).toBe('nomatch');
    expect(run(base({ mine: false, sharing: null }), { tagIds: [], criteria: [], visibility: ['friendsOnly'] })).toBe('match');
    expect(run(base({ priceLevel: 2 }), { tagIds: [], criteria: [], priceLevels: [1, 2] })).toBe('match');
    expect(run(base({ priceLevel: null }), { tagIds: [], criteria: [], priceLevels: [1] })).toBe('nomatch');
  });

  it('closed places are hidden unless asked for; "maybe closed" narrows', () => {
    expect(run(base({ status: 'closed' }), { tagIds: [], criteria: [] })).toBe('hidden');
    expect(run(base({ status: 'closed' }), { tagIds: [], criteria: [], placeStatuses: ['closed'] })).toBe('match');
    expect(run(base({ status: 'open' }), { tagIds: [], criteria: [], placeStatuses: ['maybe_closed'] })).toBe('nomatch');
    expect(run(base({ status: 'maybe_closed' }), { tagIds: [], criteria: [], placeStatuses: ['maybe_closed'] })).toBe('match');
  });

  it('text: every word, accents and case ignored', () => {
    const p = base({ searchText: 'le baron rouge oysters on sunday morning bar' });
    expect(run(p, { tagIds: [], criteria: [], text: 'Oysters  BARON' })).toBe('match');
    expect(run(p, { tagIds: [], criteria: [], text: 'huîtres' })).toBe('nomatch');
  });
});

describe('summary of the full bar', () => {
  const places: FilterablePlace[] = [
    base({ info: osm({ amenity: 'restaurant', cuisine: 'italian;pizza', 'diet:vegetarian': 'yes' }), saveStatus: 'favorite', priceLevel: 2 }),
    base({ info: osm({ amenity: 'restaurant', cuisine: 'pizza' }), mine: false, friends: true, sharing: null }),
    base({ info: osm({ tourism: 'museum', museum: 'art', charge: '12 EUR' }), status: 'maybe_closed' }),
    base({ info: osm({ shop: 'books' }), status: 'closed' }),
  ];

  it('counts categories, sub-filters under the chosen category, statuses and closed places', () => {
    const s = summarize(places, { tagIds: [], criteria: [], categories: ['food_drink'] }, TAGS, SAT_EVENING);
    expect(s.total).toBe(3); // the closed one is hidden
    expect(s.categories).toEqual([
      { value: 'food_drink', count: 2 },
      { value: 'culture', count: 1 },
    ]);
    expect(s.cuisines).toEqual([
      { value: 'pizza', count: 2 },
      { value: 'italian', count: 1 },
    ]);
    expect(s.museums).toEqual([]);
    expect(s.placeStatuses).toEqual([
      { value: 'maybe_closed', count: 1 },
      { value: 'closed', count: 1 },
    ]);
    expect(s.criteria.find((c) => c.criterion === 'friends')?.count).toBe(1);
    expect(s.diets.map((d) => d.diet)).toEqual(['vegetarian']);
    expect(s.charges.map((c) => [c.value, c.count])).toEqual([[5, 0], [10, 0], [15, 1], [20, 1]]);
    expect(s.visibility.find((v) => v.value === 'friendsOnly')?.count).toBe(1);
    expect(s.priceLevels).toEqual([{ value: 2, count: 1 }]);
    expect(s.matching).toBe(2);
  });

  it('is fast enough for the map: 20,000 places under 300 ms (Node)', () => {
    const many: FilterablePlace[] = Array.from({ length: 20_000 }, (_, i) =>
      base({ tagIds: [i % 2 ? 'pizza' : 'bar'], info: places[i % 3]!.info, searchText: `place ${i}` }),
    );
    const f: FilterState = { tagIds: ['food'], criteria: ['terrace'], categories: ['food_drink'], text: 'place' };
    const t0 = performance.now();
    const ctx = { tagSet: expandTagSelection(f.tagIds, TAGS), now: SAT_EVENING };
    let n = 0;
    for (const p of many) if (matchPlace(p, f, ctx) !== 'nomatch') n++;
    expect(n).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
