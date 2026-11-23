// SPDX-License-Identifier: MPL-2.0
/**
 * Pin Drop export reader, written against a real export (task T-009).
 *
 * Pin Drop exports one JSON file: an object whose `data` array mixes items by
 * `type` (a bare array of those items is accepted too). Other top-level keys
 * (`users`, `org`, `largeNumberOfPins`, `pinResultLimit`,
 * `largeOrgFilteredPinTotal`) are ignored.
 *
 * - `"tag"`: `id` (UUID), `name`, `color` (`#RRGGBB`, any case), `icon` (an
 *   icon name such as `coffee`, `hotdog`, `martini-glass`, or null), owner
 *   fields (ignored).
 * - `"pin"`: `id`, `name`, `description` (may be missing, empty or
 *   multi-line), `lat`, `lng` (numbers), `tags` and `tag_ids` (the same arrays
 *   of tag UUIDs), `date_dropped` (ISO 8601 with an offset, with or without
 *   microseconds: `2024-11-05T09:12:31+00:00`, `…31.582000+00:00`),
 *   `date_updated`, sometimes `date_created`, `favourite`, `isSecret`,
 *   sometimes `wishList`, `address`, `website`, `phoneNumber`, `email` (may be
 *   ""), a GeoJSON `location` Point (the same position), `heroImage` (a file
 *   name, "" or null) with `heroImageThumb`/`heroImageFull` URLs, and `media`
 *   (`{ file, thumb, full, original_name, mime_type, size, … }`). Owner, org
 *   and permission fields (`orgID`, `user_id`, `owner`, `canEdit`,
 *   `isOwner`, `isOrg`, `source`, `timestamp`…) are ignored.
 * - `"message"` and any other type: ignored.
 *
 * Mapping to the common model:
 *
 * - `name` → name (the address when the name is empty; neither: `no-name`,
 *   skipped); `lat`/`lng` → position (else the `location` Point; else none:
 *   `no-coordinates`, then searched by name and address).
 * - `description` → comment (trimmed, line breaks kept).
 * - `date_dropped` → date saved (`createdAt`); `date_created` when missing.
 * - `favourite` → status favorite; `wishList` → status to try (favorite wins).
 *   A tag named like a status ("À essayer") becomes the status in the plan's
 *   tag step, as for Mapstr; criteria ("Openair"…) stay tags.
 * - `isSecret` → the most private settings a save has: `sharing: 'private'`
 *   and `commentVisibility: 'private'` (`secret-places` warning with the count).
 * - `address` → address, used to match the place to OpenStreetMap.
 *   `website`, `phoneNumber` and `email` are not read: the model has no field
 *   for them and the matching does not use them.
 * - Tags: the pin's `tag_ids` (else `tags`) in order, by name (two tags with
 *   the same name are one); the first is the main tag. Only tags some place
 *   uses are listed (like the other readers). A reference to a tag
 *   absent from the file (an edited export), or to a tag without a name, is
 *   left out: one `missing-tags` warning per place concerned.
 * - Tag icon → OSM category (`PINDROP_ICON_CATEGORIES`, obvious ones only):
 *   the place's category is that of its first tag with a known icon (the pin
 *   icon of a manual point, and the "maybe closed" check), and a new tag made
 *   from it gets that category (so places of that category are suggested it).
 *   Pin Drop's icon names are not the app's: they are not kept as tag icons.
 * - Photos (`media`, else the `heroImage`): kept in memory as `remotePhotos`
 *   (the `full` URL first, then `thumb`; their key is Pin Drop's file name).
 *   Counted in the preview; downloaded only if the user asks for it there.
 *   Their URLs are never written.
 * - `id` → `ids.sourceId`.
 */
import { normalizeText } from '@triangulair/data';

import type { ImportedPlace, ParseResult, ParseWarning, RemotePhoto, SourceTag } from '../model.ts';
import { normalizeColor, parseNumber, str, validLatLon } from '../util.ts';

type Obj = Record<string, unknown>;

const asObject = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);

/**
 * Pin Drop icon name → OSM category. Only icons whose meaning is plain; others
 * (sparkles, hand, music…) give no category.
 */
