/**
 * Pure helpers of the list sharing screens (T-211, T-212): list links, the "looks like a home"
 * warning before a place enters a public list (spec "Privacy": "Warning when a place looks like a
 * home (residential address) before adding it to a public list": going public, the place card,
 * the editor of a public list, and the places a public filter list holds; review M-02), followed lists grouped by author,
 * and the wording keys of a gone list.
 */
import { representativePoint, type ListFilter, type PlaceRecord } from '@triangulair/data';
import { looksLikeHome, type FollowedListInfo, type ListGone, type PlaceFeature } from '@triangulair/sync';

import type { MapPin } from '../components/map/types';
import { findLink, LIST_PREFIX } from '../contacts/links';
import { iconPath, isIconName, UNTAGGED_COLOR } from '../theme/tags';

/** `https://triangulair.app/l#<fragment>`: opens the app (or the store page) on "Follow this list". */
export function buildListLink(fragment: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(fragment)) throw new Error('list fragment: base64url expected');
  return LIST_PREFIX + fragment;
}

/** The fragment of the first list link in `text` (a pasted message, a QR code, a deep link), or null. */
export function listFragmentOf(text: string): string | null {
  const f = findLink(text);
  return f && f.kind === 'list' ? f.fragment : null;
}

/**
 * Places that may be a private address (the sync package's rule, `looksLikeHome`, which also keeps
 * such places out of the public file while a public filter list holds them): a dwelling (OSM
 * category), or a place without any category (an address node, a point placed by hand). Zones are
 * left out (a neighbourhood is not an address).
 */
export function homeLikePlaces<P extends Pick<PlaceRecord, 'kind' | 'category' | 'osmType' | 'address'>>(places: readonly P[]): P[] {
  return places.filter((p) => looksLikeHome({ kind: p.kind, category: p.category, local: p.osmType === null, address: p.address }));
}

/**
 * The places that need the "looks like a home" confirmation before they enter `list` (spec
 * "Privacy"): only when the list is public, only the home-like ones among `places`.
 */
export function homesToConfirm<P extends Pick<PlaceRecord, 'kind' | 'category' | 'osmType' | 'address'>>(list: { visibility: string } | null | undefined, places: readonly P[]): P[] {
  return list?.visibility === 'public' ? homeLikePlaces(places) : [];
}

/** A list filter with `placeIds` included (published) or excluded (left out) by hand. */
export function confirmInFilter(f: ListFilter, placeIds: readonly string[], include: boolean): ListFilter {
  const ids = new Set(placeIds);
  const inc = (f.include ?? []).filter((x) => !ids.has(x));
  const exc = (f.exclude ?? []).filter((x) => !ids.has(x));
  return { ...f, include: include ? [...inc, ...ids] : inc, exclude: include ? exc : [...exc, ...ids] };
}

export interface AuthorGroup {
  owner: string;
  name: string;
  lists: FollowedListInfo[];
}

/** Followed lists by author (name from my contacts, else the one in the list, else "" for the screen to fill). */
export function groupByAuthor(lists: readonly FollowedListInfo[], contactName: (owner: string) => string | undefined): AuthorGroup[] {
  const m = new Map<string, AuthorGroup>();
  for (const l of lists) {
    let g = m.get(l.owner);
    if (!g) m.set(l.owner, (g = { owner: l.owner, name: contactName(l.owner) || l.author || '', lists: [] }));
    if (!g.name && l.author) g.name = l.author;
    g.lists.push(l);
  }
  for (const g of m.values()) g.lists.sort((a, b) => a.name.localeCompare(b.name));
  return [...m.values()].sort((a, b) => (a.name || '￿').localeCompare(b.name || '￿'));
}

/** "This list no longer exists" / "This link no longer works". */
export function goneKey(gone: ListGone): string {
  return gone === 'deleted' ? 'sharing.gone.deleted' : 'sharing.gone.linkDead';
}

/** Pins of a list preview (its places are not in my database yet): their author's tag colors and icon. */
export function featurePins(features: readonly PlaceFeature[]): MapPin[] {
  return features.map((f) => {
    const { lat, lon } = representativePoint(f.geometry);
    const tags = f.properties.tags ?? [];
    const icon = tags.find((t) => isIconName(t.icon))?.icon;
    return {
      id: f.id,
      lat,
      lon,
      label: f.properties.name,
      colors: tags.length ? tags.map((t) => t.color ?? UNTAGGED_COLOR) : [UNTAGGED_COLOR],
      iconPath: iconPath(icon),
      faded: false,
      greyed: false,
      ...(f.properties.kind === 'zone' && { badge: true }),
    };
  });
}
