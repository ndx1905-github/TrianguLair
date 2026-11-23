import { describe, expect, it } from 'vitest';

import { categoryCounts } from './nearbyCategories';

describe('categories around a spot', () => {
  it('counts the categories present, most frequent first, ignoring places without one', () => {
    expect(
      categoryCounts([{ category: 'cafe' }, { category: 'restaurant' }, { category: 'cafe' }, { category: null }, {}]),
    ).toEqual([
      { key: 'cafe', count: 2 },
      { key: 'restaurant', count: 1 },
    ]);
  });
});