export const PINDROP_ICON_CATEGORIES: Readonly<Record<string, string>> = {
  coffee: 'amenity=cafe',
  'mug-hot': 'amenity=cafe',
  'mug-saucer': 'amenity=cafe',
  croissant: 'shop=bakery',
  'bread-slice': 'shop=bakery',
  'martini-glass': 'amenity=bar',
  'martini-glass-citrus': 'amenity=bar',
  'wine-glass': 'amenity=bar',
  'champagne-glasses': 'amenity=bar',
  'beer-mug-empty': 'amenity=pub',
  beer: 'amenity=pub',
  'ice-cream': 'amenity=ice_cream',
  'building-columns': 'tourism=museum',
  landmark: 'tourism=museum',
  'bench-tree': 'leisure=park',
  tree: 'leisure=park',
  bed: 'tourism=hotel',
  hotel: 'tourism=hotel',
  'shopping-bag': 'shop=yes',
  'bag-shopping': 'shop=yes',
  'cart-shopping': 'shop=supermarket',
  'basket-shopping': 'shop=supermarket',
  hotdog: 'amenity=fast_food',
  burger: 'amenity=fast_food',
  'pizza-slice': 'amenity=fast_food',
  utensils: 'amenity=restaurant',
  film: 'amenity=cinema',
  'umbrella-beach': 'natural=beach',
  binoculars: 'tourism=viewpoint',
};

export function pinDropIconCategory(icon: unknown): string | undefined {
  if (typeof icon !== 'string') return undefined;
  return PINDROP_ICON_CATEGORIES[icon.trim().toLowerCase().replace(/^fa-/, '')];
}

/**
 * ISO 8601 with a zone, any number of fraction digits (Pin Drop writes
 * microseconds, which not every JavaScript engine's `Date.parse` accepts) →
 * ms since the epoch. A date without a zone is read as UTC.
 */
