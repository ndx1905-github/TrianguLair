// SPDX-License-Identifier: MPL-2.0
/**
 * CSV readers: Google Takeout "Saved" lists (one CSV per list: `Title, Note,
 * URL[, Tags, Comment]`, the list name being the file name) and generic CSV
 * with a column mapping. `guessMapping` proposes the mapping from the header
 * names (English, French, German, Spanish, Italian synonyms) and from the
 * values (a column of numbers in [-90, 90] next to one in [-180, 180]…); the
 * column-mapping screen lets the user correct it.
 */
import { normalizeText, type SaveStatus } from '@triangulair/data';

import { parseCsv, type CsvTable } from '../csv.ts';
import { isGoogleMapsUrl, parseGoogleMapsUrl, parseLatLonText } from '../google.ts';
import type { ImportedPlace, ParseResult, ParseWarning, SourceFormat, SourceTag } from '../model.ts';
import { baseName, parseDate, parseNumber, parseStatus, splitTags, str, uniq, validLatLon } from '../util.ts';

export type CsvField = 'name' | 'lat' | 'lon' | 'coords' | 'address' | 'url' | 'tags' | 'list' | 'comment' | 'status' | 'created' | 'id' | 'color';

export const CSV_FIELDS: readonly CsvField[] = ['name', 'lat', 'lon', 'coords', 'address', 'url', 'tags', 'list', 'comment', 'status', 'created', 'id', 'color'];

/** Column index (or indexes, for tags and comments that may span several columns) per field. */
export type ColumnMapping = Partial<Record<Exclude<CsvField, 'tags' | 'comment'>, number>> & {
  tags?: number[];
  comment?: number[];
};

const SYNONYMS: Record<CsvField, string[]> = {
  name: ['name', 'title', 'nom', 'titre', 'place', 'place name', 'lieu', 'business name', 'label', 'name of place', 'nombre', 'titel', 'nome', 'venue'],
  lat: ['lat', 'latitude', 'y', 'breitengrad', 'latitud', 'geo latitude', 'location latitude'],
  lon: ['lon', 'lng', 'long', 'longitude', 'x', 'langengrad', 'längengrad', 'longitud', 'geo longitude', 'location longitude'],
  coords: ['coordinates', 'coords', 'coordonnees', 'coordonnées', 'gps', 'location', 'position', 'latlng', 'lat lng', 'lat lon', 'latlon', 'geo', 'koordinaten'],
  address: ['address', 'adresse', 'full address', 'street address', 'formatted address', 'direccion', 'dirección', 'indirizzo', 'anschrift'],
  url: ['url', 'link', 'lien', 'google maps url', 'maps url', 'website', 'site', 'href', 'enlace'],
  tags: ['tags', 'tag', 'categories', 'category', 'categorie', 'catégorie', 'catégories', 'labels', 'etiquettes', 'étiquettes', 'type', 'kategorie', 'categoria'],
  list: ['list', 'liste', 'collection', 'folder', 'dossier', 'map', 'carte', 'group', 'groupe', 'layer', 'calque'],
  comment: ['comment', 'comments', 'note', 'notes', 'description', 'commentaire', 'commentaires', 'remarque', 'remarques', 'memo', 'notiz', 'nota'],
  status: ['status', 'statut', 'state', 'etat', 'état', 'visited', 'tried'],
  created: ['created', 'created at', 'created_at', 'date', 'date added', 'added', 'ajoute le', 'ajouté le', 'date ajout', 'timestamp', 'saved', 'creation date'],
  id: ['id', 'uuid', 'identifier', 'identifiant', 'key'],
  color: ['color', 'colour', 'couleur', 'farbe'],
};

const norm = (h: string) => normalizeText(h).replace(/[_\-.]/g, ' ').replace(/\s+/g, ' ').trim();

function numericShare(table: CsvTable, col: number, min: number, max: number): number {
  // Empty cells do not count (a row may have no position).
  const sample = table.rows
    .slice(0, 50)
    .map((r) => r[col] ?? '')
    .filter((v) => v.trim() !== '');
  if (sample.length === 0) return 0;
  let ok = 0;
  for (const v of sample) {
    const n = parseNumber(v);
    if (n !== null && n >= min && n <= max) ok++;
  }
  return ok / sample.length;
}

/**
 * A mapping from the header names, completed from the values when no header
 * says where the coordinates are. `unmapped` lists the columns left out.
 */
