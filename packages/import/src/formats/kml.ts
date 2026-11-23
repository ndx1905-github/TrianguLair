// SPDX-License-Identifier: MPL-2.0
/**
 * KML (Google My Maps, Google Earth, Organic Maps, many pin apps) and KMZ (a
 * zip holding `doc.kml`, unzipped with fflate, pure JavaScript).
 *
 * - A Placemark's Folder (a My Maps layer) becomes a tag; with no folder, the
 *   Document name does.
 * - Colors: from the style (`IconStyle/color`, `aabbggrr`), from My Maps
 *   style ids (`#icon-1899-0288D1`) or Organic Maps names (`#placemark-red`).
 * - Points become places; lines and polygons become zones.
 * - `ExtendedData` fields named like tags/status/address/url/date are read.
 */
import { unzipSync } from 'fflate';

import type { ImportedPlace, ParseResult, ParseWarning, SourceTag, ZoneGeometry } from '../model.ts';
import { parseGoogleMapsUrl } from '../google.ts';
import { bytesToText, kmlColor, normalizeColor, parseDate, parseStatus, splitTags, str, stripHtml, uniq, validLatLon } from '../util.ts';
import { allText, child, childText, children, descendants, parseXml, type XmlElement } from '../xml.ts';
import { locate, pick } from './geojson.ts';

const ORGANIC_COLORS: Record<string, string> = {
  red: '#E51B23',
  pink: '#FF4182',
  purple: '#9B24B2',
  deeppurple: '#6639BF',
  blue: '#0066CC',
  lightblue: '#249CF2',
  cyan: '#14BECD',
  teal: '#00A58C',
  green: '#3C8C3C',
  lime: '#93BF39',
  yellow: '#FFC800',
  orange: '#FF9600',
  deeporange: '#F06432',
  brown: '#804633',
  gray: '#737373',
  bluegray: '#597380',
};

export function looksLikeKml(text: string): boolean {
  return /<kml[\s>]/i.test(text.slice(0, 2000));
}

/** Coordinates text "lon,lat[,alt] lon,lat…" → positions. */
function coords(text: string | undefined): number[][] {
  if (!text) return [];
  return text
    .trim()
    .split(/\s+/)
    .map((t) => t.split(',').map(Number))
    .filter((c) => c.length >= 2 && validLatLon(c[1], c[0]))
    .map((c) => [c[0]!, c[1]!]);
}

function ring(el: XmlElement | undefined): number[][] {
  if (!el) return [];
  const lr = child(el, 'LinearRing');
  const r = coords(lr ? childText(lr, 'coordinates') : undefined);
  if (r.length >= 3) {
    const [f, l] = [r[0]!, r[r.length - 1]!];
    if (f[0] !== l[0] || f[1] !== l[1]) r.push([f[0]!, f[1]!]);
  }
  return r;
}

function polygon(el: XmlElement): number[][][] | null {
  const outer = ring(child(el, 'outerBoundaryIs'));
  if (outer.length < 4) return null;
  return [outer, ...children(el, 'innerBoundaryIs').map(ring).filter((r) => r.length >= 4)];
}

type KmlGeometry = { type: 'Point'; coordinates: number[] } | ZoneGeometry | null;

function geometryOf(pm: XmlElement): KmlGeometry {
  const point = descendants(pm, 'Point')[0];
  if (point) {
    const c = coords(childText(point, 'coordinates'))[0];
    return c ? { type: 'Point', coordinates: c } : null;
  }
  const polys = descendants(pm, 'Polygon')
    .map(polygon)
    .filter((p): p is number[][][] => p !== null);
  if (polys.length === 1) return { type: 'Polygon', coordinates: polys[0]! };
  if (polys.length > 1) return { type: 'MultiPolygon', coordinates: polys };
  const lines = descendants(pm, 'LineString')
    .map((l) => coords(childText(l, 'coordinates')))
    .filter((l) => l.length >= 2);
  if (lines.length === 1) return { type: 'LineString', coordinates: lines[0]! };
  if (lines.length > 1) return { type: 'MultiLineString', coordinates: lines };
  // gx:Track and other exotic geometries are not places.
  return null;
}

