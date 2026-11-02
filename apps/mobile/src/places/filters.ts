/**
 * Map / list filters (spec "Filter bar" and "Filters based on source data").
 * Pure logic, unit-tested; the filter bar UI is `components/FilterBar.tsx`,
 * its storage `filters/storage.ts`.
 *
 * Groups are ANDed; values inside a group are ORed, except diets (each one
 * chosen is a need: vegetarian AND gluten-free).
 *
 * - Tags: one group made of my tags (a tag matches its sub-tags; choosing a
 *   sub-tag of a chosen tag narrows to the sub-tag) and friends' tags that I
 *   have not mapped to one of mine.
 * - Category (OSM group: food & drink, shopping, culture…), then its
 *   sub-filters: kind (restaurant, bar…), cuisine, museum type, shop type.
 * - Practical criteria from OSM (open now, happy hour, terrace, reservation,
 *   free entry, second-hand, organic), diets and "entry under €X": a place
 *   without the information is not silently excluded, it is "unknown", drawn
 *   faded like the places outside the filter.
 * - My data: status, visibility (only me / shared / friends' places), price
 *   level, text. "Also at my friends'" is a criterion that is never unknown.
 * - Places confirmed closed are hidden unless the "Closed" status is chosen
 *   (spec "Closed place detection", step 4); "Maybe closed" narrows to them.
 *
 * A criterion is offered when at least one displayed place has the
 * information; its count is the number of displayed places satisfying it.
 */
import {
  CATEGORIES,
  categoryForTag,
  happyHourStatus,
  isOpenAt,
  minCharge,
  openingContextOf,
  type CategoryGroup,
  type CategoryId,
  type DietKind,
  type PlaceInfo,
} from '@triangulair/osm';
import type { PriceLevel, SaveStatus } from '@triangulair/data';

import { foldText } from '../tags/text';
import type { AppTag, PlaceFacts } from './model';

/** Practical criteria offered in the bar ("vegetarian" is kept for older saved filters, see `DIETS`). */
export const CRITERIA = ['openNow', 'happyHour', 'terrace', 'reservation', 'freeEntry', 'secondHand', 'organic', 'friends'] as const;
export type Criterion = (typeof CRITERIA)[number] | 'vegetarian';

export const DIETS = ['vegetarian', 'vegan', 'gluten_free', 'halal', 'kosher'] as const satisfies readonly DietKind[];
export type Diet = (typeof DIETS)[number];

/** "Entry under €X" steps (offered when some displayed place has a price). */
export const CHARGE_STEPS = [5, 10, 15, 20] as const;

export const CATEGORY_GROUPS = ['food_drink', 'shopping', 'culture', 'nature', 'leisure', 'lodging', 'services', 'other'] as const satisfies readonly CategoryGroup[];

export type StatusOption = SaveStatus | 'none';
export const STATUS_OPTIONS: readonly StatusOption[] = ['favorite', 'to_try', 'tried', 'none'];
export type PlaceStatusOption = 'maybe_closed' | 'closed';
export const PLACE_STATUS_OPTIONS: readonly PlaceStatusOption[] = ['maybe_closed', 'closed'];
export type VisibilityOption = 'private' | 'shared' | 'friendsOnly';
export const VISIBILITY_OPTIONS: readonly VisibilityOption[] = ['private', 'shared', 'friendsOnly'];
export const PRICE_LEVELS: readonly PriceLevel[] = [1, 2, 3, 4];

/** Sub-filter dimensions shown under a chosen category. */
export type SubDimension = 'kinds' | 'cuisines' | 'museums' | 'shops';

export interface FilterState {
  /** My tag ids (ORed with `friendTags`; sub-tags included). */
  tagIds: string[];
  criteria: Criterion[];
  /** Friends' unmapped tags, by key (`friendTagKey`). */
  friendTags?: string[];
  categories?: CategoryGroup[];
  kinds?: CategoryId[];
  cuisines?: string[];
  museums?: string[];
  shops?: string[];
  diets?: Diet[];
  /** Entry price at most this (EUR); free entry matches. */
  maxCharge?: number | null;
  statuses?: StatusOption[];
  placeStatuses?: PlaceStatusOption[];
  visibility?: VisibilityOption[];
  priceLevels?: PriceLevel[];
  text?: string;
}

export const EMPTY_FILTER: FilterState = { tagIds: [], criteria: [] };

/**
 * - match / nomatch;
 * - unknown: the place lacks the source information (drawn like nomatch);
 * - hidden: not displayed at all (closed place, closed status not chosen).
 */
