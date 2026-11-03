/**
 * The collapsed filter bar: one pill per chosen value, each with the filter
 * that removing it gives (spec: "one pill per active filter, with a cross to
 * remove it"). Pure, unit-tested; labels come from the caller (i18n).
 */
import type { CategoryGroup, CategoryId } from '@triangulair/osm';
import type { PriceLevel } from '@triangulair/data';

import {
  pruneSubFilters,
  type Criterion,
  type Diet,
  type FilterState,
  type PlaceStatusOption,
  type StatusOption,
  type VisibilityOption,
} from '../places/filters';

export type PillKind =
  | 'tag'
  | 'friendTag'
  | 'category'
  | 'kind'
  | 'cuisine'
  | 'museum'
  | 'shop'
  | 'criterion'
  | 'diet'
  | 'charge'
  | 'status'
  | 'placeStatus'
  | 'visibility'
  | 'price'
  | 'text';

export interface ActivePill {
  key: string;
  kind: PillKind;
  /** The value (tag id, criterion, cuisine…). */
  value: string;
  /** The filter without this value. */
  without: FilterState;
}

const drop = <T>(list: readonly T[] | undefined, v: T): T[] => (list ?? []).filter((x) => x !== v);

function setOrDelete<K extends keyof FilterState>(f: FilterState, k: K, list: unknown[]): FilterState {
  const next: FilterState = { ...f };
  if (list.length) (next as unknown as Record<string, unknown>)[k] = list;
  else delete next[k];
  return next;
}

/** Pills in the order of the expanded bar. */
export function activePills(f: FilterState): ActivePill[] {
  const out: ActivePill[] = [];
  const add = (kind: PillKind, value: string | number, without: FilterState) =>
    out.push({ key: `${kind}:${value}`, kind, value: String(value), without });
  for (const id of f.tagIds) add('tag', id, { ...f, tagIds: drop(f.tagIds, id) });
  for (const k of f.friendTags ?? []) add('friendTag', k, setOrDelete(f, 'friendTags', drop(f.friendTags, k)));
  for (const c of f.categories ?? []) add('category', c, pruneSubFilters(setOrDelete(f, 'categories', drop<CategoryGroup>(f.categories, c))));
  for (const k of f.kinds ?? []) add('kind', k, setOrDelete(f, 'kinds', drop<CategoryId>(f.kinds, k)));
  for (const v of f.cuisines ?? []) add('cuisine', v, setOrDelete(f, 'cuisines', drop(f.cuisines, v)));
  for (const v of f.museums ?? []) add('museum', v, setOrDelete(f, 'museums', drop(f.museums, v)));
  for (const v of f.shops ?? []) add('shop', v, setOrDelete(f, 'shops', drop(f.shops, v)));
  for (const c of f.criteria) add('criterion', c, { ...f, criteria: drop<Criterion>(f.criteria, c) });
  for (const d of f.diets ?? []) add('diet', d, setOrDelete(f, 'diets', drop<Diet>(f.diets, d)));
  if (f.maxCharge != null) {
    const next = { ...f };
    delete next.maxCharge;
    add('charge', f.maxCharge, next);
  }
  for (const s of f.statuses ?? []) add('status', s, setOrDelete(f, 'statuses', drop<StatusOption>(f.statuses, s)));
  for (const s of f.placeStatuses ?? []) add('placeStatus', s, setOrDelete(f, 'placeStatuses', drop<PlaceStatusOption>(f.placeStatuses, s)));
  for (const v of f.visibility ?? []) add('visibility', v, setOrDelete(f, 'visibility', drop<VisibilityOption>(f.visibility, v)));
  for (const p of f.priceLevels ?? []) add('price', p, setOrDelete(f, 'priceLevels', drop<PriceLevel>(f.priceLevels, p)));
  if (f.text?.trim()) {
    const next = { ...f };
    delete next.text;
    add('text', f.text.trim(), next);
  }
  return out;
}

/** Toggles a value of a list field (removing a category also prunes its sub-filters). */
export function toggleValue<K extends 'friendTags' | 'categories' | 'kinds' | 'cuisines' | 'museums' | 'shops' | 'diets' | 'statuses' | 'placeStatuses' | 'visibility' | 'priceLevels'>(
  f: FilterState,
  k: K,
  value: NonNullable<FilterState[K]>[number],
): FilterState {
  const list = (f[k] ?? []) as unknown[];
  const next = list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
  const res = setOrDelete(f, k, next);
  return k === 'categories' ? pruneSubFilters(res) : res;
}
