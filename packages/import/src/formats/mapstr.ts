// SPDX-License-Identifier: MPL-2.0
/**
 * Mapstr export reader, written against a real export (task T-009).
 *
 * Mapstr exports a ZIP (`mapstr.zip`) holding a folder `mapstr/` with two
 * files, plus the usual macOS junk (`__MACOSX/…`, `._*`), which is ignored:
 *
 * - `mapstr.csv`: UTF-8 with a BOM, header exactly
 *   `date,name,address,icon,userComment,rating,tags,photos`.
 *   - `date`: US style without seconds, `6/17/23 18:36` (month/day/2-digit
 *     year, local time);
 *   - `icon`: Mapstr's category key (`restaurant`…);
 *   - `rating`: often empty; its scale is not documented, so it is kept as
 *     written (see `ImportedPlace.rating`);
 *   - `tags`: tag names separated by `#` (`Bar#Salon de thé / café#Restaurant`);
 *     names hold spaces, accents and `/`, so only `#` separates them. The
 *     first one is the main tag;
 *   - `photos`: comma-separated URLs on Mapstr's image server;
 *   - NO coordinates.
 * - `mapstr.geojson`: a FeatureCollection of Points `[lon, lat]` whose
 *   properties are `name`, `address`, `icon`, `userComment` and `tags` as an
 *   array of `{ name, color }` (`#ff5161`). No date, rating or photos.
 *
 * With the ZIP both are used: position, tag colors, icon and comment from the
 * GeoJSON; date, rating and photos from the CSV. Rows are joined by order when
 * both files have as many places and every name + address agrees, otherwise
 * by normalized name + address. A CSV row with no feature keeps no position
 * (the matching step searches it by name and address); a feature with no row
 * has no date.
 *
 * The CSV alone works the same way, without positions (`positions-from-address`
 * warning: the ZIP or the GeoJSON gives exact positions). An invalid GeoJSON
 * alone is an error; inside the ZIP, the CSV is still used
 * (`invalid-geojson` warning).
 *
 * Photo URLs are kept in memory (`remotePhotos`): counted in the preview, and
 * downloaded only if the user asks for it there (that contacts Mapstr's
 * server); never written.
 */
import { normalizeText } from '@triangulair/data';
import { strFromU8, unzipSync } from 'fflate';

import { parseCsv, stripBom, type CsvTable } from '../csv.ts';
import type { ImportedPlace, ParseResult, ParseWarning, SourceTag } from '../model.ts';
import { normalizeColor, str, uniq, validLatLon } from '../util.ts';

export const MAPSTR_CSV_HEADER = ['date', 'name', 'address', 'icon', 'userComment', 'rating', 'tags', 'photos'] as const;

/** Largest file read from the ZIP (a few thousand places weigh well under a megabyte). */
const MAX_ENTRY = 64 * 1024 * 1024;

type Props = Record<string, unknown>;

/**
 * Mapstr icon key → OSM category (`key=value`), for the pin icon and the
 * category of a manual point. Only `restaurant` has been seen in a real
 * export; the others are the obvious keys for Mapstr's categories, and an
 * unknown key simply gives no category.
 */
export const MAPSTR_ICON_CATEGORIES: Readonly<Record<string, string>> = {
  restaurant: 'amenity=restaurant',
  fastfood: 'amenity=fast_food',
  bar: 'amenity=bar',
  pub: 'amenity=pub',
  cafe: 'amenity=cafe',
  coffee: 'amenity=cafe',
  icecream: 'amenity=ice_cream',
  nightclub: 'amenity=nightclub',
  club: 'amenity=nightclub',
  cinema: 'amenity=cinema',
  theatre: 'amenity=theatre',
  theater: 'amenity=theatre',
  library: 'amenity=library',
  bakery: 'shop=bakery',
  supermarket: 'shop=supermarket',
  hotel: 'tourism=hotel',
  museum: 'tourism=museum',
  gallery: 'tourism=gallery',
  viewpoint: 'tourism=viewpoint',
  park: 'leisure=park',
  garden: 'leisure=garden',
  beach: 'natural=beach',
};

