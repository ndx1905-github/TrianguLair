import type { Rating } from '@triangulair/data';

/** The next rating when star `n` is tapped: the same star again removes the rating. */
export function nextRating(current: Rating | null, n: Rating): Rating | null {
  return current === n ? null : n;
}
