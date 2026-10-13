import { describe, expect, it } from 'vitest';

import { placeToPin } from '../pins/fromPlace';
import { TAGS, TAG_IDS, type TagId } from '../theme/tags';
import { filterPlaces, toggleTag, usedTags, visibleTags } from './filter';
import { MOCK_PLACES } from './mockPlaces';
import type { Place } from './types';

const p = (id: string, tags: TagId[], ownerIsMe = true): Place => ({
  id,
  name: id,
  lat: 48.85,
  lon: 2.35,
  tags,
  ownerIsMe,
});

const places = [p('a', ['cafe']), p('b', ['bar', 'restaurant']), p('c', []), p('d', ['park'], false)];

describe('filterPlaces', () => {
  it('shows everything when nothing is hidden', () => {
    expect(filterPlaces(places, new Set())).toHaveLength(4);
  });

  it('hides places whose tags are all hidden', () => {
    const ids = filterPlaces(places, new Set<TagId>(['cafe', 'park'])).map((x) => x.id);
    expect(ids).toEqual(['b', 'c']);
  });

  it('keeps multi-tag places while one tag is still visible', () => {
    expect(filterPlaces(places, new Set<TagId>(['bar'])).map((x) => x.id)).toContain('b');
    expect(filterPlaces(places, new Set<TagId>(['bar', 'restaurant'])).map((x) => x.id)).not.toContain('b');
  });

  it('always shows untagged places', () => {
    expect(filterPlaces(places, new Set(TAG_IDS)).map((x) => x.id)).toEqual(['c']);
  });
});

describe('helpers', () => {
  it('visibleTags preserves order', () => {
    expect(visibleTags(p('x', ['bar', 'cafe', 'park']), new Set<TagId>(['cafe']))).toEqual(['bar', 'park']);
  });

  it('toggleTag is immutable', () => {
    const h = new Set<TagId>(['bar']);
    const h2 = toggleTag(h, 'cafe');
    expect([...h]).toEqual(['bar']);
    expect(toggleTag(h2, 'bar').has('bar')).toBe(false);
    expect(h2.has('cafe')).toBe(true);
  });

  it('usedTags follows palette order', () => {
    expect(usedTags(places, TAG_IDS)).toEqual(TAG_IDS.filter((t) => ['cafe', 'bar', 'restaurant', 'park'].includes(t)));
  });
});

describe('placeToPin', () => {
  it('uses visible tag colors, primary icon and fades friends-only places', () => {
    const pin = placeToPin(p('b', ['bar', 'restaurant'], false), new Set<TagId>(['bar']));
    expect(pin.colors).toEqual([TAGS.restaurant.color]);
    expect(pin.faded).toBe(true);
    expect(pin.iconPath.length).toBeGreaterThan(10);
  });
});

describe('mock data', () => {
  it('has ~15 valid places around Paris with known tags', () => {
    expect(MOCK_PLACES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(MOCK_PLACES.map((x) => x.id)).size).toBe(MOCK_PLACES.length);
    for (const x of MOCK_PLACES) {
      expect(x.lat).toBeGreaterThan(48.8);
      expect(x.lat).toBeLessThan(48.92);
      expect(x.lon).toBeGreaterThan(2.25);
      expect(x.lon).toBeLessThan(2.42);
      for (const t of x.tags) expect(TAGS[t]).toBeDefined();
    }
  });
});
