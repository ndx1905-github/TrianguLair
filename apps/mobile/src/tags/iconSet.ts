/**
 * The curated icon set of the tag editor, grouped like the spec's library
 * (eat, drink, go out, culture, nature, shopping, services, travel). Paths are
 * in theme/icons.ts and theme/iconsExtra.ts (Material Design Icons, Apache-2.0).
 */
import type { IconName } from '../theme/icons';

export const ICON_GROUPS: { id: string; icons: IconName[] }[] = [
  { id: 'eat', icons: ['restaurant', 'pizza', 'noodles', 'burger', 'fish', 'chili', 'carrot', 'cheese'] },
  { id: 'sweet', icons: ['bakery', 'croissant', 'cupcake', 'iceCream'] },
  { id: 'drink', icons: ['cafe', 'mug', 'bar', 'beer', 'wine', 'bottleWine'] },
  { id: 'out', icons: ['music', 'theatre', 'cinema', 'ticket'] },
  { id: 'culture', icons: ['museum', 'palette', 'book', 'castle', 'church'] },
  { id: 'nature', icons: ['park', 'pine', 'flower', 'leaf', 'view', 'beach', 'hiking', 'swim', 'tent', 'bike', 'dumbbell'] },
  { id: 'shopping', icons: ['shop', 'storefront', 'cart', 'tshirt', 'gift'] },
  { id: 'travel', icons: ['hotel', 'home', 'city', 'train', 'briefcase', 'camera', 'star', 'heart', 'fallback'] },
];

export const ALL_TAG_ICONS: IconName[] = ICON_GROUPS.flatMap((g) => g.icons);
