/**
 * Lists (T-112): the editor's draft, the saved filter built from it, and why
 * a place is or is not in a list. Pure, unit-tested.
 *
 * Membership itself is always decided by the data package (`evaluateList`,
 * which never lets a private, trashed or foreign save in); this module only
 * explains it, with the same rules (`isListEligible`, `matchesCriteria`).
 */
import {
  isListEligible,
  matchesCriteria,
  normalizeFilter,
  type FilterContext,
  type FilterSubject,
  type FilterZone,
  type ListFilter,
  type ListKind,
  type ListRecord,
  type ListVisibility,
  type PlaceRecord,
  type PriceLevel,
  type SaveStatus,
} from '@triangulair/data';
import { categorize, type CategoryId } from '@triangulair/osm';
import type { LineString, MultiLineString } from 'geojson';

import { bufferLines } from '../zones/raster';
import { linesOf } from '../zones/streets';

export interface ListDraft {
  name: string;
  description: string;
  kind: ListKind;
  visibility: ListVisibility;
  tags: string[];
  categories: string[];
  statuses: SaveStatus[];
  priceLevels: PriceLevel[];
  zones: FilterZone[];
  /** Exceptions of a filter list (place ids). */
  include: string[];
  exclude: string[];
  /** Selection of a manual list (place ids). */
  items: string[];
}

export const EMPTY_DRAFT: ListDraft = {
  name: '',
  description: '',
  kind: 'filter',
  visibility: 'link',
  tags: [],
  categories: [],
  statuses: [],
  priceLevels: [],
  zones: [],
  include: [],
  exclude: [],
  items: [],
};

export function draftFromList(l: ListRecord): ListDraft {
  const f = l.filter;
  return {
    name: l.name,
    description: l.description,
    kind: l.kind,
    visibility: l.visibility,
    tags: [...(f.tags ?? [])],
    categories: [...(f.categories ?? [])],
    statuses: [...(f.statuses ?? [])],
    priceLevels: [...(f.priceLevels ?? [])],
    zones: [...(f.zones ?? [])],
    include: [...(f.include ?? [])],
    exclude: [...(f.exclude ?? [])],
    items: [...l.manualItems],
  };
}

/** The saved filter (canonical) of a draft. */
export function draftToFilter(d: ListDraft): ListFilter {
  return normalizeFilter({
    tags: d.tags,
    categories: d.categories,
    statuses: d.statuses,
    priceLevels: d.priceLevels,
    zones: d.zones,
    include: d.include,
    exclude: d.exclude,
  });
}

/** What `Repository.evaluateList` takes, for the live preview. */
export function draftDefinition(d: ListDraft) {
  return { kind: d.kind, visibility: d.visibility, filter: draftToFilter(d), manualItems: d.items };
}

/** A filter list without any criterion would hold every shareable place: worth a warning. */
export function hasCriteria(d: ListDraft): boolean {
  return d.tags.length + d.categories.length + d.statuses.length + d.priceLevels.length + d.zones.length > 0;
}

export function canSave(d: ListDraft): boolean {
  return d.name.trim().length > 0;
}

/** Stable identity of a filter zone (same rule as the data package: OSM id, or the shape). */
export function zoneKeyOf(z: FilterZone): string {
  return z.kind === 'osm' ? `osm:${z.osmType}/${z.osmId}` : `drawn:${JSON.stringify(z.geometry)}`;
}

export function toggleZone(zones: readonly FilterZone[], z: FilterZone): FilterZone[] {
  const k = zoneKeyOf(z);
  return zones.some((x) => zoneKeyOf(x) === k) ? zones.filter((x) => zoneKeyOf(x) !== k) : [...zones, z];
}

/** Half-width of a street zone used as a list area ("places on this street"). */
export const STREET_BUFFER_M = 25;

/**
 * One of my saved zones as a filter zone: an OSM neighbourhood keeps its OSM
 * identity, a drawn zone its polygon, a street zone becomes the area within
 * STREET_BUFFER_M of its segments.
 */
