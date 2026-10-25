import { describe, expect, it } from 'vitest';
import { CATEGORIES, CATEGORY_IDS, categorize, isCategoryId } from '../src/categories.ts';

describe('categorize', () => {
  it.each([
    [{ amenity: 'restaurant' }, 'restaurant'],
    [{ amenity: 'fast_food' }, 'fast_food'],
    [{ amenity: 'cafe' }, 'cafe'],
    [{ amenity: 'biergarten' }, 'bar'],
    [{ amenity: 'pub' }, 'pub'],
    [{ shop: 'bakery' }, 'bakery'],
    [{ shop: 'cheese' }, 'food_shop'],
    [{ shop: 'wine' }, 'wine_shop'],
    [{ shop: 'books' }, 'bookshop'],
    [{ shop: 'shoes' }, 'clothes'],
    [{ shop: 'hardware' }, 'shop'],
    [{ shop: 'vacant' }, 'shop'],
    [{ tourism: 'museum', museum: 'art' }, 'museum'],
    [{ tourism: 'gallery' }, 'gallery'],
    [{ tourism: 'guest_house' }, 'hotel'],
    [{ historic: 'castle' }, 'monument'],
    [{ leisure: 'park' }, 'park'],
    [{ natural: 'beach' }, 'beach'],
    [{ amenity: 'pharmacy' }, 'service'],
    [{ craft: 'brewery' }, 'service'],
  ] as const)('%o → %s', (tags, expected) => {
    expect(categorize(tags)?.category).toBe(expected);
  });

  it('prefers amenity over a building or historic tag', () => {
    expect(categorize({ historic: 'building', amenity: 'restaurant' })).toEqual({
      category: 'restaurant',
      key: 'amenity',
      value: 'restaurant',
    });
  });

  it('ignores street furniture and infrastructure', () => {
    expect(categorize({ amenity: 'bench' })).toBeNull();
    expect(categorize({ amenity: 'parking', name: 'P1' })).toBeNull();
    expect(categorize({ building: 'yes' })).toBeNull();
  });

  it('falls back to lifecycle-prefixed tags', () => {
    expect(categorize({ 'disused:amenity': 'restaurant', name: 'Old place' })).toEqual({
      category: 'restaurant',
      key: 'amenity',
      value: 'restaurant',
      lifecyclePrefix: 'disused',
    });
    expect(categorize({ 'was:shop': 'books' })?.lifecyclePrefix).toBe('was');
  });

  it('has a stable, complete id list', () => {
    // Stored in the database: this snapshot must only ever grow at the end.
    expect(CATEGORY_IDS.slice(0, 8)).toEqual(['restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'nightclub', 'ice_cream', 'bakery']);
    expect(new Set(CATEGORY_IDS).size).toBe(CATEGORY_IDS.length);
    for (const id of CATEGORY_IDS) expect(CATEGORIES[id].icon).toBeTruthy();
    expect(isCategoryId('museum')).toBe(true);
    expect(isCategoryId('spaceport')).toBe(false);
  });
});
