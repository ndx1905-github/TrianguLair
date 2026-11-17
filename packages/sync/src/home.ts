// SPDX-License-Identifier: MPL-2.0
/**
 * "Looks like a home" (spec "Privacy": "Warning when a place looks like a home (residential
 * address) before adding it to a public list"; threat model: a public list can expose a third
 * party's private address). One rule for the app's warnings and for the public file:
 *
 * - a dwelling (OSM category `building=house`, `landuse=residential`, …), or
 * - a place without any category: an address node, or a point placed by hand.
 *
 * Zones are left out (a neighbourhood is not an address).
 *
 * The app warns before a place enters a public list by hand (place card, list editor, going
 * public). A *filter* list also takes places by itself ("any new place that meets them enters it
 * automatically"), with nobody to warn: `buildPublicLists` keeps such a place out of the public
 * file until the author confirms it, which the share sheet records as an explicit "include"
 * exception of the filter (`heldPublicPlaces` lists the ones waiting; review M-02).
 */
import { isLocalPlaceId, type ListRecord, type Repository } from '@triangulair/data';
import type { OwnItem } from './features.ts';

/** OSM categories of dwellings. */
export const RESIDENTIAL_CATEGORIES: ReadonlySet<string> = new Set([
  'building=house',
  'building=residential',
  'building=apartments',
  'building=detached',
  'building=semidetached_house',
  'building=terrace',
  'building=bungalow',
  'building=dormitory',
  'building=farm',
  'landuse=residential',
  'place=house',
]);

export interface HomeLikeSubject {
  kind: 'place' | 'zone';
  category: string | null;
  /** The place is not an OSM object (a point placed by hand). */
  local: boolean;
  address: string | null;
}

export function looksLikeHome(p: HomeLikeSubject): boolean {
  if (p.kind === 'zone') return false;
  if (p.category) return RESIDENTIAL_CATEGORIES.has(p.category);
  return p.local || !!p.address;
}

/** `looksLikeHome` for one of my items. */
export function itemLooksLikeHome(it: Pick<OwnItem, 'kind' | 'category' | 'placeId' | 'address'>): boolean {
  return looksLikeHome({ kind: it.kind, category: it.category, local: isLocalPlaceId(it.placeId), address: it.address });
}

/** A place of a public list that the public file may carry: not private, not closed, and not a held home. */
export function publishable(l: Pick<ListRecord, 'kind' | 'filter'>, it: OwnItem): boolean {
  if (it.sharing === 'private' || it.placeStatus === 'closed') return false;
  return !isHeld(l, it);
}

/** A home-like place that a filter list took by itself, not confirmed by the author yet. */
function isHeld(l: Pick<ListRecord, 'kind' | 'filter'>, it: OwnItem): boolean {
  return l.kind === 'filter' && itemLooksLikeHome(it) && !(l.filter.include ?? []).includes(it.placeId);
}

/**
 * Places that my public filter lists hold back from the public file until I confirm them (by list
 * id; lists without any are absent). Confirm = add the place to the filter's `include`; refuse =
 * add it to `exclude`.
 */
export function heldPublicPlaces(repo: Repository, items: readonly OwnItem[]): Map<string, OwnItem[]> {
  const bySave = new Map(items.map((i) => [i.saveId, i]));
  const out = new Map<string, OwnItem[]>();
  for (const l of repo.lists()) {
    if (l.visibility !== 'public' || l.kind !== 'filter') continue;
    const held: OwnItem[] = [];
    for (const s of repo.listItems(l.id)) {
      const it = bySave.get(s);
      if (it && it.sharing !== 'private' && it.placeStatus !== 'closed' && isHeld(l, it)) held.push(it);
    }
    if (held.length) out.set(l.id, held);
  }
  return out;
}
