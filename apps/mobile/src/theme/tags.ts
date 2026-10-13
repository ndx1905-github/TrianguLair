import { ICON_PATHS, type IconName } from './icons';

/**
 * Vivid palette from the spec ("Interface" > "Colors and categories"):
 * saturated colors that all carry a WHITE icon with a dark outline. User-defined
 * tags will pick from it later; phase 0 uses 10 of them for fixed sample tags.
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

/** Phase 0: tags are a fixed list (user-defined tags come with T-108). */
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
  restaurant: { id: 'restaurant', label: 'Restaurant', color: PALETTE.red, icon: 'restaurant' },
  cafe: { id: 'cafe', label: 'Café', color: PALETTE.orange, icon: 'cafe' },
  bakery: { id: 'bakery', label: 'Bakery', color: PALETTE.amber, icon: 'bakery' },
  park: { id: 'park', label: 'Park', color: PALETTE.green, icon: 'park' },
  view: { id: 'view', label: 'Viewpoint', color: PALETTE.cyan, icon: 'view' },
  museum: { id: 'museum', label: 'Museum', color: PALETTE.blue, icon: 'museum' },
  music: { id: 'music', label: 'Music', color: PALETTE.indigo, icon: 'music' },
  bar: { id: 'bar', label: 'Bar', color: PALETTE.violet, icon: 'bar' },
  shop: { id: 'shop', label: 'Shop', color: PALETTE.pink, icon: 'shop' },
  hotel: { id: 'hotel', label: 'Hotel', color: PALETTE.fuchsia, icon: 'hotel' },
};

export const TAG_IDS = Object.keys(TAGS) as TagId[];

/** Fallback for places without a (visible) tag. */
export const UNTAGGED_COLOR: string = PALETTE.slate;

export function tagColor(id: TagId): string {
  return TAGS[id]?.color ?? UNTAGGED_COLOR;
}

export function iconPath(name: IconName): string {
  return ICON_PATHS[name] ?? ICON_PATHS.fallback;
}
