/**
 * Map / list filters (spec "Filter bar" and "Filters based on source data").
 * Pure logic, unit-tested.
 *
 * - Tags: a place matches when it has one of the selected tags or one of
 *   their sub-tags (values inside the group are ORed).
 * - OSM criteria (open now, terrace, happy hour, vegetarian): ANDed with the
 *   tags and with each other. A place without the information is not
 *   silently excluded: it is "unknown", drawn faded like non-matching places.
 * - A criterion is only offered when at least one displayed place has the
 *   information; its count is the number of places that satisfy it.
 */
import { happyHourStatus, isOpenAt, openingContextOf, type PlaceInfo } from '@triangulair/osm';

import type { AppTag, PlaceFacts } from './model';

export const CRITERIA = ['openNow', 'terrace', 'happyHour', 'vegetarian'] as const;
export type Criterion = (typeof CRITERIA)[number];

export interface FilterState {
  /** Selected tag ids (ORed, sub-tags included). */
  tagIds: string[];
  criteria: Criterion[];
}

export const EMPTY_FILTER: FilterState = { tagIds: [], criteria: [] };

export type Match = 'match' | 'nomatch' | 'unknown';

export function activeFilterCount(f: FilterState): number {
  return f.tagIds.length + f.criteria.length;
}

export function isFilterActive(f: FilterState): boolean {
  return activeFilterCount(f) > 0;
}

export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Selected tags plus all their descendants (cycle-safe). */
export function expandTagSelection(selected: readonly string[], tags: readonly AppTag[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const t of tags) {
    if (!t.parentId) continue;
    const list = children.get(t.parentId) ?? [];
    list.push(t.id);
    children.set(t.parentId, list);
  }
  const out = new Set<string>();
  const stack = [...selected];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/** Value of one OSM criterion: true / false, or null when the place lacks the information. */
export function criterionValue(c: Criterion, info: PlaceInfo | null, now: Date, fallbackCountry?: string): boolean | null {
  if (!info) return null;
  switch (c) {
    case 'openNow':
      return isOpenAt(info.openingHours, now, openingContextOf(info, fallbackCountry));
    case 'terrace':
      return info.outdoorSeating === undefined ? null : info.outdoorSeating === 'yes';
    case 'happyHour': {
      if (!info.happyHours) return null;
      const s = happyHourStatus(info.happyHours, now, openingContextOf(info, fallbackCountry));
      return s.state === 'unknown' ? null : s.state === 'active';
    }
    case 'vegetarian': {
      const v = info.diet.vegetarian ?? info.diet.vegan;
      if (v === undefined) return null;
      return v === 'yes' || v === 'only' || v === 'limited';
    }
  }
}

export interface FilterContext {
  /** Output of `expandTagSelection` for the current selection. */
  tagSet: ReadonlySet<string>;
  now: Date;
  /** Country for holiday rules when a place has no `addr:country` (device region). */
  country?: string;
}

export function matchPlace(p: Pick<PlaceFacts, 'tagIds' | 'info'>, f: FilterState, ctx: FilterContext): Match {
  if (f.tagIds.length > 0 && !p.tagIds.some((t) => ctx.tagSet.has(t))) return 'nomatch';
  let unknown = false;
  for (const c of f.criteria) {
    const v = criterionValue(c, p.info, ctx.now, ctx.country);
    if (v === false) return 'nomatch';
    if (v === null) unknown = true;
  }
  return unknown ? 'unknown' : 'match';
}

/**
 * The selected tag a matching place is shown with (spec: "When a filter is
 * active, the pin takes the color and icon of the filtered tag").
 */
export function filteredTagOf(p: Pick<PlaceFacts, 'tagIds'>, f: FilterState, tags: readonly AppTag[]): string | null {
  if (f.tagIds.length === 0) return null;
  for (const sel of f.tagIds) {
    const set = expandTagSelection([sel], tags);
    if (p.tagIds.some((t) => set.has(t))) return sel;
  }
  return null;
}

export interface FilterSummary {
  /** Tags used by the displayed places, with their number of places (sub-tags included). */
  tags: { tag: AppTag; count: number }[];
  /** Criteria with enough information, and how many places satisfy them. */
  criteria: { criterion: Criterion; count: number; known: number }[];
  matching: number;
  unknown: number;
  total: number;
}

export function summarize(
  places: readonly Pick<PlaceFacts, 'tagIds' | 'info'>[],
  f: FilterState,
  tags: readonly AppTag[],
  now: Date,
  country?: string,
): FilterSummary {
  const tagCounts = new Map<string, number>();
  const tagSets = new Map(tags.map((t) => [t.id, expandTagSelection([t.id], tags)]));
  for (const p of places) {
    for (const t of tags) {
      const set = tagSets.get(t.id)!;
      if (p.tagIds.some((id) => set.has(id))) tagCounts.set(t.id, (tagCounts.get(t.id) ?? 0) + 1);
    }
  }
  const criteria = CRITERIA.map((criterion) => {
    let count = 0;
    let known = 0;
    for (const p of places) {
      const v = criterionValue(criterion, p.info, now, country);
      if (v !== null) known++;
      if (v === true) count++;
    }
    return { criterion, count, known };
  }).filter((c) => c.known > 0 || f.criteria.includes(c.criterion));
  const ctx: FilterContext = { tagSet: expandTagSelection(f.tagIds, tags), now, ...(country ? { country } : {}) };
  let matching = 0;
  let unknown = 0;
  for (const p of places) {
    const m = matchPlace(p, f, ctx);
    if (m === 'match') matching++;
    else if (m === 'unknown') unknown++;
  }
  return {
    tags: tags
      .filter((t) => (tagCounts.get(t.id) ?? 0) > 0 || f.tagIds.includes(t.id))
      .map((tag) => ({ tag, count: tagCounts.get(tag.id) ?? 0 })),
    criteria,
    matching,
    unknown,
    total: places.length,
  };
}