export type Match = 'match' | 'nomatch' | 'unknown' | 'hidden';

const len = (a: readonly unknown[] | undefined) => a?.length ?? 0;

/** Number of chosen values (one per pill of the collapsed summary). */
export function activeFilterCount(f: FilterState): number {
  return (
    f.tagIds.length +
    f.criteria.length +
    len(f.friendTags) +
    len(f.categories) +
    len(f.kinds) +
    len(f.cuisines) +
    len(f.museums) +
    len(f.shops) +
    len(f.diets) +
    (f.maxCharge != null ? 1 : 0) +
    len(f.statuses) +
    len(f.placeStatuses) +
    len(f.visibility) +
    len(f.priceLevels) +
    (f.text?.trim() ? 1 : 0)
  );
}

export function isFilterActive(f: FilterState): boolean {
  return activeFilterCount(f) > 0;
}

export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function childrenIndex(tags: readonly AppTag[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const t of tags) {
    if (!t.parentId) continue;
    const list = children.get(t.parentId) ?? [];
    list.push(t.id);
    children.set(t.parentId, list);
  }
  return children;
}

function descendantsOf(id: string, children: ReadonlyMap<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur) || cur === id) continue;
    out.add(cur);
    stack.push(...(children.get(cur) ?? []));
  }
  return out;
}

/**
 * The chosen tags that act: a chosen tag with a chosen sub-tag is narrowed to
 * that sub-tag ("Restaurant" then "Pizza" = pizzerias only).
 */
export function effectiveTagSelection(selected: readonly string[], tags: readonly AppTag[]): string[] {
  if (selected.length < 2) return [...selected];
  const children = childrenIndex(tags);
  const chosen = new Set(selected);
  return selected.filter((id) => ![...descendantsOf(id, children)].some((d) => chosen.has(d)));
}

/** Effective chosen tags plus all their descendants (cycle-safe). */
export function expandTagSelection(selected: readonly string[], tags: readonly AppTag[]): Set<string> {
  const children = childrenIndex(tags);
  const out = new Set<string>();
  for (const id of effectiveTagSelection(selected, tags)) {
    out.add(id);
    for (const d of descendantsOf(id, children)) out.add(d);
  }
  return out;
}

/** Category id and group of a place (from OSM info, else its stored `key=value`). */
export function categoryOf(p: Pick<PlaceFacts, 'category' | 'info'>): { id: CategoryId; group: CategoryGroup } | null {
  if (p.info) return { id: p.info.category, group: p.info.categoryGroup };
  if (!p.category) return null;
  const [key, value = ''] = p.category.split('=');
  const id = key ? categoryForTag(key, value) : null;
  return id ? { id, group: CATEGORIES[id].group } : null;
}

const FOOD: ReadonlySet<CategoryGroup> = new Set(['food_drink']);

function triValue(v: string | undefined, yes: readonly string[], no: readonly string[]): boolean | null {
  if (v === undefined) return null;
  if (yes.includes(v)) return true;
  if (no.includes(v)) return false;
  return null;
}

/**
 * Value of one criterion: true / false, or null when the place lacks the
 * information (or the criterion does not apply to its category).
 */
export function criterionValue(
  c: Criterion,
  info: PlaceInfo | null,
  now: Date,
  fallbackCountry?: string,
  facts?: Pick<PlaceFacts, 'friends'>,
): boolean | null {
  if (c === 'friends') return facts ? facts.friends : null;
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
    case 'vegetarian':
      return dietValue('vegetarian', info);
    case 'reservation':
      return triValue(info.reservation, ['yes', 'recommended', 'required'], ['no', 'members_only']);
    case 'freeEntry':
      return info.fee === undefined ? null : !info.fee;
    case 'secondHand':
      return triValue(info.secondHand, ['yes', 'only'], ['no']);
    case 'organic':
      return triValue(info.organic, ['yes', 'only'], ['no']);
  }
}

/** Diet: yes / limited / only = true ("options" or "exclusively"), no = false. Vegan implies vegetarian. */
export function dietValue(d: Diet, info: PlaceInfo | null): boolean | null {
  if (!info) return null;
  const v = d === 'vegetarian' ? (info.diet.vegetarian ?? (info.diet.vegan === 'only' || info.diet.vegan === 'yes' ? info.diet.vegan : undefined)) : info.diet[d];
  if (v === undefined) return null;
  return v === 'yes' || v === 'only' || v === 'limited';
}

