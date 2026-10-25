/**
 * App-side view of the data package's records: what the map, the filter bar,
 * the list and the card need about a place, built once per data version.
 * Pure (no React, no SQLite), so it is unit-tested with plain objects.
 */
import type { PlaceRecord, SaveRecord, TagRecord } from '@triangulair/data';
import { normalizeElement, type PlaceInfo } from '@triangulair/osm';

import type { IconName } from '../theme/icons';
import { UNTAGGED_COLOR, iconForCategory, isIconName } from '../theme/tags';

export interface AppTag {
  id: string;
  name: string;
  color: string;
  icon: IconName;
  parentId: string | null;
  /** OSM categories (`key=value`) linked to the tag. */
  osmCategories: string[];
}

export function toAppTag(t: TagRecord): AppTag {
  return {
    id: t.id,
    name: t.name,
    color: t.color ?? UNTAGGED_COLOR,
    icon: isIconName(t.icon) ? t.icon : 'fallback',
    parentId: t.parentId,
    osmCategories: [...t.osmCategories],
  };
}

/** Facts about one place used by filters, pins and rows. */
export interface PlaceFacts {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** `key=value`. */
  category: string | null;
  mine: boolean;
  friends: boolean;
  /** My active tags, main tag first. */
  tagIds: string[];
  /** Normalized OSM data, when the place has cached OSM tags. */
  info: PlaceInfo | null;
  status: PlaceRecord['status'];
}

/**
 * PlaceInfo (osm package) from the cached OSM tags of a place. Local places
 * (manual points) can carry tags too (demo data, or info the user filled in).
 */
export function placeInfoOf(place: Pick<PlaceRecord, 'osmType' | 'osmId' | 'osmTags' | 'lat' | 'lon' | 'name'>): PlaceInfo | null {
  if (!place.osmTags) return null;
  const tags = { name: place.name, ...place.osmTags };
  return normalizeElement({
    type: place.osmType ?? 'node',
    id: place.osmId ?? 0,
    lat: place.lat,
    lon: place.lon,
    tags,
  });
}

export function placeFacts(
  place: PlaceRecord,
  mySave: SaveRecord | null,
  friends: boolean,
  activeTagIds: ReadonlySet<string>,
): PlaceFacts {
  return {
    id: place.id,
    name: place.name,
    lat: place.lat,
    lon: place.lon,
    category: place.category,
    mine: !!mySave && mySave.deletedAt === null,
    friends,
    tagIds: mySave ? mySave.tagIds.filter((t) => activeTagIds.has(t)) : [],
    info: placeInfoOf(place),
    status: place.status,
  };
}

/** Icon of a place: its main tag's icon, failing that its OSM category's. */
export function placeIcon(facts: Pick<PlaceFacts, 'tagIds' | 'category'>, tags: ReadonlyMap<string, AppTag>): IconName {
  for (const id of facts.tagIds) {
    const t = tags.get(id);
    if (t && t.icon !== 'fallback') return t.icon;
  }
  return iconForCategory(facts.category);
}
