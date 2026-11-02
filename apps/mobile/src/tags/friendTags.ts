/**
 * Friends' tags on my map (spec "Interface" > "Others' tags"). Pure,
 * unit-tested.
 *
 * My vocabulary always applies. A friend's tag attaches to one of my tags:
 * 1. by manual mapping ("Léa's 'Bouffe' = my 'Resto'"), remembered per person;
 * 2. by name: case, accents, plurals and common synonyms ("resto" =
 *    "restaurant") ignored;
 * (3. by OSM category, done for the place itself: `tagsByCategory`).
 * With no match it keeps its author's color and icon, and is listed in the
 * "My friends' tags" section, where it can be filtered on, mapped or adopted.
 */
import type { FriendTagRow, TagMappingRecord } from '@triangulair/data';

import type { AppTag, FriendTagRef } from '../places/model';
import { foldText } from './text';

/** Stable key of a friend's tag: the person and the folded name. */
export function friendTagKey(personId: string, name: string): string {
  return `${personId}\n${foldText(name)}`;
}

/** Synonyms, English and French, folded and singular → canonical word. */
const SYNONYMS: Record<string, string> = {
  resto: 'restaurant',
  restau: 'restaurant',
  restaurants: 'restaurant',
  bouffe: 'restaurant',
  food: 'restaurant',
  manger: 'restaurant',
  coffee: 'cafe',
  'coffee shop': 'cafe',
  musee: 'museum',
  boulangerie: 'bakery',
  'point de vue': 'viewpoint',
  vue: 'viewpoint',
  view: 'viewpoint',
  parc: 'park',
  jardin: 'park',
  garden: 'park',
  musique: 'music',
  concert: 'music',
  boutique: 'shop',
  magasin: 'shop',
  hotel: 'hotel',
  pub: 'bar',
  cocktail: 'bar',
  vin: 'wine',
  'bar a vin': 'wine',
  pizzeria: 'pizza',
  pizzas: 'pizza',
  librairie: 'bookshop',
  'book shop': 'bookshop',
  bookstore: 'bookshop',
};

/** Simple plural folding (English and French): "bars" → "bar", "gâteaux" → "gateau", "journaux" → "journal". */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('eaux')) return word.slice(0, -1);
  if (word.length > 4 && word.endsWith('aux')) return `${word.slice(0, -3)}al`;
  if (word.length > 3 && (word.endsWith('s') || word.endsWith('x')) && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Name used to match tags: folded, punctuation removed, singular, synonyms resolved. */
export function normalizeTagName(name: string): string {
  const folded = foldText(name)
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (SYNONYMS[folded]) return SYNONYMS[folded]!;
  const words = folded.split(' ').map(singular).join(' ');
  return SYNONYMS[words] ?? words;
}

export type FriendTagMatch = { tagId: string; via: 'manual' | 'name' } | null;

/** My tag a friend's tag attaches to, or null. A manual mapping to a tag I no longer have is ignored. */
export function resolveFriendTag(
  personId: string,
  name: string,
  myTags: readonly AppTag[],
  mappings: readonly TagMappingRecord[],
): FriendTagMatch {
  const active = new Set(myTags.map((t) => t.id));
  const key = foldText(name);
  const manual = mappings.find((m) => m.personId === personId && foldText(m.theirTag) === key && active.has(m.myTagId));
  if (manual) return { tagId: manual.myTagId, via: 'manual' };
  const n = normalizeTagName(name);
  if (!n) return null;
  // Prefer a top-level tag when a sub-tag has the same name.
  const hits = myTags.filter((t) => normalizeTagName(t.name) === n);
  const best = hits.find((t) => !t.parentId) ?? hits[0];
  return best ? { tagId: best.id, via: 'name' } : null;
}

export interface FriendTagEntry {
  key: string;
  personId: string;
  personName: string;
  /** The name as the friend wrote it. */
  name: string;
  color: string | null;
  icon: string | null;
  /** Places of this friend carrying the tag. */
  count: number;
  match: FriendTagMatch;
  /** Unmapped and drawn in the same color as one of my tags (flagged in the panel). */
  clashWith: string | null;
}

export interface FriendTagIndex {
  /** By place: my tags reached through friends' tags, and the unmapped ones. */
  byPlace: Map<string, { mapped: string[]; unmapped: FriendTagRef[] }>;
  /** One entry per person and tag, unmapped first, then by count. */
  entries: FriendTagEntry[];
}

export function buildFriendTagIndex(
  rows: readonly FriendTagRow[],
  myTags: readonly AppTag[],
  mappings: readonly TagMappingRecord[],
  personName: (personId: string) => string,
): FriendTagIndex {
  const byPlace = new Map<string, { mapped: string[]; unmapped: FriendTagRef[] }>();
  const entries = new Map<string, FriendTagEntry>();
  const colorOwner = new Map(myTags.map((t) => [t.color.toUpperCase(), t.id]));
  for (const r of rows) {
    const key = friendTagKey(r.personId, r.name);
    let e = entries.get(key);
    if (!e) {
      const match = resolveFriendTag(r.personId, r.name, myTags, mappings);
      e = {
        key,
        personId: r.personId,
        personName: personName(r.personId),
        name: r.name,
        color: r.color,
        icon: r.icon,
        count: 0,
        match,
        clashWith: !match && r.color ? (colorOwner.get(r.color.toUpperCase()) ?? null) : null,
      };
      entries.set(key, e);
    }
    e.count++;
    const slot = byPlace.get(r.placeId) ?? { mapped: [], unmapped: [] };
    if (e.match) {
      if (!slot.mapped.includes(e.match.tagId)) slot.mapped.push(e.match.tagId);
    } else if (!slot.unmapped.some((u) => u.key === key)) {
      slot.unmapped.push({ key, personId: r.personId, name: r.name, color: r.color, icon: r.icon });
    }
    byPlace.set(r.placeId, slot);
  }
  const list = [...entries.values()].sort(
    (a, b) => Number(!!a.match) - Number(!!b.match) || b.count - a.count || a.name.localeCompare(b.name),
  );
  return { byPlace, entries: list };
}
