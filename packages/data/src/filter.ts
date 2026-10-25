// SPDX-License-Identifier: MPL-2.0
/**
 * List filters: canonical form and a pure reference evaluator.
 *
 * The repository evaluates lists in SQL (indexed, see `Repository.evaluateList`);
 * this module is the specification it is tested against. Rules:
 *
 * - Only my own saves, not in the trash, enter my lists.
 * - A private save never enters a list, whatever the filter, the exceptions
 *   or the manual selection say (spec "Sharing a place").
 * - A public list never shows a place known to be closed (spec "Closed place
 *   detection", step 4).
 * - Criteria groups (tags, categories, statuses, price levels, zones) are
 *   ANDed; values inside a group are ORed; an absent or empty group does not
 *   constrain. A tag matches its sub-tags. A group that only names tags that no
 *   longer exist matches nothing (a list never widens by itself to everything).
 * - `exclude` wins over `include`; `include` bypasses the criteria (not the
 *   rules above).
 */
import { geometryIntersectsArea } from './geo.ts';
import type {
  FilterZone,
  ListFilter,
  ListKind,
  ListVisibility,
  PlaceGeometry,
  PlaceStatus,
  PriceLevel,
  SaveRecord,
  SaveStatus,
} from './types.ts';

const STATUSES: readonly SaveStatus[] = ['to_try', 'tried', 'favorite'];
const PRICES: readonly PriceLevel[] = [1, 2, 3, 4];

function uniqSorted<T extends string | number>(xs: readonly T[] | undefined): T[] {
  return [...new Set(xs ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function zoneKey(z: FilterZone): string {
  return z.kind === 'osm' ? `osm:${z.osmType}/${z.osmId}` : `drawn:${JSON.stringify(z.geometry)}`;
}

/** Canonical filter: deduplicated, sorted, unknown values dropped, empty groups removed. */
export function normalizeFilter(f: ListFilter): ListFilter {
  const out: ListFilter = {};
  const tags = uniqSorted(f.tags);
  if (tags.length) out.tags = tags;
  const categories = uniqSorted(f.categories);
  if (categories.length) out.categories = categories;
  const statuses = uniqSorted(f.statuses).filter((s) => STATUSES.includes(s));
  if (statuses.length) out.statuses = statuses;
  const prices = uniqSorted(f.priceLevels).filter((p) => PRICES.includes(p));
  if (prices.length) out.priceLevels = prices;
  if (f.zones?.length) {
    const byKey = new Map<string, FilterZone>();
    for (const z of f.zones) byKey.set(zoneKey(z), z);
    out.zones = [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, z]) => z);
  }
  const exclude = uniqSorted(f.exclude);
  const include = uniqSorted(f.include).filter((id) => !exclude.includes(id));
  if (include.length) out.include = include;
  if (exclude.length) out.exclude = exclude;
  return out;
}

/** Stable JSON with sorted object keys (for storage and comparisons). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
}

export interface FilterPlace {
  category: string | null;
  status: PlaceStatus;
  geometry: PlaceGeometry;
}

export interface FilterSubject {
  save: Pick<SaveRecord, 'id' | 'ownerId' | 'placeId' | 'status' | 'priceLevel' | 'sharing' | 'tagIds' | 'deletedAt'>;
  place: FilterPlace;
}

export interface FilterContext {
  meId: string;
  /** Active tags only (not deleted, no deleted ancestor) → parent id. */
  tagParents: ReadonlyMap<string, string | null>;
}

export interface ListDefinition {
  kind: ListKind;
  visibility: ListVisibility;
  filter: ListFilter;
  manualItems: readonly string[];
}

/** The rules that apply to every list, before any criterion. */
export function isListEligible(s: FilterSubject, visibility: ListVisibility, ctx: FilterContext): boolean {
  return (
    s.save.ownerId === ctx.meId &&
    s.save.deletedAt === null &&
    s.save.sharing !== 'private' &&
    !(visibility === 'public' && s.place.status === 'closed')
  );
}

function hasTagOrAncestor(tagIds: readonly string[], wanted: ReadonlySet<string>, ctx: FilterContext): boolean {
  for (const t of tagIds) {
    let cur: string | null | undefined = t;
    let guard = 0;
    while (cur != null && ctx.tagParents.has(cur) && guard++ < 64) {
      if (wanted.has(cur)) return true;
      cur = ctx.tagParents.get(cur);
    }
  }
  return false;
}

/** Criteria only (no eligibility rules, no exceptions). */
export function matchesCriteria(s: FilterSubject, f: ListFilter, ctx: FilterContext): boolean {
  if (f.tags?.length && !hasTagOrAncestor(s.save.tagIds, new Set(f.tags), ctx)) return false;
  if (f.categories?.length && (s.place.category === null || !f.categories.includes(s.place.category))) return false;
  if (f.statuses?.length && (s.save.status === null || !f.statuses.includes(s.save.status))) return false;
  if (f.priceLevels?.length && (s.save.priceLevel === null || !f.priceLevels.includes(s.save.priceLevel)))
    return false;
  if (f.zones?.length && !f.zones.some((z) => geometryIntersectsArea(s.place.geometry, z.geometry))) return false;
  return true;
}

/** Save ids in a list, sorted. Reference implementation for the SQL evaluator. */
export function evaluateListPure(
  list: ListDefinition,
  subjects: Iterable<FilterSubject>,
  ctx: FilterContext,
): string[] {
  const f = normalizeFilter(list.filter);
  const exclude = new Set(f.exclude ?? []);
  const include = new Set(f.include ?? []);
  const manual = new Set(list.manualItems);
  const out: string[] = [];
  for (const s of subjects) {
    if (!isListEligible(s, list.visibility, ctx)) continue;
    const placeId = s.save.placeId;
    if (list.kind === 'manual') {
      if (manual.has(placeId)) out.push(s.save.id);
      continue;
    }
    if (exclude.has(placeId)) continue;
    if (include.has(placeId) || matchesCriteria(s, f, ctx)) out.push(s.save.id);
  }
  return out.sort();
}
