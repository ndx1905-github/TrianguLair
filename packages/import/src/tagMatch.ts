// SPDX-License-Identifier: MPL-2.0
/**
 * Which of my tags a tag of the imported file matches (beta feedback: nothing was suggested when
 * the names differed). Pure.
 *
 * - `same`: the names match once case, accents, emoji, spaces and punctuation are ignored, and a
 *   plural s or x is dropped ("Restaurants 🍝" = "restaurant", "Cafés" = "café"). The import
 *   preselects "map to my tag" for these.
 * - `synonym`: both names are in one group of the built-in table of common categories, in English
 *   and French ("Resto" ≈ "Restaurant", "Coffee" ≈ "Café", "Jardin" ≈ "Park"), whose groups follow
 *   the app's starter tags (apps/mobile/src/theme/tags.ts).
 * - `close`: a small edit distance, or one name contains the other ("Restaurnat", "Bars à vin").
 *
 * Synonyms and close names are only suggested ("Suggested: X" first in the row), never
 * preselected; "Same as my tags where possible" applies every suggestion at once.
 */
import { normalizeText } from '@triangulair/data';

export type TagMatchReason = 'same' | 'synonym' | 'close';

export interface TagSuggestion {
  tagId: string;
  reason: TagMatchReason;
}

export interface MatchableTag {
  id: string;
  name: string;
  parentId?: string | null;
}