export function parsePinDropDate(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(v.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined;
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  let t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (new Date(t).getUTCDate() !== d) return undefined;
  const z = m[8];
  if (z && z.toUpperCase() !== 'Z') {
    const zz = /^([+-])(\d{2}):?(\d{2})$/.exec(z)!;
    t -= (zz[1] === '-' ? -1 : 1) * (Number(zz[2]) * 60 + Number(zz[3])) * 60_000;
  }
  return t > 0 ? t : undefined;
}

// ------------------------------------------------------------------ detection

function itemsOf(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  const o = asObject(json);
  return o && Array.isArray(o.data) ? o.data : null;
}

const isItem = (v: unknown, type: string) => asObject(v)?.type === type;

function looksLikePin(v: unknown): boolean {
  const o = asObject(v);
  return !!o && o.type === 'pin' && ('lat' in o || 'lng' in o || 'tag_ids' in o || 'date_dropped' in o);
}

function looksLikeTag(v: unknown): boolean {
  const o = asObject(v);
  return !!o && o.type === 'tag' && typeof o.id === 'string' && 'name' in o;
}

/** A `data` array (or a bare array) with Pin Drop pins or tags, every item an object with a `type`. */
export function isPinDropJson(json: unknown): boolean {
  const items = itemsOf(json);
  if (!items || items.length === 0) return false;
  if (!items.every((i) => typeof asObject(i)?.type === 'string')) return false;
  return items.some((i) => looksLikePin(i) || looksLikeTag(i));
}

/** The start of a file that does not parse as JSON but looks like a Pin Drop export (cut short, or edited by hand). */
export function looksLikePinDropText(text: string): boolean {
  const head = text.slice(0, 20000);
  return /"type"\s*:\s*"(?:pin|tag)"/.test(head) && /"(?:date_dropped|tag_ids|isSecret|wishList|largeNumberOfPins|pinResultLimit|heroImage)"\s*:/.test(text);
}

// ------------------------------------------------------------------ reading

function photosOf(pin: Obj): RemotePhoto[] {
  const out: RemotePhoto[] = [];
  const add = (urls: unknown[], key: unknown, mime: unknown) => {
    const u = urls.map(str).filter((x): x is string => !!x && /^https?:\/\//i.test(x));
    if (u.length === 0) return;
    const k = str(key) ?? u[0]!.replace(/[?#].*$/, '');
    if (out.some((p) => p.key === k)) return;
    out.push({ urls: [...new Set(u)], key: k, ...(str(mime) && { mime: str(mime)! }) });
  };
  for (const m of Array.isArray(pin.media) ? pin.media : []) {
    const o = asObject(m);
    if (o) add([o.full, o.thumb], o.file ?? o.original_name, o.mime_type);
  }
  // The hero image is one of the media when there are some; alone, it is the pin's photo.
  if (out.length === 0) add([pin.heroImageFull, pin.heroImageThumb], pin.heroImage, undefined);
  return out;
}

function positionOf(pin: Obj): { lat: number; lon: number } | null {
  const lat = parseNumber(pin.lat);
  const lon = parseNumber(pin.lng ?? pin.lon);
  if (validLatLon(lat, lon)) return { lat: lat!, lon: lon! };
  const loc = asObject(pin.location);
  const c = loc?.type === 'Point' && Array.isArray(loc.coordinates) ? loc.coordinates : [];
  const lo = parseNumber(c[0]);
  const la = parseNumber(c[1]);
  return validLatLon(la, lo) ? { lat: la!, lon: lo! } : null;
}

export function parsePinDrop(json: unknown): ParseResult {
  const items = itemsOf(json) ?? [];
  const warnings: ParseWarning[] = [];

  // Tags by id; same names (once normalized) are one tag, the first one's color kept.
  const tagById = new Map<string, SourceTag>();
  const tagByName = new Map<string, SourceTag>();
  for (const it of items) {
    if (!isItem(it, 'tag')) continue;
    const t = it as Obj;
    const id = str(t.id);
    const name = str(t.name);
    if (!id || !name) continue;
    const k = normalizeText(name);
    let tag = tagByName.get(k);
    if (!tag) {
      const color = normalizeColor(t.color);
      const category = pinDropIconCategory(t.icon);
      tag = { key: name, name, ...(color && { color }), ...(category && !category.endsWith('=yes') && { osmCategories: [category] }) };
      tagByName.set(k, tag);
    }
    tagById.set(id, tag);
  }
  const iconCategory = new Map<string, string>();
  for (const it of items) {
    if (!isItem(it, 'tag')) continue;
    const t = it as Obj;
    const tag = tagById.get(str(t.id) ?? '');
    const c = pinDropIconCategory(t.icon);
    if (tag && c && !iconCategory.has(tag.key)) iconCategory.set(tag.key, c);
  }

  const places: ImportedPlace[] = [];
  const used = new Set<string>();
  let secret = 0;
  items.forEach((it, i) => {
    if (!isItem(it, 'pin')) return;
    const pin = it as Obj;
    const key = `p${places.length}`;
    const address = str(pin.address);
    const name = str(pin.name) ?? address;
    if (!name) {
      warnings.push({ code: 'no-name', at: `i${i}` });
      return;
    }
    const refs = Array.isArray(pin.tag_ids) ? pin.tag_ids : Array.isArray(pin.tags) ? pin.tags : [];
    const tags: string[] = [];
    let missing = false;
    for (const r of refs) {
      const tag = typeof r === 'string' ? tagById.get(r) : undefined;
      if (!tag) {
        missing = true;
        continue;
      }
      if (!tags.includes(tag.key)) tags.push(tag.key);
    }
    if (missing) warnings.push({ code: 'missing-tags', at: key });
    for (const t of tags) used.add(t);
    const pos = positionOf(pin);
    if (!pos) warnings.push({ code: 'no-coordinates', at: key });
    const comment = typeof pin.description === 'string' ? pin.description.replace(/\r\n?/g, '\n').trim() : '';
    const createdAt = parsePinDropDate(pin.date_dropped) ?? parsePinDropDate(pin.date_created);
    const status = pin.favourite === true ? 'favorite' : pin.wishList === true ? 'to_try' : undefined;
    const isSecret = pin.isSecret === true;
    if (isSecret) secret++;
    const category = tags.map((t) => iconCategory.get(t)).find(Boolean);
    const photos = photosOf(pin);
    const id = str(pin.id);
    places.push({
      key,
      name,
      ...(pos && pos),
      ...(address && { address }),
      tags,
      ...(tags[0] && { mainTag: tags[0] }),
      ...(comment && { comment }),
      ...(status && { status }),
      ids: id ? { sourceId: id } : {},
      ...(createdAt !== undefined && { createdAt }),
      ...(category && { category }),
      ...(isSecret && { sharing: 'private' as const, commentVisibility: 'private' as const }),
      ...(photos.length > 0 && { remotePhotos: photos }),
    });
  });

  if (secret > 0) warnings.push({ code: 'secret-places', detail: String(secret) });
  const photos = places.reduce((n, p) => n + (p.remotePhotos?.length ?? 0), 0);
  if (photos > 0) warnings.push({ code: 'remote-photos', detail: String(photos) });
  if (places.length === 0) warnings.push({ code: 'empty' });
  // Tags of the file in their order, those used by a place (like the other readers).
  const tags = [...tagByName.values()].filter((t) => used.has(t.key));
  return { format: 'pindrop', places, tags, warnings };
}