export function mapstrIconCategory(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  return MAPSTR_ICON_CATEGORIES[icon.toLowerCase().replace(/[\s_-]/g, '')];
}

/**
 * `6/17/23 18:36` → ms since the epoch, in local time (Mapstr writes the
 * phone's local time without a zone). Month first; a 2-digit year is 20yy.
 * Also accepts a 4-digit year, seconds, and AM/PM.
 */
export function parseMapstrDate(v: string | undefined): number | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec((v ?? '').trim());
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  let hour = Number(m[4] ?? 0);
  const minute = Number(m[5] ?? 0);
  const second = Number(m[6] ?? 0);
  const ampm = m[7]?.toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (ampm === 'pm' ? 12 : 0);
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const d = new Date(year, month - 1, day, hour, minute, second);
  // Rejects 2/30 and the like (Date rolls them over).
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return undefined;
  return d.getTime();
}

/** `Bar#Salon de thé / café#Restaurant` → the names, in order, `#` being the only separator. */
export function splitMapstrTags(v: string | undefined): string[] {
  return uniq(
    (v ?? '')
      .split('#')
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );
}

function splitPhotos(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

// ------------------------------------------------------------------ detection

export function isMapstrCsv(table: CsvTable): boolean {
  const h = table.headers.map((x) => stripBom(x).trim());
  return h.length === MAPSTR_CSV_HEADER.length && MAPSTR_CSV_HEADER.every((name, i) => h[i] === name);
}

function asObject(v: unknown): Props | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Props) : undefined;
}

function featuresOf(json: unknown): unknown[] {
  const o = asObject(json);
  return o && o.type === 'FeatureCollection' && Array.isArray(o.features) ? o.features : [];
}

/** Properties with `userComment` and a `tags` array whose items are `{ name, color }`. */
export function isMapstrGeoJson(json: unknown): boolean {
  const fs = featuresOf(json);
  if (fs.length === 0) return false;
  let tagObjects = 0;
  for (const f of fs.slice(0, 50)) {
    const p = asObject(asObject(f)?.properties);
    if (!p || !('userComment' in p) || !Array.isArray(p.tags)) return false;
    for (const t of p.tags) {
      const o = asObject(t);
      if (!o || typeof o.name !== 'string') return false;
      if (typeof o.color === 'string') tagObjects++;
    }
  }
  // Without any tag, `icon` next to `userComment` is Mapstr's mark.
  return tagObjects > 0 || fs.slice(0, 50).every((f) => 'icon' in (asObject(asObject(f)?.properties) ?? {}));
}

const isJunk = (name: string) => name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name) || /(^|\/)\.DS_Store$/.test(name);
const entryKind = (name: string): 'csv' | 'geojson' | null => {
  if (isJunk(name)) return null;
  const base = name.split('/').pop()!.toLowerCase();
  return base === 'mapstr.csv' ? 'csv' : base === 'mapstr.geojson' ? 'geojson' : null;
};

/** A ZIP holding `mapstr.csv` or `mapstr.geojson` (at any depth; macOS junk ignored). */
export function isMapstrZip(bytes: Uint8Array): boolean {
  let found = false;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        if (entryKind(f.name)) found = true;
        return false;
      },
    });
  } catch {
    return false;
  }
  return found;
}

// ------------------------------------------------------------------ reading

interface CsvRow {
  name: string;
  address?: string;
  createdAt?: number;
  icon?: string;
  comment?: string;
  rating?: string;
  tags: string[];
  photos: string[];
}

interface GeoRow {
  name: string;
  address?: string;
  lat?: number;
  lon?: number;
  icon?: string;
  comment?: string;
  tags: { name: string; color?: string }[];
}