/** Lowest entry price in EUR (0 when free), or null when unknown. */
export function entryPrice(info: PlaceInfo | null): number | null {
  if (!info) return null;
  if (info.fee === false) return 0;
  const c = minCharge(info.charge, 'EUR') ?? minCharge(info.charge);
  return c?.amount ?? null;
}

export function chargeValue(max: number, info: PlaceInfo | null): boolean | null {
  const p = entryPrice(info);
  return p === null ? null : p <= max;
}

/** A sub-filter value of a place, or undefined when it lacks it; null when the dimension does not apply. */
function subValues(dim: SubDimension, p: Pick<PlaceFacts, 'category' | 'info'>): string[] | null {
  const cat = categoryOf(p);
  switch (dim) {
    case 'kinds':
      return cat ? [cat.id] : [];
    case 'cuisines':
      if (!cat || !FOOD.has(cat.group)) return null;
      return p.info?.cuisine ?? [];
    case 'museums':
      if (!cat || cat.id !== 'museum') return null;
      return p.info?.museum ? [p.info.museum] : [];
    case 'shops':
      if (!cat || cat.group !== 'shopping') return null;
      return p.info?.shop ? [p.info.shop] : [];
  }
}

export interface FilterContext {
  /** Output of `expandTagSelection` for the current selection. */
  tagSet: ReadonlySet<string>;
  now: Date;
  /** Country for holiday rules when a place has no `addr:country` (device region). */
  country?: string;
}

export type FilterablePlace = Pick<PlaceFacts, 'tagIds' | 'info'> &
  Partial<Pick<PlaceFacts, 'category' | 'friends' | 'mine' | 'status' | 'saveStatus' | 'sharing' | 'priceLevel' | 'searchText' | 'friendTags'>>;

function visibilityOf(p: FilterablePlace): VisibilityOption {
  if (p.mine === false) return 'friendsOnly';
  return p.sharing === 'private' ? 'private' : 'shared';
}

export function matchPlace(p: FilterablePlace, f: FilterState, ctx: FilterContext): Match {
  // Closed places: hidden unless asked for.
  const ps = f.placeStatuses ?? [];
  if (p.status === 'closed' && !ps.includes('closed')) return 'hidden';
  if (ps.length > 0 && !ps.includes(p.status as PlaceStatusOption)) return 'nomatch';

  const ft = f.friendTags ?? [];
  if (f.tagIds.length > 0 || ft.length > 0) {
    const mineHit = f.tagIds.length > 0 && p.tagIds.some((t) => ctx.tagSet.has(t));
    const friendHit = ft.length > 0 && (p.friendTags ?? []).some((t) => ft.includes(t.key));
    if (!mineHit && !friendHit) return 'nomatch';
  }

  const cats = f.categories ?? [];
  if (cats.length > 0) {
    const cat = categoryOf({ category: p.category ?? null, info: p.info });
    if (!cat || !cats.includes(cat.group)) return 'nomatch';
  }
  if (len(f.statuses) > 0 && !f.statuses!.includes((p.saveStatus ?? 'none') as StatusOption)) return 'nomatch';
  if (len(f.visibility) > 0 && !f.visibility!.includes(visibilityOf(p))) return 'nomatch';
  if (len(f.priceLevels) > 0 && (p.priceLevel == null || !f.priceLevels!.includes(p.priceLevel))) return 'nomatch';
  const text = f.text ? foldText(f.text).split(/\s+/).filter(Boolean) : [];
  if (text.length > 0) {
    const hay = p.searchText ?? '';
    if (!text.every((w) => hay.includes(w))) return 'nomatch';
  }

  let unknown = false;
  const facts = { category: p.category ?? null, info: p.info };
  for (const dim of ['kinds', 'cuisines', 'museums', 'shops'] as const) {
    const want = f[dim] as string[] | undefined;
    if (!want?.length) continue;
    const have = subValues(dim, facts);
    if (have === null) return 'nomatch';
    if (have.length === 0) {
      if (dim === 'kinds') return 'nomatch';
      unknown = true;
      continue;
    }
    if (!have.some((v) => want.includes(v))) return 'nomatch';
  }
  for (const c of f.criteria) {
    const v = criterionValue(c, p.info, ctx.now, ctx.country, { friends: p.friends ?? false });
    if (v === false) return 'nomatch';
    if (v === null) unknown = true;
  }
  for (const d of f.diets ?? []) {
    const v = dietValue(d, p.info);
    if (v === false) return 'nomatch';
    if (v === null) unknown = true;
  }
  if (f.maxCharge != null) {
    const v = chargeValue(f.maxCharge, p.info);
    if (v === false) return 'nomatch';
    if (v === null) unknown = true;
  }
  return unknown ? 'unknown' : 'match';
}

