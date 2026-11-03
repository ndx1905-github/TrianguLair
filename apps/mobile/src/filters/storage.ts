/**
 * The filter bar's state, remembered on this device (spec: "the chosen state
 * is remembered"). Versioned JSON, parsed defensively: anything unknown or
 * malformed is dropped, so a corrupt or newer value never breaks the map.
 * Pure, unit-tested; storage itself is `data/deviceSettings`.
 */
import { CATEGORY_IDS, type CategoryGroup, type CategoryId } from '@triangulair/osm';
import type { PriceLevel } from '@triangulair/data';

import {
  CATEGORY_GROUPS,
  CRITERIA,
  DIETS,
  EMPTY_FILTER,
  PLACE_STATUS_OPTIONS,
  PRICE_LEVELS,
  STATUS_OPTIONS,
  VISIBILITY_OPTIONS,
  type Criterion,
  type Diet,
  type FilterState,
  type PlaceStatusOption,
  type StatusOption,
  type VisibilityOption,
} from '../places/filters';

export const FILTER_SETTING_KEY = 'filter-state';
export const FILTER_FORMAT_VERSION = 1;
/** Bounds against a runaway value (each list is small in practice). */
const MAX_ITEMS = 200;
const MAX_TEXT = 200;

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === 'string' && x && x.length <= 300 && !out.includes(x)) out.push(x);
  return out.slice(0, MAX_ITEMS);
}

function oneOf<T extends string | number>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) if ((allowed as readonly unknown[]).includes(x) && !out.includes(x as T)) out.push(x as T);
  return out;
}

/** Normalizes any value into a valid filter (unknown fields and values dropped). */
export function normalizeFilterState(v: unknown): FilterState {
  if (!v || typeof v !== 'object') return { ...EMPTY_FILTER };
  const o = v as Record<string, unknown>;
  const rawCriteria = Array.isArray(o.criteria) ? o.criteria : [];
  const criteria = oneOf<Criterion>(rawCriteria, CRITERIA);
  // Older filters had "vegetarian" as a criterion; it is a diet now.
  const diets = oneOf<Diet>(o.diets, DIETS);
  if (rawCriteria.includes('vegetarian') && !diets.includes('vegetarian')) diets.push('vegetarian');
  const f: FilterState = { tagIds: strings(o.tagIds), criteria };
  const put = <K extends keyof FilterState>(k: K, value: FilterState[K] & unknown[]) => {
    if (value.length) f[k] = value;
  };
  put('friendTags', strings(o.friendTags));
  put('categories', oneOf<CategoryGroup>(o.categories, CATEGORY_GROUPS));
  put('kinds', oneOf<CategoryId>(o.kinds, CATEGORY_IDS));
  put('cuisines', strings(o.cuisines));
  put('museums', strings(o.museums));
  put('shops', strings(o.shops));
  put('diets', diets);
  put('statuses', oneOf<StatusOption>(o.statuses, STATUS_OPTIONS));
  put('placeStatuses', oneOf<PlaceStatusOption>(o.placeStatuses, PLACE_STATUS_OPTIONS));
  put('visibility', oneOf<VisibilityOption>(o.visibility, VISIBILITY_OPTIONS));
  put('priceLevels', oneOf<PriceLevel>(o.priceLevels, PRICE_LEVELS));
  if (typeof o.maxCharge === 'number' && Number.isFinite(o.maxCharge) && o.maxCharge >= 0 && o.maxCharge < 10_000) f.maxCharge = o.maxCharge;
  if (typeof o.text === 'string' && o.text.trim()) f.text = o.text.slice(0, MAX_TEXT);
  return f;
}

/** Compact JSON: version plus non-empty fields only. */
export function serializeFilter(f: FilterState): string {
  const n = normalizeFilterState(f);
  const out: Record<string, unknown> = { v: FILTER_FORMAT_VERSION };
  for (const [k, v] of Object.entries(n)) {
    if (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return JSON.stringify(out);
}

/** Parses a stored value; garbage, or a format from a newer version, gives the empty filter. */
export function parseFilter(raw: string | null | undefined): FilterState {
  if (!raw) return { ...EMPTY_FILTER };
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return { ...EMPTY_FILTER };
    const version = (v as { v?: unknown }).v;
    if (typeof version === 'number' && version > FILTER_FORMAT_VERSION) return { ...EMPTY_FILTER };
    return normalizeFilterState(v);
  } catch {
    return { ...EMPTY_FILTER };
  }
}

/**
 * Drops tags that no longer exist (deleted, or from another device's data)
 * so the summary never shows a filter that cannot be removed. Returns the
 * same object when nothing changes.
 */
export function pruneUnknownTags(f: FilterState, myTagIds: ReadonlySet<string>, friendTagKeys: ReadonlySet<string> | null): FilterState {
  const tagIds = f.tagIds.filter((id) => myTagIds.has(id));
  const friendTags = friendTagKeys ? (f.friendTags ?? []).filter((k) => friendTagKeys.has(k)) : f.friendTags;
  if (tagIds.length === f.tagIds.length && (friendTags?.length ?? 0) === (f.friendTags?.length ?? 0)) return f;
  const next: FilterState = { ...f, tagIds };
  if (friendTags?.length) next.friendTags = friendTags;
  else delete next.friendTags;
  return next;
}