/** Drops a plural s or x of a word long enough to have one ("cafés" → "cafe", "bureaux" → "bureau"). */
function singular(word: string): string {
  if (word.length > 3 && /[sx]$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * The name as compared: lower case, no accent, no emoji, no space or punctuation, each word in the
 * singular. Empty for a name made only of emoji or punctuation.
 */
export function tagKey(name: string): string {
  // normalizeText drops accents and replaces everything but letters and digits (emoji included) by spaces.
  return normalizeText(name)
    .split(' ')
    .filter(Boolean)
    .map(singular)
    .join('');
}

/**
 * Common categories, English and French, one group per starter tag (and a few more). Written as
 * plain names; compared through `tagKey`, so case, accents, spaces and plurals do not matter.
 */
export const TAG_SYNONYMS: readonly (readonly string[])[] = [
  ['restaurant', 'resto', 'restau', 'restos', 'food', 'eat', 'eating', 'manger', 'bouffe', 'bistro', 'bistrot', 'brasserie', 'cantine', 'dining', 'diner'],
  ['café', 'cafe', 'coffee', 'coffee shop', 'coffeeshop', 'coffee house', 'bar à café', 'coffea', 'salon de thé', 'tea room', 'tearoom', 'espresso'],
  ['bakery', 'boulangerie', 'pâtisserie', 'patisserie', 'pastry', 'viennoiserie', 'bakeries'],
  ['bar', 'pub', 'bars', 'wine bar', 'bar à vin', 'bar à vins', 'cave à vin', 'cocktail', 'cocktail bar', 'bar à cocktails', 'beer', 'bière', 'brewery', 'brasserie artisanale', 'drinks', 'apéro', 'apero'],
  ['park', 'parc', 'jardin', 'garden', 'gardens', 'square', 'parcs et jardins', 'green space', 'espace vert'],
  ['viewpoint', 'view', 'vue', 'point de vue', 'belvédère', 'belvedere', 'panorama', 'lookout', 'scenic view', 'rooftop'],
  ['museum', 'musée', 'musee', 'gallery', 'galerie', 'art gallery', 'galerie d’art', 'exposition', 'expo', 'exhibition'],
  ['music', 'musique', 'concert', 'concerts', 'live music', 'salle de concert', 'concert hall', 'music venue', 'jazz', 'jazz club'],
  ['shop', 'shopping', 'boutique', 'magasin', 'store', 'shops', 'commerce', 'commerces'],
  ['hotel', 'hôtel', 'hostel', 'auberge', 'auberge de jeunesse', 'hébergement', 'accommodation', 'lodging', 'guest house', 'chambre d’hôte', 'b&b', 'bed and breakfast'],
  ['bookshop', 'librairie', 'bookstore', 'books', 'livres'],
  ['cinema', 'cinéma', 'movie theater', 'movies', 'films'],
  ['ice cream', 'glacier', 'glace', 'gelato'],
  ['market', 'marché', 'marche', 'food market', 'halles'],
];

let synonymIndex: Map<string, number> | null = null;

/** The synonym group of a name's key, if any. */
function groupOf(key: string): number | undefined {
  if (!synonymIndex) {
    synonymIndex = new Map();
    TAG_SYNONYMS.forEach((group, i) => {
      for (const name of group) {
        const k = tagKey(name);
        if (k && !synonymIndex!.has(k)) synonymIndex!.set(k, i);
      }
    });
  }
  return synonymIndex.get(key);
}

/** Levenshtein distance, stopped early once above `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** The edit distance still counted as "close" for keys of this length (none under 4 letters). */
function closeLimit(len: number): number {
  return len < 4 ? 0 : len < 8 ? 1 : 2;
}

/**
 * How close two keys are: 0 = not close, higher = closer (for ranking). One containing the other
 * counts when the shorter has at least 4 letters ("bar" is in too many words).
 */
function closeness(a: string, b: string): number {
  const shorter = a.length <= b.length ? a : b;
  const longer = shorter === a ? b : a;
  const limit = closeLimit(shorter.length);
  if (limit > 0) {
    const d = editDistance(a, b, limit);
    if (d <= limit) return 100 - d;
  }
  if (shorter.length >= 4 && longer.includes(shorter)) return 50 + Math.round((shorter.length / longer.length) * 40);
  return 0;
}

/**
 * The best of my tags for a tag name of the file, or null. A top-level tag wins over a sub-tag
 * of the same rank, then the order of `myTags`.
 */
export function suggestTag(sourceName: string, myTags: readonly MatchableTag[]): TagSuggestion | null {
  const key = tagKey(sourceName);
  if (!key) return null;
  const mine = myTags.map((t, i) => ({ t, i, key: tagKey(t.name) })).filter((m) => m.key);
  const rank = (m: { t: MatchableTag; i: number }) => (m.t.parentId ? 1 : 0) * 1e6 + m.i;
  const pick = <T extends { t: MatchableTag; i: number }>(list: T[], score: (m: T) => number = () => 0): T | undefined =>
    [...list].sort((x, y) => score(y) - score(x) || rank(x) - rank(y))[0];

  const same = pick(mine.filter((m) => m.key === key));
  if (same) return { tagId: same.t.id, reason: 'same' };

  const group = groupOf(key);
  if (group !== undefined) {
    const syn = pick(mine.filter((m) => groupOf(m.key) === group));
    if (syn) return { tagId: syn.t.id, reason: 'synonym' };
  }

  const scored = mine.map((m) => ({ ...m, score: closeness(key, m.key) })).filter((m) => m.score > 0);
  const close = pick(scored, (m) => m.score);
  return close ? { tagId: close.t.id, reason: 'close' } : null;
}

// ------------------------------------------------------------------ tags that are not categories

/**
 * A tag of the file that says something other than a category (owner feedback on Mapstr exports):
 *
 * - `status`: "À essayer" is the status "to try", not a tag. The import proposes the status
 *   (a `status` tag action), which the user can change in the tag step.
 * - `criterion`: "Openair", "Vege friendly", "A emporter" are practical criteria (terrace,
 *   vegetarian, takeaway). TrianguLair reads those from OpenStreetMap only (`outdoor_seating`,
 *   `diet:vegetarian`, `takeaway`); a save has no criterion of its own, so they stay tags and
 *   the tag step says why.
 *
 * Compared through `tagKey` (case, accents, spaces, punctuation and plurals ignored).
 */
export type TagRole = { kind: 'status'; status: 'to_try' } | { kind: 'criterion'; criterion: 'terrace' | 'vegetarian' | 'takeaway' };

export const TAG_ROLE_NAMES: { role: TagRole; names: readonly string[] }[] = [
  { role: { kind: 'status', status: 'to_try' }, names: ['to try', 'want to try', 'à essayer', 'à tester', 'à goûter', 'to test'] },
  { role: { kind: 'criterion', criterion: 'terrace' }, names: ['terrace', 'open air', 'openair', 'outdoor', 'outdoor seating', 'terrasse', 'en terrasse', 'plein air'] },
  { role: { kind: 'criterion', criterion: 'vegetarian' }, names: ['vegetarian', 'veggie', 'vege friendly', 'veggie friendly', 'vegetarian friendly', 'végétarien', 'végé', 'vege'] },
  { role: { kind: 'criterion', criterion: 'takeaway' }, names: ['takeaway', 'take away', 'take-away', 'takeout', 'take out', 'à emporter', 'vente à emporter'] },
];

let roleIndex: Map<string, TagRole> | null = null;

/** What a tag name of the file stands for, when it is not a plain category. */
export function tagRole(name: string): TagRole | null {
  if (!roleIndex) {
    roleIndex = new Map();
    for (const { role, names } of TAG_ROLE_NAMES) for (const n of names) roleIndex.set(tagKey(n), role);
  }
  return roleIndex.get(tagKey(name)) ?? null;
}
