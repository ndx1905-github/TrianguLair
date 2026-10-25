/**
 * Map pins and clusters from place facts and the active filter. Pure,
 * unit-tested.
 *
 * - No filter: the pin shows my tags as bands (main tag first, icon of the
 *   main tag or of the OSM category).
 * - Filter active: matching pins take the color and icon of the filtered tag;
 *   the others (and places without the information) are grey, translucent
 *   and smaller.
 * - Friends' places (not mine) use my tags linked to their OSM category, and
 *   are drawn lighter.
 */
import type { MapCluster, MapPin } from '../components/map/types';
import type { Cluster } from '../places/clustering';
import { filteredTagOf, type FilterState, type Match } from '../places/filters';
import { placeIcon, type AppTag, type PlaceFacts } from '../places/model';
import { iconPath, UNTAGGED_COLOR } from '../theme/tags';

export interface PinInput {
  facts: PlaceFacts;
  match: Match;
}

export function buildPin(
  { facts, match }: PinInput,
  filter: FilterState,
  tags: readonly AppTag[],
  tagById: ReadonlyMap<string, AppTag>,
  filterActive: boolean,
): MapPin {
  const greyed = filterActive && match !== 'match';
  const filtered = filterActive && !greyed ? filteredTagOf(facts, filter, tags) : null;
  const shownTags = filtered ? [filtered] : facts.tagIds;
  const colors = shownTags.map((id) => tagById.get(id)?.color ?? UNTAGGED_COLOR);
  const icon = filtered ? (tagById.get(filtered)?.icon ?? placeIcon(facts, tagById)) : placeIcon(facts, tagById);
  return {
    id: facts.id,
    lat: facts.lat,
    lon: facts.lon,
    label: facts.name,
    colors: colors.length ? colors : [UNTAGGED_COLOR],
    iconPath: iconPath(icon),
    faded: !facts.mine,
    greyed,
  };
}

/** Color a pin contributes to its cluster (null when greyed). */
export function pinClusterColor(pin: MapPin): string | null {
  return pin.greyed ? null : (pin.colors[0] ?? null);
}

export function toMapCluster(c: Cluster, label: string): MapCluster {
  return { id: c.id, lat: c.lat, lon: c.lon, count: c.count, color: c.color, label };
}

/**
 * Tags of a friend's place on my map (spec "Through the common category"):
 * my tags linked to its OSM category, in my tag order.
 */
export function tagsByCategory(category: string | null, tags: readonly AppTag[]): string[] {
  if (!category) return [];
  return tags.filter((t) => t.osmCategories.includes(category)).map((t) => t.id);
}
