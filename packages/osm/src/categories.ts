/**
 * Category mapping from OSM tags to the app's stable category ids.
 *
 * The ids are part of the stored data (places.category) and drive the
 * default pin icon and which practical filters apply: never rename or reuse
 * one; add new ids at the end of CATEGORY_IDS.
 */
import type { OsmTags } from './types.ts';

export const CATEGORY_IDS = [
  'restaurant',
  'fast_food',
  'cafe',
  'bar',
  'pub',
  'nightclub',
  'ice_cream',
  'bakery',
  'food_shop',
  'wine_shop',
  'supermarket',
  'marketplace',
  'bookshop',
  'clothes',
  'shop',
  'museum',
  'gallery',
  'monument',
  'attraction',
  'viewpoint',
  'theatre',
  'cinema',
  'arts_centre',
  'library',
  'place_of_worship',
  'park',
  'beach',
  'nature',
  'zoo',
  'sport',
  'swimming',
  'hotel',
  'camping',
  'service',
  'other',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

/** Groups decide which practical filters apply (see SPEC "Filters based on source data"). */
export type CategoryGroup = 'food_drink' | 'shopping' | 'culture' | 'nature' | 'leisure' | 'lodging' | 'services' | 'other';

export interface CategoryInfo {
  group: CategoryGroup;
  /** English label (the app translates by id). */
  label: string;
  /** Suggested default icon: a Maki icon name (CC0, https://labs.mapbox.com/maki-icons/). */
  icon: string;
}

export const CATEGORIES: Record<CategoryId, CategoryInfo> = {
  restaurant: { group: 'food_drink', label: 'Restaurant', icon: 'restaurant' },
  fast_food: { group: 'food_drink', label: 'Fast food', icon: 'fast-food' },
  cafe: { group: 'food_drink', label: 'Café', icon: 'cafe' },
  bar: { group: 'food_drink', label: 'Bar', icon: 'bar' },
  pub: { group: 'food_drink', label: 'Pub', icon: 'beer' },
  nightclub: { group: 'food_drink', label: 'Nightclub', icon: 'nightclub' },
  ice_cream: { group: 'food_drink', label: 'Ice cream', icon: 'ice-cream' },
  bakery: { group: 'shopping', label: 'Bakery', icon: 'bakery' },
  food_shop: { group: 'shopping', label: 'Food shop', icon: 'grocery' },
  wine_shop: { group: 'shopping', label: 'Wine shop', icon: 'alcohol-shop' },
  supermarket: { group: 'shopping', label: 'Supermarket', icon: 'grocery' },
  marketplace: { group: 'shopping', label: 'Market', icon: 'shop' },
  bookshop: { group: 'shopping', label: 'Bookshop', icon: 'library' },
  clothes: { group: 'shopping', label: 'Clothes', icon: 'clothing-store' },
  shop: { group: 'shopping', label: 'Shop', icon: 'shop' },
  museum: { group: 'culture', label: 'Museum', icon: 'museum' },
  gallery: { group: 'culture', label: 'Gallery', icon: 'art-gallery' },
  monument: { group: 'culture', label: 'Monument', icon: 'monument' },
  attraction: { group: 'culture', label: 'Attraction', icon: 'attraction' },
  viewpoint: { group: 'nature', label: 'Viewpoint', icon: 'viewpoint' },
  theatre: { group: 'culture', label: 'Theatre', icon: 'theatre' },
  cinema: { group: 'culture', label: 'Cinema', icon: 'cinema' },
  arts_centre: { group: 'culture', label: 'Arts centre', icon: 'theatre' },
  library: { group: 'culture', label: 'Library', icon: 'library' },
  place_of_worship: { group: 'culture', label: 'Place of worship', icon: 'place-of-worship' },
  park: { group: 'nature', label: 'Park', icon: 'park' },
  beach: { group: 'nature', label: 'Beach', icon: 'beach' },
  nature: { group: 'nature', label: 'Nature', icon: 'mountain' },
  zoo: { group: 'leisure', label: 'Zoo, aquarium, theme park', icon: 'zoo' },
  sport: { group: 'leisure', label: 'Sport', icon: 'pitch' },
  swimming: { group: 'leisure', label: 'Swimming', icon: 'swimming' },
  hotel: { group: 'lodging', label: 'Hotel', icon: 'lodging' },
  camping: { group: 'lodging', label: 'Camping', icon: 'campsite' },
  service: { group: 'services', label: 'Service', icon: 'marker' },
  other: { group: 'other', label: 'Place', icon: 'marker' },
};

const FOOD_SHOPS = new Set([
  'butcher', 'cheese', 'chocolate', 'coffee', 'confectionery', 'deli', 'greengrocer', 'seafood', 'tea',
  'spices', 'farm', 'dairy', 'frozen_food', 'health_food', 'pasta', 'food', 'nuts', 'honey', 'water',
  'caterer', 'organic',
]);
const CLOTHES_SHOPS = new Set(['clothes', 'shoes', 'boutique', 'fashion', 'fashion_accessories', 'bag', 'jewelry']);
const LODGING = new Set(['hotel', 'hostel', 'guest_house', 'motel', 'apartment', 'chalet', 'alpine_hut', 'wilderness_hut']);

/** `[key, value]` → category, for the main keys. A value of `*` matches any value. */
const TABLE: Record<string, Record<string, CategoryId>> = {
  amenity: {
    restaurant: 'restaurant',
    fast_food: 'fast_food',
    food_court: 'fast_food',
    cafe: 'cafe',
    bar: 'bar',
    biergarten: 'bar',
    pub: 'pub',
    nightclub: 'nightclub',
    ice_cream: 'ice_cream',
    theatre: 'theatre',
    cinema: 'cinema',
    arts_centre: 'arts_centre',
    library: 'library',
    place_of_worship: 'place_of_worship',
    marketplace: 'marketplace',
  },
  tourism: {
    museum: 'museum',
    gallery: 'gallery',
    attraction: 'attraction',
    artwork: 'attraction',
    viewpoint: 'viewpoint',
    zoo: 'zoo',
    aquarium: 'zoo',
    theme_park: 'zoo',
    camp_site: 'camping',
    caravan_site: 'camping',
  },
  leisure: {
    park: 'park',
    garden: 'park',
    nature_reserve: 'park',
    beach_resort: 'beach',
    sports_centre: 'sport',
    fitness_centre: 'sport',
    stadium: 'sport',
    golf_course: 'sport',
    ice_rink: 'sport',
    climbing: 'sport',
    swimming_pool: 'swimming',
    water_park: 'swimming',
    amusement_arcade: 'zoo',
  },
  natural: {
    beach: 'beach',
    peak: 'nature',
    waterfall: 'nature',
    cave_entrance: 'nature',
    spring: 'nature',
    volcano: 'nature',
  },
};

/** Keys looked at, in priority order. */
export const PRIMARY_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'historic', 'natural', 'craft', 'office'] as const;

