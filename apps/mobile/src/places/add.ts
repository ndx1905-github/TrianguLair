/**
 * Add-a-place logic (T-105): candidates from Overpass (nearby), Photon
 * (search as you type) or a manual point, marked "already in my places" /
 * "saved by friends", and the save they become. Pure, unit-tested.
 */
import {
  newLocalPlaceId,
  placeIdFromOsm,
  type CommentVisibility,
  type PlaceHit,
  type PriceLevel,
  type SaveInput,
  type SaveStatus,
  type Sharing,
} from '@triangulair/data';
import type { CategoryId, NearbyPlace, OsmRef, OsmTags, SearchResult } from '@triangulair/osm';

import type { AppTag } from './model';

export type CandidateSource = 'nearby' | 'search' | 'local' | 'manual';

export interface Candidate {
  /** Stable React key. */
  key: string;
  source: CandidateSource;
  /** null for an address or a manual point (becomes a new `local:` place). */
  ref: OsmRef | null;
  /** Place id when known (OSM places, or places already on this device). */
  placeId: string | null;
  name: string;
  category: CategoryId | null;
  /** OSM `key=value`, stored as the place's category. */
  osmCategory: string | null;
  lat: number;
  lon: number;
  distance: number | null;
  address: string | null;
  /** Raw OSM tags when the source returned them (Overpass), cached on save. */
  tags: OsmTags | null;
  alreadyMine: boolean;
  friendsCount: number;
}

export function fromNearby(p: NearbyPlace): Candidate | null {
  if (!p.location) return null;
  return {
    key: `osm:${p.ref.type}/${p.ref.id}`,
    source: 'nearby',
    ref: p.ref,
    placeId: placeIdFromOsm(p.ref.type, p.ref.id),
    name: p.name ?? '',
    category: p.category,
    osmCategory: p.primaryTag ? `${p.primaryTag.key}=${p.primaryTag.value}` : null,
    lat: p.location.lat,
    lon: p.location.lon,
    distance: p.distance,
    address: p.address.formatted ?? null,
    tags: p.tags,
    alreadyMine: false,
    friendsCount: 0,
  };
}

export function fromSearch(r: SearchResult, index: number): Candidate {
  return {
    key: r.ref ? `osm:${r.ref.type}/${r.ref.id}` : `search:${index}:${r.location.lat},${r.location.lon}`,
    source: 'search',
    ref: r.kind === 'poi' && r.ref ? r.ref : null,
    placeId: r.kind === 'poi' && r.ref ? placeIdFromOsm(r.ref.type, r.ref.id) : null,
    name: r.name,
    category: r.category,
    osmCategory: r.osmKey && r.osmValue ? `${r.osmKey}=${r.osmValue}` : null,
    lat: r.location.lat,
    lon: r.location.lon,
    distance: r.distance ?? null,
    address: r.label || null,
    tags: null,
    alreadyMine: false,
    friendsCount: 0,
  };
}

/** A place already on this device (offline fallback, or local search). */
export function fromLocal(h: PlaceHit): Candidate {
  return {
    key: h.id,
    source: 'local',
    ref: h.osmType && h.osmId ? { type: h.osmType, id: h.osmId } : null,
    placeId: h.id,
    name: h.name,
    category: null,
    osmCategory: h.category,
    lat: h.lat,
    lon: h.lon,
    distance: h.distanceM,
    address: null,
    tags: null,
    alreadyMine: h.mine !== null,
    friendsCount: h.friendsCount,
  };
}

export function manualCandidate(at: { lat: number; lon: number }, name = ''): Candidate {
  return {
    key: `manual:${at.lat},${at.lon}`,
    source: 'manual',
    ref: null,
    placeId: null,
    name,
    category: null,
    osmCategory: null,
    lat: at.lat,
    lon: at.lon,
    distance: null,
    address: null,
    tags: null,
    alreadyMine: false,
    friendsCount: 0,
  };
}

export interface KnownState {
  mine: boolean;
  friendsCount: number;
}

/** Marks candidates already saved by me or by friends; keeps the first of duplicates. */
export function annotate(list: readonly Candidate[], known: (placeId: string) => KnownState | null): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of list) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    const k = c.placeId ? known(c.placeId) : null;
    out.push(k ? { ...c, alreadyMine: k.mine, friendsCount: k.friendsCount } : c);
  }
  return out;
}

export function byDistance(a: Candidate, b: Candidate): number {
  return (a.distance ?? Infinity) - (b.distance ?? Infinity);
}

/** My tags linked to the candidate's OSM category (pre-selected in the form). */
export function suggestTags(c: Pick<Candidate, 'osmCategory'>, tags: readonly AppTag[]): string[] {
  if (!c.osmCategory) return [];
  return tags.filter((t) => t.osmCategories.includes(c.osmCategory!)).map((t) => t.id);
}

export interface SaveForm {
  name: string;
  tagIds: string[];
  status: SaveStatus | null;
  priceLevel: PriceLevel | null;
  comment: string;
  commentVisibility: CommentVisibility;
  sharing: Sharing;
}

export function defaultForm(c: Candidate, suggested: string[]): SaveForm {
  return {
    name: c.name,
    tagIds: suggested,
    status: null,
    priceLevel: null,
    comment: '',
    // Spec: comment visibility and sharing are "friends" by default.
    commentVisibility: 'friends',
    sharing: 'friends',
  };
}

export function canSave(c: Candidate, form: SaveForm): boolean {
  return form.name.trim().length > 0 && Number.isFinite(c.lat) && Number.isFinite(c.lon);
}

/** The DataStore input for a candidate and its form (one save, tags in order, first = main). */
export function toSaveInput(c: Candidate, form: SaveForm, newId?: () => string): SaveInput {
  const geometry = { type: 'Point' as const, coordinates: [c.lon, c.lat] };
  const place = c.ref
    ? { osm: c.ref, name: c.name || form.name.trim(), category: c.osmCategory, geometry }
    : { id: c.placeId ?? newLocalPlaceId(newId), name: form.name.trim(), category: c.osmCategory, geometry };
  return {
    place,
    tagIds: form.tagIds,
    mainTagId: form.tagIds[0] ?? null,
    status: form.status,
    priceLevel: form.priceLevel,
    sharing: form.sharing,
    ...(form.comment.trim() ? { comment: form.comment.trim() } : {}),
    commentVisibility: form.commentVisibility,
  };
}

/** Search radius for the "nearby" list: the visible area, between 150 m and 1 km. */
export function nearbyRadius(viewportDiagonalM: number | null | undefined): number {
  if (!viewportDiagonalM || !Number.isFinite(viewportDiagonalM)) return 250;
  return Math.round(Math.min(1000, Math.max(150, viewportDiagonalM / 3)));
}

/** Moves a selected tag first (it becomes the main tag). */
export function makeMain(tagIds: readonly string[], id: string): string[] {
  return [id, ...tagIds.filter((t) => t !== id)];
}
