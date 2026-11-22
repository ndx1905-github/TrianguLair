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
 * - Every pin saved by friends shown carries their coloured dots (`colorOf`),
 *   mine included ("Whose map").
 */
import type { MapCluster, MapPin } from '../components/map/types';
import type { Cluster } from '../places/clustering';
import { filteredTagOf, type FilterState, type Match } from '../places/filters';
import { placeIcon, type AppTag, type PlaceFacts } from '../places/model';
import { iconPath, isIconName, UNTAGGED_COLOR } from '../theme/tags';
import { pinDots } from './dots';

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
  /** A friend's colour; without it, no dots. */
  colorOf?: (personId: string) => string,
): MapPin {
  const greyed = filterActive && match !== 'match';
  const filtered = filterActive && !greyed ? filteredTagOf(facts, filter, tags) : null;
  const shownTags = filtered ? [filtered] : facts.tagIds;
  let colors = shownTags.map((id) => tagById.get(id)?.color ?? UNTAGGED_COLOR);
  let icon = filtered ? (tagById.get(filtered)?.icon ?? placeIcon(facts, tagById)) : placeIcon(facts, tagById);
  // A friend's tag I have not mapped keeps its author's color and icon (spec "Others' tags").
  const friendTags = facts.friendTags ?? [];
  if (!filtered && friendTags.length > 0) {
    const chosen = filterActive ? friendTags.filter((t) => filter.friendTags?.includes(t.key)) : [];
    const shown = chosen.length ? chosen : friendTags;
    // Chosen in the filter: the pin takes that tag; otherwise my tags first, then theirs as bands.
    colors = chosen.length ? [] : colors;
    const iconFirst = colors.length === 0;
    colors = [...colors, ...shown.map((t) => t.color ?? UNTAGGED_COLOR)];
    if (iconFirst && isIconName(shown[0]!.icon)) icon = shown[0]!.icon;
  }
  return {
    id: facts.id,
    lat: facts.lat,
    lon: facts.lon,
    label: facts.name,
    colors: colors.length ? colors : [UNTAGGED_COLOR],
    iconPath: iconPath(icon),
    faded: !facts.mine,
    greyed,
    ...(facts.status === 'maybe_closed' ? { maybeClosed: true } : {}),
    ...(colorOf && facts.friendIds?.length ? { dots: pinDots(facts.friendIds, colorOf) } : {}),
  };
}

/** Color a pin contributes to its cluster (null when greyed). */
export function pinClusterColor(pin: MapPin): string | null {
  return pin.greyed ? null : (pin.colors[0] ?? null);
}

/**
 * A pin's accessible label: the place's name, then whose maps it is on ("Le Perchoir, on Léa's map"
 * / "on the maps of Léa and Ben"); my own places say nothing more.
 */
export function pinLabel(facts: Pick<PlaceFacts, 'name' | 'friendIds'>, names: (personId: string) => string, onMaps: (names: string[]) => string): string {
  const ids = facts.friendIds ?? [];
  return ids.length ? `${facts.name}, ${onMaps(ids.map(names))}` : facts.name;
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