/**
 * The chosen tag a matching place is shown with (spec: "When a filter is
 * active, the pin takes the color and icon of the filtered tag").
 */
export function filteredTagOf(p: Pick<PlaceFacts, 'tagIds'>, f: FilterState, tags: readonly AppTag[]): string | null {
  if (f.tagIds.length === 0) return null;
  for (const sel of effectiveTagSelection(f.tagIds, tags)) {
    const set = expandTagSelection([sel], tags);
    if (p.tagIds.some((t) => set.has(t))) return sel;
  }
  return null;
}

export interface Counted<T> {
  value: T;
  count: number;
}

export interface FilterSummary {
  /** My tags used by the displayed places, with their number of places (sub-tags included). */
  tags: { tag: AppTag; count: number }[];
  /** Friends' unmapped tags on the displayed places. */
  friendTags: { key: string; name: string; color: string | null; personId: string; count: number }[];
  categories: Counted<CategoryGroup>[];
  /** Sub-filters, counted among the places of the chosen categories (all places when none is chosen). */
  kinds: Counted<CategoryId>[];
  cuisines: Counted<string>[];
  museums: Counted<string>[];
  shops: Counted<string>[];
  /** Criteria with enough information, and how many places satisfy them. */
  criteria: { criterion: Criterion; count: number; known: number }[];
  diets: { diet: Diet; count: number; known: number }[];
  /** Entry price steps (only when some place has a price). */
  charges: Counted<number>[];
  statuses: Counted<StatusOption>[];
  placeStatuses: Counted<PlaceStatusOption>[];
  visibility: Counted<VisibilityOption>[];
  priceLevels: Counted<PriceLevel>[];
  matching: number;
  unknown: number;
  /** Displayed places (closed ones hidden unless asked for). */
  total: number;
}

/** Fewest places that must document a criterion for it to be offered. */
export const MIN_KNOWN = 1;

function bump<K>(m: Map<K, number>, k: K) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function counted<K>(m: Map<K, number>, keep: readonly K[] = [], order?: readonly K[]): Counted<K>[] {
  const keys = new Set<K>([...m.keys(), ...keep]);
  const list = [...keys].map((value) => ({ value, count: m.get(value) ?? 0 }));
  if (order) return list.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
  return list.sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}