export function placeToFilterZone(p: Pick<PlaceRecord, 'osmType' | 'osmId' | 'name' | 'geometry'>): FilterZone | null {
  const g = p.geometry;
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
    if (p.osmType && p.osmId !== null) return { kind: 'osm', osmType: p.osmType, osmId: p.osmId, name: p.name, geometry: g };
    return { kind: 'drawn', name: p.name, geometry: g };
  }
  if (g.type === 'LineString' || g.type === 'MultiLineString') {
    const area = bufferLines(linesOf(g as LineString | MultiLineString), STREET_BUFFER_M);
    return area ? { kind: 'drawn', name: p.name, geometry: area } : null;
  }
  return null;
}

/** The osm package's category id of a `key=value` category (for its label). */
export function categoryIdOf(category: string | null): CategoryId | undefined {
  const [k, v] = (category ?? '').split('=');
  return k && v ? categorize({ [k]: v })?.category : undefined;
}

export function zoneLabel(z: FilterZone, fallback: string): string {
  return z.name || fallback;
}

// ------------------------------------------------------------------ why in / out

export type Reason =
  | { in: true; why: 'criteria' | 'addedByHand' | 'selected' }
  | {
      in: false;
      why: 'private' | 'trash' | 'notMine' | 'closedPublic' | 'removedByHand' | 'notSelected' | 'criteria';
      /** Criteria groups the place fails (filter lists). */
      failed?: ('tags' | 'categories' | 'statuses' | 'priceLevels' | 'zones')[];
    };

const GROUPS = ['tags', 'categories', 'statuses', 'priceLevels', 'zones'] as const;

/** Why a save is in (or out of) a list being edited. Mirrors the data package's rules. */
export function explain(s: FilterSubject, d: ListDraft, ctx: FilterContext): Reason {
  if (s.save.ownerId !== ctx.meId) return { in: false, why: 'notMine' };
  if (s.save.deletedAt !== null) return { in: false, why: 'trash' };
  if (s.save.sharing === 'private') return { in: false, why: 'private' };
  if (!isListEligible(s, d.visibility, ctx)) return { in: false, why: 'closedPublic' };
  const placeId = s.save.placeId;
  if (d.kind === 'manual') return d.items.includes(placeId) ? { in: true, why: 'selected' } : { in: false, why: 'notSelected' };
  const f = draftToFilter(d);
  if (f.exclude?.includes(placeId)) return { in: false, why: 'removedByHand' };
  if (f.include?.includes(placeId)) return { in: true, why: 'addedByHand' };
  if (matchesCriteria(s, f, ctx)) return { in: true, why: 'criteria' };
  const failed = GROUPS.filter((g) => f[g]?.length && !matchesCriteria(s, { [g]: f[g] } as ListFilter, ctx));
  return { in: false, why: 'criteria', failed };
}

/** Add a place by hand (filter list: an inclusion exception; manual list: a selection). */
export function addByHand(d: ListDraft, placeId: string): ListDraft {
  if (d.kind === 'manual') return d.items.includes(placeId) ? d : { ...d, items: [...d.items, placeId] };
  return { ...d, exclude: d.exclude.filter((x) => x !== placeId), include: d.include.includes(placeId) ? d.include : [...d.include, placeId] };
}

/** Remove a place by hand (filter list: an exclusion exception, which wins over the criteria). */
export function removeByHand(d: ListDraft, placeId: string): ListDraft {
  if (d.kind === 'manual') return { ...d, items: d.items.filter((x) => x !== placeId) };
  return {
    ...d,
    include: d.include.filter((x) => x !== placeId),
    exclude: d.exclude.includes(placeId) ? d.exclude : [...d.exclude, placeId],
  };
}

/** Clears an exception (back to what the criteria say). */
export function clearException(d: ListDraft, placeId: string): ListDraft {
  return { ...d, include: d.include.filter((x) => x !== placeId), exclude: d.exclude.filter((x) => x !== placeId) };
}