function readCsvRows(text: string, warnings: ParseWarning[]): CsvRow[] {
  const table = parseCsv(stripBom(text), ',');
  const out: CsvRow[] = [];
  table.rows.forEach((r, i) => {
    const cell = (c: (typeof MAPSTR_CSV_HEADER)[number]) => str(r[MAPSTR_CSV_HEADER.indexOf(c)]);
    const name = cell('name');
    if (!name) {
      if (r.some((x) => x.trim())) warnings.push({ code: 'no-name', at: `r${i + 2}` });
      return;
    }
    const createdAt = parseMapstrDate(cell('date'));
    out.push({
      name,
      ...(cell('address') && { address: cell('address')! }),
      ...(createdAt !== undefined && { createdAt }),
      ...(cell('icon') && { icon: cell('icon')! }),
      ...(cell('userComment') && { comment: cell('userComment')! }),
      ...(cell('rating') && { rating: cell('rating')! }),
      tags: splitMapstrTags(cell('tags')),
      photos: splitPhotos(cell('photos')),
    });
  });
  return out;
}

function readGeoRows(json: unknown, warnings: ParseWarning[]): GeoRow[] {
  const out: GeoRow[] = [];
  featuresOf(json).forEach((f, i) => {
    const props = asObject(asObject(f)?.properties) ?? {};
    const name = str(props.name);
    if (!name) {
      warnings.push({ code: 'no-name', at: `f${i}` });
      return;
    }
    const g = asObject(asObject(f)?.geometry);
    const c = g?.type === 'Point' && Array.isArray(g.coordinates) ? (g.coordinates as unknown[]) : [];
    const lon = typeof c[0] === 'number' ? c[0] : undefined;
    const lat = typeof c[1] === 'number' ? c[1] : undefined;
    const tags: GeoRow['tags'] = [];
    for (const t of Array.isArray(props.tags) ? props.tags : []) {
      const o = asObject(t);
      const tn = typeof t === 'string' ? str(t) : str(o?.name);
      if (!tn || tags.some((x) => normalizeText(x.name) === normalizeText(tn))) continue;
      const color = normalizeColor(o?.color);
      tags.push({ name: tn, ...(color && { color }) });
    }
    out.push({
      name,
      ...(str(props.address) && { address: str(props.address)! }),
      ...(validLatLon(lat, lon) && { lat: lat!, lon: lon! }),
      ...(str(props.icon) && { icon: str(props.icon)! }),
      ...(str(props.userComment) && { comment: str(props.userComment)! }),
      tags,
    });
  });
  return out;
}

const joinKey = (name: string, address: string | undefined) => `${normalizeText(name)}|${normalizeText(address ?? '')}`;

/**
 * Pairs CSV rows with GeoJSON features: by order when the counts match and
 * every name + address agrees, else by normalized name + address (in order
 * among equal keys). Returns, for each CSV row, its feature index or -1.
 */
export function joinMapstrRows(csv: readonly { name: string; address?: string }[], geo: readonly { name: string; address?: string }[]): { pairs: number[]; byOrder: boolean } {
  if (csv.length === geo.length && csv.every((r, i) => joinKey(r.name, r.address) === joinKey(geo[i]!.name, geo[i]!.address))) {
    return { pairs: csv.map((_, i) => i), byOrder: true };
  }
  const free = new Map<string, number[]>();
  geo.forEach((g, i) => {
    const k = joinKey(g.name, g.address);
    (free.get(k) ?? free.set(k, []).get(k)!).push(i);
  });
  return { pairs: csv.map((r) => free.get(joinKey(r.name, r.address))?.shift() ?? -1), byOrder: false };
}

export interface MapstrFiles {
  csv?: string;
  /** The GeoJSON text (parsed here, so an invalid file becomes a warning when the CSV is there). */
  geojson?: string;
}

/** Thrown when there is nothing usable: no CSV, and a GeoJSON that is not valid JSON. */
export class InvalidGeoJsonError extends Error {
  constructor() {
    super('The Mapstr GeoJSON file is not valid JSON.');
    this.name = 'InvalidGeoJsonError';
  }
}

