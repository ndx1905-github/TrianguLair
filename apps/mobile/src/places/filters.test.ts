import { describe, expect, it } from 'vitest';
import { normalizeElement } from '@triangulair/osm';

import { criterionValue, expandTagSelection, filteredTagOf, matchPlace, summarize, type FilterState } from './filters';
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
