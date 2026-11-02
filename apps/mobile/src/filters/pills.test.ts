import { describe, expect, it } from 'vitest';

import { activeFilterCount, type FilterState } from '../places/filters';
import { activePills, toggleValue } from './pills';

describe('collapsed summary pills', () => {
  const f: FilterState = { tagIds: ['t1'], criteria: ['openNow'], categories: ['food_drink'], cuisines: ['pizza'], maxCharge: 10, priceLevels: [2], text: ' oysters ' };

  it('one pill per active value, in bar order, matching the count', () => {
    const pills = activePills(f);
    expect(pills.map((p) => p.key)).toEqual(['tag:t1', 'category:food_drink', 'cuisine:pizza', 'criterion:openNow', 'charge:10', 'price:2', 'text:oysters']);
    expect(pills).toHaveLength(activeFilterCount(f));
  });

  it('removing a pill removes only that value; a category takes its sub-filters with it', () => {
    const pills = Object.fromEntries(activePills(f).map((p) => [p.key, p.without]));
    expect(pills['tag:t1']!.tagIds).toEqual([]);
    expect(pills['category:food_drink']).toEqual({ tagIds: ['t1'], criteria: ['openNow'], maxCharge: 10, priceLevels: [2], text: ' oysters ' });
    expect(pills['charge:10']!.maxCharge).toBeUndefined();
    expect(pills['text:oysters']!.text).toBeUndefined();
  });

  it('toggles list values and deletes empty lists', () => {
    const a = toggleValue({ tagIds: [], criteria: [] }, 'diets', 'vegan');
    expect(a.diets).toEqual(['vegan']);
    expect('diets' in toggleValue(a, 'diets', 'vegan')).toBe(false);
    expect(toggleValue(f, 'categories', 'food_drink').cuisines).toBeUndefined();
  });
});