export function summarize(
  places: readonly FilterablePlace[],
  f: FilterState,
  tags: readonly AppTag[],
  now: Date,
  country?: string,
): FilterSummary {
  const ps = f.placeStatuses ?? [];
  const shown = places.filter((p) => p.status !== 'closed' || ps.includes('closed'));
  const tagSets = new Map(tags.map((t) => [t.id, expandTagSelection([t.id], tags)]));
  const tagCounts = new Map<string, number>();
  const friendTagInfo = new Map<string, { key: string; name: string; color: string | null; personId: string }>();
  const friendCounts = new Map<string, number>();
  const groups = new Map<CategoryGroup, number>();
  const sub = { kinds: new Map<string, number>(), cuisines: new Map<string, number>(), museums: new Map<string, number>(), shops: new Map<string, number>() };
  const crit = new Map(CRITERIA.map((c) => [c, { count: 0, known: 0 }]));
  const diets = new Map(DIETS.map((d) => [d, { count: 0, known: 0 }]));
  const prices: number[] = [];
  const statuses = new Map<StatusOption, number>();
  const placeStatuses = new Map<PlaceStatusOption, number>();
  const visibility = new Map<VisibilityOption, number>();
  const priceLevels = new Map<PriceLevel, number>();
  const cats = f.categories ?? [];

  for (const p of places) {
    if (p.status === 'maybe_closed' || p.status === 'closed') bump(placeStatuses, p.status);
  }
  for (const p of shown) {
    for (const t of tags) {
      const set = tagSets.get(t.id)!;
      if (p.tagIds.some((id) => set.has(id))) bump(tagCounts, t.id);
    }
    for (const ft of p.friendTags ?? []) {
      friendTagInfo.set(ft.key, { key: ft.key, name: ft.name, color: ft.color, personId: ft.personId });
      bump(friendCounts, ft.key);
    }
    const facts = { category: p.category ?? null, info: p.info };
    const cat = categoryOf(facts);
    if (cat) bump(groups, cat.group);
    if (cats.length === 0 || (cat && cats.includes(cat.group))) {
      for (const dim of ['kinds', 'cuisines', 'museums', 'shops'] as const) {
        for (const v of new Set(subValues(dim, facts) ?? [])) bump(sub[dim], v);
      }
    }
    for (const c of CRITERIA) {
      const v = criterionValue(c, p.info, now, country, { friends: p.friends ?? false });
      const e = crit.get(c)!;
      if (v !== null) e.known++;
      if (v === true) e.count++;
    }
    for (const d of DIETS) {
      const v = dietValue(d, p.info);
      const e = diets.get(d)!;
      if (v !== null) e.known++;
      if (v === true) e.count++;
    }
    const price = entryPrice(p.info);
    if (price !== null) prices.push(price);
    bump(statuses, (p.saveStatus ?? 'none') as StatusOption);
    bump(visibility, visibilityOf(p));
    if (p.priceLevel != null) bump(priceLevels, p.priceLevel);
  }

  const ctx: FilterContext = { tagSet: expandTagSelection(f.tagIds, tags), now, ...(country ? { country } : {}) };
  let matching = 0;
  let unknown = 0;
  for (const p of shown) {
    const m = matchPlace(p, f, ctx);
    if (m === 'match') matching++;
    else if (m === 'unknown') unknown++;
  }
  // "Also at my friends'" only makes sense when some displayed place is a friend's.
  const criteria = CRITERIA.map((criterion) => ({ criterion, ...crit.get(criterion)! }))
    .filter((c) => (c.criterion === 'friends' ? c.count > 0 : c.known >= MIN_KNOWN) || f.criteria.includes(c.criterion));
  const chosenCharge = f.maxCharge != null ? [f.maxCharge] : [];
  const pricedPaid = prices.some((p) => p > 0);
  return {
    tags: tags
      .filter((t) => (tagCounts.get(t.id) ?? 0) > 0 || f.tagIds.includes(t.id))
      .map((tag) => ({ tag, count: tagCounts.get(tag.id) ?? 0 })),
    friendTags: [...friendTagInfo.values()]
      .map((x) => ({ ...x, count: friendCounts.get(x.key) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    categories: counted(groups, cats, CATEGORY_GROUPS),
    kinds: counted(sub.kinds as Map<CategoryId, number>, f.kinds ?? []),
    cuisines: counted(sub.cuisines, f.cuisines ?? []),
    museums: counted(sub.museums, f.museums ?? []),
    shops: counted(sub.shops, f.shops ?? []),
    criteria,
    diets: DIETS.map((diet) => ({ diet, ...diets.get(diet)! })).filter((d) => d.known >= MIN_KNOWN || (f.diets ?? []).includes(d.diet)),
    charges: pricedPaid || chosenCharge.length
      ? [...new Set([...CHARGE_STEPS, ...chosenCharge])].sort((a, b) => a - b).map((value) => ({ value, count: prices.filter((p) => p <= value).length }))
      : [],
    statuses: counted(statuses, f.statuses ?? [], STATUS_OPTIONS),
    placeStatuses: counted(placeStatuses, ps, PLACE_STATUS_OPTIONS),
    visibility: counted(visibility, f.visibility ?? [], VISIBILITY_OPTIONS),
    priceLevels: counted(priceLevels, f.priceLevels ?? [], PRICE_LEVELS),
    matching,
    unknown,
    total: shown.length,
  };
}

/** Which sub-filter dimensions to show for the chosen categories. */
export function subDimensionsFor(categories: readonly CategoryGroup[]): SubDimension[] {
  if (categories.length === 0) return [];
  const dims: SubDimension[] = ['kinds'];
  if (categories.includes('food_drink')) dims.push('cuisines');
  if (categories.includes('culture')) dims.push('museums');
  if (categories.includes('shopping')) dims.push('shops');
  return dims;
}

/**
 * Removes sub-filter values that no longer apply after a category was
 * removed (no hidden constraint left behind in the collapsed summary).
 */
export function pruneSubFilters(f: FilterState): FilterState {
  const cats = f.categories ?? [];
  const dims = new Set(subDimensionsFor(cats));
  const next: FilterState = { ...f };
  if (!dims.has('kinds')) delete next.kinds;
  else if (next.kinds) next.kinds = next.kinds.filter((k) => cats.includes(CATEGORIES[k]?.group));
  if (!dims.has('cuisines')) delete next.cuisines;
  if (!dims.has('museums')) delete next.museums;
  if (!dims.has('shops')) delete next.shops;
  return next;
}
