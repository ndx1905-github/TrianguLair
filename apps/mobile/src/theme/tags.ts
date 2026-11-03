import { ICON_PATHS, type IconName } from './icons';

/**
 * Vivid palette from the spec ("Interface" > "Colors and categories"):
 * saturated colors that all carry a WHITE icon with a dark outline.
 */
export const PALETTE = {
  red: '#EF4444',
  pink: '#EC4899',
  fuchsia: '#C026D3',
  violet: '#8B5CF6',
  indigo: '#6366F1',
  blue: '#3B82F6',
  sky: '#0284C7',
  cyan: '#0891B2',
  turquoise: '#0D9488',
  green: '#16A34A',
  lime: '#65A30D',
  yellow: '#FACC15',
  amber: '#D97706',
  orange: '#EA580C',
  earth: '#A16207',
  slate: '#475569',
  ink: '#1E293B',
} as const;

/**
 * Demo vocabulary seeded on first launch (user-defined tags come with T-108).
 * Names are i18n keys (`demoTag.<id>`), resolved in the device language when
 * the tags are created; after that they are the user's own data.
 */
export type TagId =
  | 'restaurant'
  | 'cafe'
  | 'bakery'
  | 'bar'
  | 'park'
  | 'view'
  | 'museum'
  | 'music'
  | 'shop'
  | 'hotel';

export interface TagDef {
  id: TagId;
  /** English label (reference; the seed uses the i18n key `demoTag.<id>`). */
  label: string;
  color: string;
  icon: IconName;
  /** OSM categories (`key=value`) linked to the tag (spec "Through the common category"). */
  osmCategories: string[];
}

export const TAGS: Record<TagId, TagDef> = {
  restaurant: { id: 'restaurant', label: 'Restaurant', color: PALETTE.red, icon: 'restaurant', osmCategories: ['amenity=restaurant', 'amenity=fast_food'] },
  cafe: { id: 'cafe', label: 'Café', color: PALETTE.orange, icon: 'cafe', osmCategories: ['amenity=cafe'] },
  bakery: { id: 'bakery', label: 'Bakery', color: PALETTE.amber, icon: 'bakery', osmCategories: ['shop=bakery', 'shop=pastry'] },
  park: { id: 'park', label: 'Park', color: PALETTE.green, icon: 'park', osmCategories: ['leisure=park', 'leisure=garden'] },
  view: { id: 'view', label: 'Viewpoint', color: PALETTE.cyan, icon: 'view', osmCategories: ['tourism=viewpoint'] },
  museum: { id: 'museum', label: 'Museum', color: PALETTE.blue, icon: 'museum', osmCategories: ['tourism=museum', 'tourism=gallery'] },
  music: { id: 'music', label: 'Music', color: PALETTE.indigo, icon: 'music', osmCategories: ['amenity=music_venue', 'amenity=concert_hall'] },
  bar: { id: 'bar', label: 'Bar', color: PALETTE.violet, icon: 'bar', osmCategories: ['amenity=bar', 'amenity=pub'] },
  shop: { id: 'shop', label: 'Shop', color: PALETTE.pink, icon: 'shop', osmCategories: [] },
  hotel: { id: 'hotel', label: 'Hotel', color: PALETTE.fuchsia, icon: 'hotel', osmCategories: ['tourism=hotel'] },
};

export const TAG_IDS = Object.keys(TAGS) as TagId[];

/** Fallback for places without a (visible) tag. */
export const UNTAGGED_COLOR: string = PALETTE.slate;
/** Pins and clusters outside the active filter. */
export const GREYED_COLOR = '#9CA3AF';

export function tagColor(id: TagId): string {
  return TAGS[id]?.color ?? UNTAGGED_COLOR;
}

export function isIconName(name: string | null | undefined): name is IconName {
  return !!name && Object.prototype.hasOwnProperty.call(ICON_PATHS, name);
}

export function iconPath(name: IconName | string | null | undefined): string {
  return isIconName(name) ? ICON_PATHS[name] : ICON_PATHS.fallback;
}

/**
 * Default icon for an OSM category (`key=value`) when the tag has none
 * (spec "Pins": the tag's icon, failing that the OSM category's).
 */
export function iconForCategory(category: string | null | undefined): IconName {
  if (!category) return 'fallback';
  const [key, value = ''] = category.split('=');
  if (key === 'amenity') {
    if (value === 'restaurant' || value === 'fast_food' || value === 'food_court') return 'restaurant';
    if (value === 'cafe' || value === 'ice_cream') return 'cafe';
    if (value === 'bar' || value === 'pub' || value === 'biergarten' || value === 'nightclub') return 'bar';
    if (value === 'music_venue' || value === 'concert_hall') return 'music';
    if (value === 'marketplace') return 'shop';
  }
  if (key === 'shop') {
    if (value === 'bakery' || value === 'pastry') return 'bakery';
    if (value === 'wine' || value === 'alcohol') return 'wine';
    return 'shop';
  }
  if (key === 'tourism') {
    if (value === 'museum' || value === 'gallery') return 'museum';
    if (value === 'viewpoint') return 'view';
    if (value === 'hotel' || value === 'guest_house' || value === 'hostel') return 'hotel';
  }
  if (key === 'leisure' && (value === 'park' || value === 'garden')) return 'park';
  if (key === 'historic') return 'museum';
  return 'fallback';
}