export function parseMapstr(files: MapstrFiles): ParseResult {
  const warnings: ParseWarning[] = [];
  let geo: GeoRow[] | null = null;
  if (files.geojson !== undefined) {
    try {
      geo = readGeoRows(JSON.parse(stripBom(files.geojson)), warnings);
    } catch {
      if (files.csv === undefined) throw new InvalidGeoJsonError();
      warnings.push({ code: 'invalid-geojson' });
    }
  }
  const csv = files.csv !== undefined ? readCsvRows(files.csv, warnings) : null;

  const colors = new Map<string, string>();
  const tagOrder: string[] = [];
  const noteTag = (name: string, color?: string) => {
    const k = normalizeText(name);
    if (!tagOrder.some((x) => normalizeText(x) === k)) tagOrder.push(name);
    if (color && !colors.has(k)) colors.set(k, color);
  };
  const places: ImportedPlace[] = [];
  const build = (c: CsvRow | null, g: GeoRow | null) => {
    const key = `m${places.length}`;
    const name = g?.name ?? c!.name;
    for (const t of g?.tags ?? []) noteTag(t.name, t.color);
    const tags = g && g.tags.length > 0 ? g.tags.map((t) => t.name) : (c?.tags ?? []);
    for (const t of tags) noteTag(t);
    const icon = g?.icon ?? c?.icon;
    const category = mapstrIconCategory(icon);
    const address = g?.address ?? c?.address;
    const comment = g?.comment ?? c?.comment;
    if (g?.lat === undefined) warnings.push({ code: 'no-coordinates', at: key });
    places.push({
      key,
      name,
      ...(g?.lat !== undefined && { lat: g.lat, lon: g.lon! }),
      ...(address && { address }),
      tags,
      ...(tags[0] && { mainTag: tags[0] }),
      ...(comment && { comment }),
      ids: {},
      ...(c?.createdAt !== undefined && { createdAt: c.createdAt }),
      ...(category && { category }),
      ...(c?.rating && { rating: c.rating }),
      ...(c && c.photos.length > 0 && { remotePhotos: c.photos.map((url) => ({ urls: [url], key: url.replace(/[?#].*$/, '') })) }),
    });
  };

  if (csv && geo) {
    const { pairs } = joinMapstrRows(csv, geo);
    const used = new Set<number>();
    csv.forEach((row, i) => {
      const gi = pairs[i]!;
      if (gi >= 0) used.add(gi);
      else warnings.push({ code: 'row-not-joined', at: `m${places.length}` });
      build(row, gi >= 0 ? geo![gi]! : null);
    });
    geo.forEach((g, i) => {
      if (!used.has(i)) build(null, g);
    });
  } else if (csv) {
    for (const row of csv) build(row, null);
  } else if (geo) {
    for (const g of geo) build(null, g);
  }

  const unlocated = places.filter((p) => p.lat === undefined).length;
  if (csv && unlocated > 0) warnings.push({ code: 'positions-from-address', detail: String(unlocated) });
  const photos = places.reduce((n, p) => n + (p.remotePhotos?.length ?? 0), 0);
  if (photos > 0) warnings.push({ code: 'remote-photos', detail: String(photos) });
  if (places.length === 0) warnings.push({ code: 'empty' });
  const tags: SourceTag[] = tagOrder.map((name) => {
    const color = colors.get(normalizeText(name));
    return { key: name, name, ...(color && { color }) };
  });
  return { format: 'mapstr', places, tags, warnings };
}

/** The Mapstr ZIP: `mapstr.csv` and/or `mapstr.geojson`, macOS junk ignored. */
export function parseMapstrZip(bytes: Uint8Array): ParseResult {
  const entries = unzipSync(bytes, { filter: (f) => entryKind(f.name) !== null && f.originalSize <= MAX_ENTRY });
  const files: MapstrFiles = {};
  // The shallowest entry wins if a ZIP holds two copies.
  for (const name of Object.keys(entries).sort((a, b) => a.split('/').length - b.split('/').length)) {
    const kind = entryKind(name)!;
    if (files[kind] === undefined) files[kind] = strFromU8(entries[name]!);
  }
  if (files.csv === undefined && files.geojson === undefined) throw new Error('This ZIP holds no Mapstr file.');
  return parseMapstr(files);
}

export const parseMapstrCsv = (text: string): ParseResult => parseMapstr({ csv: text });
export const parseMapstrGeoJson = (text: string): ParseResult => parseMapstr({ geojson: text });
