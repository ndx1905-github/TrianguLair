import type { TagId } from '../theme/tags';
import type { Place } from './types';

/** Tags of a place that are not hidden by the filter bar (order preserved). */
export function visibleTags(place: Place, hidden: ReadonlySet<TagId>): TagId[] {
  return place.tags.filter((t) => !hidden.has(t));
}

/**
 * A place is shown if at least one of its tags is visible. Untagged places are
 * always shown (there is no chip to hide them).
 */
export function filterPlaces(places: readonly Place[], hidden: ReadonlySet<TagId>): Place[] {
  if (hidden.size === 0) return [...places];
  return places.filter((p) => p.tags.length === 0 || visibleTags(p, hidden).length > 0);
}

/** Tags actually used by a set of places, in palette order. */
export function usedTags(places: readonly Place[], order: readonly TagId[]): TagId[] {
  const used = new Set<TagId>();
  for (const p of places) for (const t of p.tags) used.add(t);
  return order.filter((t) => used.has(t));
}

/** Immutable toggle helper for the hidden-tags set. */
export function toggleTag(hidden: ReadonlySet<TagId>, tag: TagId): Set<TagId> {
  const next = new Set(hidden);
  if (next.has(tag)) next.delete(tag);
  else next.add(tag);
  return next;
}
