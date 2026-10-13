import type { Place } from '../places/types';
import { visibleTags } from '../places/filter';
import { TAGS, iconPath, tagColor, type TagId } from '../theme/tags';
import type { MapPin } from '../components/map/types';

/** Build the map pin for a place, given the tags hidden by the filter bar. */
export function placeToPin(place: Place, hidden: ReadonlySet<TagId>): MapPin {
  const tags = visibleTags(place, hidden);
  const primary = tags[0];
  return {
    id: place.id,
    lat: place.lat,
    lon: place.lon,
    label: place.name,
    colors: tags.map(tagColor),
    iconPath: iconPath(primary ? TAGS[primary].icon : 'fallback'),
    faded: !place.ownerIsMe,
  };
}
