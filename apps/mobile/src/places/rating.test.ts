import { describe, expect, it } from 'vitest';

import { nextRating } from './rating';

describe('rating stars', () => {
  it('a star sets the rating; the same star again removes it', () => {
    expect(nextRating(null, 3)).toBe(3);
    expect(nextRating(3, 5)).toBe(5);
    expect(nextRating(3, 1)).toBe(1);
    expect(nextRating(4, 4)).toBeNull();
  });
});