/** Values that are street furniture or infrastructure, not places one saves. */
const NOT_A_PLACE: Record<string, Set<string>> = {
  amenity: new Set([
    'bench', 'waste_basket', 'waste_disposal', 'parking', 'parking_space', 'parking_entrance',
    'bicycle_parking', 'motorcycle_parking', 'recycling', 'vending_machine', 'post_box', 'telephone',
    'drinking_water', 'shelter', 'toilets', 'atm', 'charging_station', 'clock', 'grit_bin',
    'hunting_stand', 'loading_dock', 'taxi', 'bicycle_repair_station', 'compressed_air', 'water_point',
    'letter_box', 'public_bookcase', 'fountain', 'bbq', 'feeding_place', 'smoking_area',
  ]),
  tourism: new Set(['information', 'picnic_site']),
  leisure: new Set(['pitch', 'playground', 'picnic_table', 'firepit', 'outdoor_seating', 'track', 'common', 'slipway']),
  historic: new Set(['boundary_stone', 'milestone', 'district', 'yes']),
  natural: new Set(['tree', 'tree_row', 'water', 'wood', 'scrub', 'grassland', 'rock', 'stone']),
  shop: new Set([]),
};

export interface CategoryMatch {
  category: CategoryId;
  /** The tag that decided it, e.g. `{ key: 'amenity', value: 'restaurant' }`. */
  key: string;
  value: string;
  /** Set when the category comes from a lifecycle-prefixed tag (e.g. `disused:shop`). */
  lifecyclePrefix?: string;
}

/** Lifecycle prefixes (https://wiki.openstreetmap.org/wiki/Lifecycle_prefix). */
export const LIFECYCLE_PREFIXES = ['disused', 'abandoned', 'was', 'demolished', 'removed', 'razed', 'destroyed', 'closed'] as const;

export function categoryForTag(key: string, value: string): CategoryId | null {
  if (!value || value === 'no') return null;
  if (NOT_A_PLACE[key]?.has(value)) return null;
  const direct = TABLE[key]?.[value];
  if (direct) return direct;
  switch (key) {
    case 'shop':
      if (value === 'bakery' || value === 'pastry') return 'bakery';
      if (value === 'wine' || value === 'alcohol' || value === 'beverages') return 'wine_shop';
      if (value === 'supermarket' || value === 'convenience' || value === 'greengrocer_market') return 'supermarket';
      if (value === 'books') return 'bookshop';
      if (CLOTHES_SHOPS.has(value)) return 'clothes';
      if (FOOD_SHOPS.has(value)) return 'food_shop';
      return 'shop';
    case 'tourism':
      if (LODGING.has(value)) return 'hotel';
      return null;
    case 'historic':
      return 'monument';
    case 'amenity':
    case 'office':
    case 'craft':
      return 'service';
    default:
      return null;
  }
}

/**
 * Category of a set of tags, or null when it is not a place one saves
 * (bench, parking…). Live tags win; lifecycle-prefixed tags are the fallback,
 * so a closed restaurant still shows as a (closed) restaurant.
 */
export function categorize(tags: OsmTags): CategoryMatch | null {
  for (const key of PRIMARY_KEYS) {
    const value = tags[key];
    if (value === undefined) continue;
    const category = categoryForTag(key, value);
    if (category) return { category, key, value };
  }
  for (const prefix of LIFECYCLE_PREFIXES) {
    for (const key of PRIMARY_KEYS) {
      const value = tags[`${prefix}:${key}`];
      if (value === undefined) continue;
      const category = categoryForTag(key, value);
      if (category) return { category, key, value, lifecyclePrefix: prefix };
    }
  }
  return null;
}

export function categoryGroup(id: CategoryId): CategoryGroup {
  return CATEGORIES[id].group;
}

export function isCategoryId(s: string): s is CategoryId {
  return (CATEGORY_IDS as readonly string[]).includes(s);
}
