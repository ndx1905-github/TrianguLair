/**
 * Suggested color and icon for a new tag from its name (spec: "sushi" →
 * sushi icon), English and French keywords. Pure, unit-tested; the user can
 * change both.
 */
import type { AppTag } from '../places/model';
import type { IconName } from '../theme/icons';
import { PALETTE } from '../theme/tags';
import { foldText } from './text';

type PaletteName = keyof typeof PALETTE;

/** Keyword (folded, matched at a word start) → icon and color. First match wins. */
const RULES: [RegExp, IconName, PaletteName][] = [
  [/\b(pizz)/, 'pizza', 'red'],
  [/\b(sushi|japon|japan|ramen|noodle|nouille|asia|chinois|chinese|thai|viet|pho\b|dim sum)/, 'noodles', 'red'],
  [/\b(burger|hamburger)/, 'burger', 'red'],
  [/\b(poisson|fish|seafood|fruits de mer|huitre|oyster)/, 'fish', 'sky'],
  [/\b(epic|spicy|indien|indian|curry|mexic)/, 'chili', 'orange'],
  [/\b(vegan|vegetar|veggie|bio\b|organic|healthy)/, 'leaf', 'lime'],
  [/\b(legume|vegetable|primeur|greengrocer)/, 'carrot', 'lime'],
  [/\b(fromag|cheese)/, 'cheese', 'yellow'],
  [/\b(croissant|viennois|brunch|petit dej|breakfast)/, 'croissant', 'amber'],
  [/\b(boulang|bakery|pain\b|bread)/, 'bakery', 'amber'],
  [/\b(patiss|pastry|gateau|cake|dessert|sucre|sweet)/, 'cupcake', 'pink'],
  [/\b(glace|ice ?cream|gelat)/, 'iceCream', 'pink'],
  [/\b(tea\b|teas\b|salon de the)/, 'mug', 'earth'],
  [/\b(cafe|coffee|espresso)/, 'cafe', 'orange'],
  [/\b(biere|beer|pub\b|brasserie|brewery)/, 'beer', 'amber'],
  [/\b(vin\b|vins\b|wine|cave\b|caviste)/, 'wine', 'fuchsia'],
  [/\b(cocktail|bar\b|bars\b|apero|aperitif|happy)/, 'bar', 'violet'],
  [/\b(resto|restaurant|manger|eat\b|food|bouffe|cantine|bistro|diner|dinner|dejeuner|lunch)/, 'restaurant', 'red'],
  [/\b(concert|musique|music|jazz|club|boite|danse|dance)/, 'music', 'indigo'],
  [/\b(theatre|theater|opera|spectacle|show\b)/, 'theatre', 'fuchsia'],
  [/\b(cinema|film|movie)/, 'cinema', 'slate'],
  [/\b(expo|musee|museum)/, 'museum', 'blue'],
  [/\b(galerie|gallery|art\b|arts\b|street art)/, 'palette', 'violet'],
  [/\b(livre|librairie|book|biblio|library)/, 'book', 'earth'],
  [/\b(chateau|castle|patrimoine|heritage|monument)/, 'castle', 'earth'],
  [/\b(eglise|church|cathedral|temple|mosquee|synagog)/, 'church', 'slate'],
  [/\b(vue|view|rooftop|panorama|belvedere|toit)/, 'view', 'cyan'],
  [/\b(plage|beach|mer\b|sea\b)/, 'beach', 'sky'],
  [/\b(rando|hike|hiking|trek|montagne|mountain)/, 'hiking', 'green'],
  [/\b(foret|forest|bois\b|wood)/, 'pine', 'green'],
  [/\b(fleur|flower|jardin|garden)/, 'flower', 'green'],
  [/\b(parc|park|square)/, 'park', 'green'],
  [/\b(piscine|swim|baignade)/, 'swim', 'sky'],
  [/\b(camping|bivouac|tent)/, 'tent', 'green'],
  [/\b(velo|bike|cycl)/, 'bike', 'turquoise'],
  [/\b(sport|gym|fitness|escalade|climb)/, 'dumbbell', 'turquoise'],
  [/\b(marche|market|halle)/, 'storefront', 'pink'],
  [/\b(vetement|clothes|fringue|mode\b|fashion|friperie|vintage)/, 'tshirt', 'pink'],
  [/\b(cadeau|gift|deco\b|design)/, 'gift', 'pink'],
  [/\b(courses|grocery|epicerie|supermarche|supermarket)/, 'cart', 'pink'],
  [/\b(shop|boutique|magasin|achat)/, 'shop', 'pink'],
  [/\b(hotel|hostel|auberge|chambre|bnb|airbnb|dormir|sleep)/, 'hotel', 'fuchsia'],
  [/\b(gare|train|transport)/, 'train', 'slate'],
  [/\b(travail|work|bureau|office|cowork)/, 'briefcase', 'slate'],
  [/\b(maison|home|chez moi|famille|family)/, 'home', 'ink'],
  [/\b(ville|city|quartier|neighbo)/, 'city', 'slate'],
  [/\b(photo|insta)/, 'camera', 'ink'],
  [/\b(favori|favorite|favourite|love|coup de coeur|adore)/, 'heart', 'red'],
  [/\b(top|star|best|meilleur|incontournable|must)/, 'star', 'yellow'],
];

const ORDER = Object.keys(PALETTE) as PaletteName[];

export interface TagStyle {
  color: string;
  icon: IconName;
}

/**
 * Icon from the name's keywords (fallback pin otherwise); color from the
 * keyword, unless another tag already uses it, then the first palette color
 * no tag uses yet.
 */
export function suggestTagStyle(name: string, existing: readonly Pick<AppTag, 'color'>[] = []): TagStyle {
  const n = foldText(name);
  const used = new Set(existing.map((t) => t.color.toUpperCase()));
  const rule = n ? RULES.find(([re]) => re.test(n)) : undefined;
  const icon: IconName = rule?.[1] ?? 'fallback';
  const preferred = rule ? PALETTE[rule[2]] : null;
  if (preferred && !used.has(preferred.toUpperCase())) return { color: preferred, icon };
  const free = ORDER.map((k) => PALETTE[k]).find((c) => !used.has(c.toUpperCase()));
  return { color: free ?? preferred ?? PALETTE[ORDER[existing.length % ORDER.length]!], icon };
}