/** Style id → color, from <Style> and <StyleMap> (normal pair) declarations. */
function styleColors(doc: XmlElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of descendants(doc, 'Style')) {
    const id = s.attrs.id;
    if (!id) continue;
    const icon = child(s, 'IconStyle');
    const line = child(s, 'LineStyle');
    const poly = child(s, 'PolyStyle');
    const c = kmlColor(icon && childText(icon, 'color')) ?? kmlColor(poly && childText(poly, 'color')) ?? kmlColor(line && childText(line, 'color'));
    if (c) out.set(id, c);
  }
  for (const sm of descendants(doc, 'StyleMap')) {
    const id = sm.attrs.id;
    if (!id) continue;
    const normal = children(sm, 'Pair').find((p) => childText(p, 'key') === 'normal');
    const ref = normal && childText(normal, 'styleUrl');
    const c = ref ? out.get(ref.replace(/^#/, '')) : undefined;
    if (c) out.set(id, c);
  }
  return out;
}

function colorOf(styleUrl: string | undefined, styles: Map<string, string>): string | undefined {
  if (!styleUrl) return undefined;
  const id = styleUrl.replace(/^.*#/, '');
  // My Maps: "icon-1899-0288D1", "icon-1899-0288D1-nodesc", "line-000000-1200", "poly-…".
  const mm = /^(?:icon-\d+|line|poly)-([0-9A-F]{6})\b/i.exec(id);
  if (mm) return normalizeColor(mm[1]);
  const om = /^placemark-([a-z]+)$/.exec(id);
  if (om && ORGANIC_COLORS[om[1]!]) return ORGANIC_COLORS[om[1]!];
  return styles.get(id) ?? styles.get(`${id}-normal`);
}

function extendedData(pm: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  const ed = child(pm, 'ExtendedData');
  if (!ed) return out;
  for (const d of descendants(ed, 'Data')) {
    const name = d.attrs.name;
    const v = childText(d, 'value');
    if (name && v !== undefined) out[name] = v;
  }
  for (const d of descendants(ed, 'SimpleData')) {
    const name = d.attrs.name;
    const v = allText(d).trim();
    if (name && v) out[name] = v;
  }
  return out;
}

export interface KmlOptions {
  /** Format id reported (the KMZ reader passes "kmz"). */
  format?: 'kml' | 'kmz';
}

export function parseKml(text: string, opts: KmlOptions = {}): ParseResult {
  const root = parseXml(text);
  const warnings: ParseWarning[] = [];
  const places: ImportedPlace[] = [];
  const tagDefs = new Map<string, SourceTag>();
  const styles = styleColors(root);
  const doc = descendants(root, 'Document')[0] ?? root;
  const docName = childText(doc, 'name');
  let n = 0;

  const visit = (el: XmlElement, folder: string | undefined) => {
    for (const c of el.children) {
      if (c.name === 'Folder' || c.name === 'Document') visit(c, childText(c, 'name') ?? folder);
      else if (c.name === 'Placemark') handle(c, folder);
    }
  };

  const handle = (pm: XmlElement, folder: string | undefined) => {
    const key = `k${n++}`;
    const data = extendedData(pm);
    const name = childText(pm, 'name') ?? str(pick(data, 'name', 'title', 'nom'));
    const g = geometryOf(pm);
    if (!g) {
      warnings.push({ code: 'unsupported-geometry', at: key });
      return;
    }
    if (!name) {
      warnings.push({ code: 'no-name', at: key });
      return;
    }
    const located = locate(g as never);
    if (located.lat === undefined) {
      warnings.push({ code: 'bad-coordinates', at: key });
      return;
    }
    const listTag = folder ?? docName;
    const color = colorOf(childText(pm, 'styleUrl'), styles);
    const tags = uniq([...(listTag ? [listTag] : []), ...splitTags(pick(data, 'tags', 'tag', 'category', 'categories', 'labels', 'list'))]);
    for (const t of tags) {
      const prev = tagDefs.get(t);
      if (!prev) tagDefs.set(t, { key: t, name: t, ...(color && t === tags[0] && { color }) });
      else if (!prev.color && color && t === tags[0]) prev.color = color;
    }
    const descRaw = childText(pm, 'description') ?? str(pick(data, 'description', 'comment', 'note', 'notes'));
    const desc = descRaw ? stripHtml(descRaw) : undefined;
    const address = childText(pm, 'address') ?? str(pick(data, 'address', 'adresse'));
    const url = str(pick(data, 'url', 'link', 'website', 'google maps url', 'gx_media_links')) ?? childText(pm, 'link');
    const status = parseStatus(pick(data, 'status', 'statut'));
    const when = childText(child(pm, 'TimeStamp') ?? pm, 'when');
    const createdAt = parseDate(when ?? pick(data, 'created', 'date', 'created_at', 'timestamp'));
    const sourceId = pm.attrs.id;
    places.push({
      key,
      name,
      lat: located.lat,
      lon: located.lon!,
      ...(located.shape && { shape: located.shape }),
      ...(address && { address }),
      tags,
      ...(desc && { comment: desc }),
      ...(status && { status }),
      ...(url && { url }),
      ids: { ...(sourceId && { sourceId }), ...(url ? parseGoogleMapsUrl(url).ids : {}) },
      ...(createdAt && { createdAt }),
    });
  };

  visit(doc, undefined);
  if (places.length === 0) warnings.push({ code: 'empty' });
  return { format: opts.format ?? 'kml', places, tags: [...tagDefs.values()], warnings };
}

/** The main KML of a KMZ: `doc.kml` at the root, else the first `.kml` entry. */
export function kmlFromKmz(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => /\.kml$/i.test(f.name) });
  const names = Object.keys(files);
  const main = names.find((n) => n.toLowerCase() === 'doc.kml') ?? names.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  if (!main) throw new Error('This KMZ file holds no KML document.');
  return bytesToText(files[main]!);
}

export function parseKmz(bytes: Uint8Array): ParseResult {
  return parseKml(kmlFromKmz(bytes), { format: 'kmz' });
}

/** A zip starts with "PK\x03\x04". */
export function isZip(bytes: Uint8Array | undefined): boolean {
  return !!bytes && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
