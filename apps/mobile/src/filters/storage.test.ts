import { describe, expect, it } from 'vitest';

import { EMPTY_FILTER, type FilterState } from '../places/filters';
import { normalizeFilterState, parseFilter, pruneUnknownTags, serializeFilter } from './storage';

const FULL: FilterState = {
  tagIds: ['t1', 't2'],
  criteria: ['openNow', 'terrace'],
  friendTags: ['lea\nrooftop'],
  categories: ['food_drink'],
  kinds: ['restaurant'],
  cuisines: ['pizza'],
  museums: ['art'],
  shops: ['books'],
  diets: ['vegan'],
  maxCharge: 10,
  statuses: ['favorite', 'none'],
  placeStatuses: ['maybe_closed'],
  visibility: ['private'],
  priceLevels: [1, 2],
  text: 'oysters',
};

describe('filter storage', () => {
  it('round-trips every field, compactly and versioned', () => {
    const raw = serializeFilter(FULL);
    expect(JSON.parse(raw).v).toBe(1);
    expect(parseFilter(raw)).toEqual(FULL);
    expect(serializeFilter(EMPTY_FILTER)).toBe('{"v":1}');
    expect(parseFilter(serializeFilter(EMPTY_FILTER))).toEqual(EMPTY_FILTER);
  });

  it('never throws: garbage, wrong types and newer formats give a valid filter', () => {
    for (const raw of [null, '', 'not json', '42', '[]', '{"tagIds":"x"}', '{"v":99,"tagIds":["a"]}']) {
      expect(parseFilter(raw)).toEqual(EMPTY_FILTER);
    }
    expect(
      parseFilter(JSON.stringify({ tagIds: ['a', 'a', 3, ''], criteria: ['openNow', 'teleport'], priceLevels: [0, 2, '3'], categories: ['moon'], maxCharge: -5, text: '  ' })),
    ).toEqual({ tagIds: ['a'], criteria: ['openNow'], priceLevels: [2] });
  });

  it('migrates the old "vegetarian" criterion to the diet', () => {
    expect(normalizeFilterState({ tagIds: [], criteria: ['vegetarian', 'terrace'] })).toEqual({ tagIds: [], criteria: ['terrace'], diets: ['vegetarian'] });
  });

  it('drops tags that no longer exist, and keeps the object when nothing changes', () => {
    const f: FilterState = { tagIds: ['t1', 'gone'], criteria: [], friendTags: ['lea\nrooftop', 'lea\nold'] };
    expect(pruneUnknownTags(f, new Set(['t1']), new Set(['lea\nrooftop']))).toEqual({ tagIds: ['t1'], criteria: [], friendTags: ['lea\nrooftop'] });
    const same: FilterState = { tagIds: ['t1'], criteria: [] };
    expect(pruneUnknownTags(same, new Set(['t1']), new Set())).toBe(same);
  });
});