export function guessMapping(table: CsvTable): { mapping: ColumnMapping; unmapped: number[] } {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  const headers = table.headers.map(norm);
  // Exact synonyms first, in field order, then prefix/containment matches.
  for (const pass of ['exact', 'loose'] as const) {
    for (const field of CSV_FIELDS) {
      const syn = SYNONYMS[field].map(norm);
      headers.forEach((h, i) => {
        if (used.has(i) || !h) return;
        const hit = pass === 'exact' ? syn.includes(h) : syn.some((s) => s.length >= 3 && (h.startsWith(`${s} `) || h.endsWith(` ${s}`)));
        if (!hit) return;
        if (field === 'tags' || field === 'comment') {
          (mapping[field] ??= []).push(i);
          used.add(i);
        } else if (mapping[field] === undefined) {
          mapping[field] = i;
          used.add(i);
        }
      });
    }
  }
  // "x"/"y" alone are weak hints: only keep them if the values fit.
  if (mapping.lat !== undefined && numericShare(table, mapping.lat, -90, 90) < 0.8) {
    used.delete(mapping.lat);
    delete mapping.lat;
  }
  if (mapping.lon !== undefined && numericShare(table, mapping.lon, -180, 180) < 0.8) {
    used.delete(mapping.lon);
    delete mapping.lon;
  }
  if (mapping.lat === undefined || mapping.lon === undefined) {
    // Two adjacent numeric columns, the first within [-90, 90].
    for (let i = 0; i + 1 < table.headers.length; i++) {
      if (used.has(i) || used.has(i + 1)) continue;
      if (numericShare(table, i, -90, 90) >= 0.9 && numericShare(table, i + 1, -180, 180) >= 0.9) {
        mapping.lat = i;
        mapping.lon = i + 1;
        used.add(i).add(i + 1);
        break;
      }
    }
  }
  if (mapping.coords === undefined && (mapping.lat === undefined || mapping.lon === undefined)) {
    // A column of "lat, lon" values whatever its header.
    const i = table.headers.findIndex((_, c) => {
      if (used.has(c)) return false;
      const vals = table.rows.slice(0, 20).map((r) => (r[c] ?? '').trim()).filter(Boolean);
      return vals.length > 0 && vals.filter((v) => parseLatLonText(v)).length / vals.length >= 0.9;
    });
    if (i >= 0) {
      mapping.coords = i;
      used.add(i);
    }
  }
  if (mapping.coords !== undefined) {
    const sample = table.rows.slice(0, 20).map((r) => r[mapping.coords!] ?? '');
    if (!sample.some((v) => parseLatLonText(v))) {
      used.delete(mapping.coords);
      delete mapping.coords;
    }
  }
  if (mapping.url === undefined) {
    const i = table.headers.findIndex((_, c) => !used.has(c) && table.rows.slice(0, 10).some((r) => isGoogleMapsUrl(r[c] ?? '')));
    if (i >= 0) {
      mapping.url = i;
      used.add(i);
    }
  }
  if (mapping.name === undefined) {
    // First text column with mostly non-numeric, non-URL values.
    const i = table.headers.findIndex(
      (_, c) => !used.has(c) && table.rows.slice(0, 20).filter((r) => (r[c] ?? '').trim() && parseNumber(r[c]) === null && !/^https?:/.test(r[c] ?? '')).length >= Math.min(1, table.rows.length),
    );
    if (i >= 0) {
      mapping.name = i;
      used.add(i);
    }
  }
  const unmapped = table.headers.map((_, i) => i).filter((i) => !used.has(i));
  return { mapping, unmapped };
}

/** Is this enough to import? A name, and a position or something to look it up with. */
export function mappingProblems(m: ColumnMapping): ('name' | 'position')[] {
  const out: ('name' | 'position')[] = [];
  if (m.name === undefined) out.push('name');
  const position = (m.lat !== undefined && m.lon !== undefined) || m.coords !== undefined || m.address !== undefined || m.url !== undefined;
  if (!position) out.push('position');
  return out;
}

/** Status from a Google default list name (the CSV file name). */
export function statusFromListName(list: string): SaveStatus | undefined {
  const s = normalizeText(list);
  if (/^(favou?rite places|favorites?|favou?rites|lieux favoris|favoris|starred places|lieux suivis)$/.test(s)) return 'favorite';
  if (/^(want to go|envie d y aller|a visiter|wishlist|to try|a tester)$/.test(s)) return 'to_try';
  return parseStatus(list);
}

export interface CsvParseOptions {
  /** Tag added to every row (Google: the list name). */
  listTag?: string;
  format?: SourceFormat;
  /** Status for rows without one (Google: from the list name). */
  defaultStatus?: SaveStatus;
}

