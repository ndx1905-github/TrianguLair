import { ICON_PATHS, type IconName } from './icons';

/**
 * Tag palette. Modern, saturated colors (roughly Tailwind 500-level) chosen to
 * stay distinguishable from each other and to carry a WHITE icon with a dark
 * halo. Phase 0: tags are a fixed list; user-defined tags will pick from this
 * palette later.
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
  label: string;
  color: string;
  icon: IconName;
}

export const TAGS: Record<TagId, TagDef> = {
  restaurant: { id: 'restaurant', label: 'Restaurant', color: '#EF4444', icon: 'restaurant' },
  cafe: { id: 'cafe', label: 'Café', color: '#F97316', icon: 'cafe' },
  bakery: { id: 'bakery', label: 'Bakery', color: '#EAB308', icon: 'bakery' },
  park: { id: 'park', label: 'Park', color: '#22C55E', icon: 'park' },
  view: { id: 'view', label: 'Viewpoint', color: '#06B6D4', icon: 'view' },
  museum: { id: 'museum', label: 'Museum', color: '#3B82F6', icon: 'museum' },
  music: { id: 'music', label: 'Music', color: '#6366F1', icon: 'music' },
  bar: { id: 'bar', label: 'Bar', color: '#A855F7', icon: 'bar' },
  shop: { id: 'shop', label: 'Shop', color: '#EC4899', icon: 'shop' },
  hotel: { id: 'hotel', label: 'Hotel', color: '#B45309', icon: 'hotel' },
};

export const TAG_IDS = Object.keys(TAGS) as TagId[];

/** Fallback for places without a (visible) tag. */
export const UNTAGGED_COLOR = '#64748B';

export function tagColor(id: TagId): string {
  return TAGS[id]?.color ?? UNTAGGED_COLOR;
}

export function iconPath(name: IconName): string {
  return ICON_PATHS[name] ?? ICON_PATHS.fallback;
}