export function parseCsvWithMapping(table: CsvTable, mapping: ColumnMapping, opts: CsvParseOptions = {}): ParseResult {
  const warnings: ParseWarning[] = [];
  const places: ImportedPlace[] = [];
  const tagDefs = new Map<string, SourceTag>();
  const cell = (r: string[], i: number | undefined) => (i === undefined ? undefined : str(r[i]));
  table.rows.forEach((r, idx) => {
    const key = `r${idx + 2}`; // spreadsheet row number (header is row 1)
    const name = cell(r, mapping.name);
    if (!name) {
      warnings.push({ code: 'no-name', at: key });
      return;
    }
    let lat: number | undefined;
    let lon: number | undefined;
    const la = parseNumber(cell(r, mapping.lat));
    const lo = parseNumber(cell(r, mapping.lon));
    if (validLatLon(la, lo)) {
      lat = la!;
      lon = lo!;
    } else if (la !== null || lo !== null) {
      warnings.push({ code: 'bad-coordinates', at: key });
    }
    if (lat === undefined) {
      const p = parseLatLonText(cell(r, mapping.coords) ?? '');
      if (p) ({ lat, lon } = p);
    }
    const url = cell(r, mapping.url);
    const fromUrl = url && isGoogleMapsUrl(url) ? parseGoogleMapsUrl(url) : null;
    if (lat === undefined && fromUrl?.lat !== undefined) {
      lat = fromUrl.lat;
      lon = fromUrl.lon;
    }
    const address = cell(r, mapping.address);
    if (lat === undefined) warnings.push({ code: 'no-coordinates', at: key });
    const list = cell(r, mapping.list);
    const tags = uniq([...(opts.listTag ? [opts.listTag] : []), ...(list ? [list] : []), ...(mapping.tags ?? []).flatMap((i) => splitTags(r[i]))]);
    const color = cell(r, mapping.color);
    for (const t of tags) if (!tagDefs.has(t)) tagDefs.set(t, { key: t, name: t });
    if (color && tags[0]) {
      const def = tagDefs.get(tags[0])!;
      const c = /^#?[0-9a-f]{6}$/i.test(color) ? `#${color.replace('#', '').toUpperCase()}` : undefined;
      if (c && !def.color) def.color = c;
    }
    const comment = (mapping.comment ?? [])
      .map((i) => str(r[i]))
      .filter((x): x is string => !!x)
      .filter((x, i, all) => all.indexOf(x) === i)
      .join('\n\n');
    const status = parseStatus(cell(r, mapping.status)) ?? opts.defaultStatus;
    const createdAt = parseDate(cell(r, mapping.created));
    const sourceId = cell(r, mapping.id);
    places.push({
      key,
      name,
      ...(lat !== undefined && { lat, lon: lon! }),
      ...(address && { address }),
      tags,
      ...(comment && { comment }),
      ...(status && { status }),
      ...(url && { url }),
      ids: { ...(fromUrl?.ids ?? {}), ...(sourceId && { sourceId }) },
      ...(createdAt && { createdAt }),
    });
  });
  if (places.length === 0) warnings.push({ code: 'empty' });
  return { format: opts.format ?? 'csv', places, tags: [...tagDefs.values()], warnings };
}

/** Takeout "Saved" CSV: `Title` and `URL` columns, and Google Maps links in the URL column. */
export function isGoogleSavedCsv(table: CsvTable): boolean {
  const h = table.headers.map(norm);
  const t = h.indexOf('title');
  const u = h.indexOf('url');
  if (t < 0 || u < 0) return false;
  const urls = table.rows.map((r) => r[u] ?? '').filter((x) => x.trim());
  return urls.length === 0 || urls.some(isGoogleMapsUrl);
}

export function parseGoogleSavedCsv(table: CsvTable, fileName: string): ParseResult {
  const h = table.headers.map(norm);
  const col = (n: string) => {
    const i = h.indexOf(n);
    return i >= 0 ? i : undefined;
  };
  const list = baseName(fileName) || 'Saved';
  const status = statusFromListName(list);
  const mapping: ColumnMapping = {
    ...(col('title') !== undefined && { name: col('title')! }),
    ...(col('url') !== undefined && { url: col('url')! }),
    comment: [col('note'), col('comment')].filter((x): x is number => x !== undefined),
    ...(col('tags') !== undefined && { tags: [col('tags')!] }),
  };
  return parseCsvWithMapping(table, mapping, { listTag: list, format: 'google-saved-csv', ...(status && { defaultStatus: status }) });
}

export { parseCsv };
