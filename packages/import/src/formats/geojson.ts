// SPDX-License-Identifier: MPL-2.0
/**
 * GeoJSON readers: Google Takeout "Saved Places.json" (both property layouts
 * seen in Takeout: the older `Title` / `Location.Geo Coordinates` one and the
 * newer `location.name` / `google_maps_url` one), Takeout "Labeled
 * places.json", uMap exports (layers become tags with their colors) and any
 * other GeoJSON, whose property names are guessed (name/title/nom,
 * description/comment/note, tags/category/list, status, url…).
 */
import { isOsmType, representativePoint } from '@triangulair/data';
import type { Feature, Geometry } from 'geojson';

import { parseGoogleMapsUrl } from '../google.ts';
import type { ImportedPlace, ParseResult, ParseWarning, SourceIds, SourceTag, ZoneGeometry } from '../model.ts';
import { normalizeColor, parseDate, parseNumber, parseStatus, splitTags, str, stripHtml, uniq, validLatLon } from '../util.ts';

type Props = Record<string, unknown>;

/** Case- and separator-insensitive property lookup ("Google Maps URL" = "google_maps_url"). */
export function pick(props: Props | null | undefined, ...names: string[]): unknown {
  if (!props) return undefined;
  const norm = (k: string) => k.toLowerCase().replace(/[\s_:-]/g, '');
  const wanted = names.map(norm);
  for (const w of wanted) {
    for (const [k, v] of Object.entries(props)) if (norm(k) === w && v !== null && v !== '') return v;
  }
  return undefined;
}

function asObject(v: unknown): Props | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Props) : undefined;
}

interface Located {
  lat?: number;
  lon?: number;
  shape?: { geometry: ZoneGeometry };
  unsupported?: string;
}

/** Point, MultiPoint (first point), lines and areas (zones). Coordinates [0, 0] mean "unknown" (Takeout). */
export function locate(g: Geometry | null | undefined): Located {
  if (!g) return {};
  switch (g.type) {
    case 'Point': {
      const [lon, lat] = g.coordinates as number[];
      return validLatLon(lat, lon) ? { lat: lat!, lon: lon! } : {};
    }
    case 'MultiPoint': {
      const first = g.coordinates[0];
      return first && validLatLon(first[1], first[0]) ? { lat: first[1]!, lon: first[0]! } : {};
    }
    case 'LineString':
    case 'MultiLineString':
    case 'Polygon':
    case 'MultiPolygon': {
      try {
        const p = representativePoint(g);
        if (!validLatLon(p.lat, p.lon)) return {};
        return { lat: p.lat, lon: p.lon, shape: { geometry: g } };
      } catch {
        return { unsupported: g.type };
      }
    }
    default:
      return { unsupported: g.type };
  }
}

/** OSM identity from common GeoJSON conventions (`@id: node/1`, `osm_type`+`osm_id`, `id: way/2`). */
export function osmIdFrom(props: Props, featureId: unknown): SourceIds['osm'] {
  const candidates = [pick(props, '@id', 'osm', 'osmid', 'osm_ref'), featureId];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const m = /^(?:https?:\/\/(?:www\.)?openstreetmap\.org\/)?(node|way|relation|n|w|r)[/ ]?(\d+)$/.exec(c.trim());
    if (m) {
      const t = m[1]!.length === 1 ? ({ n: 'node', w: 'way', r: 'relation' } as const)[m[1] as 'n' | 'w' | 'r'] : m[1]!;
      if (isOsmType(t)) return { type: t, id: Number(m[2]) };
    }
  }
  const type = pick(props, 'osm_type', 'osmtype');
  const id = parseNumber(pick(props, 'osm_id'));
  if (typeof type === 'string' && id && id > 0) {
    const t = ({ n: 'node', w: 'way', r: 'relation', N: 'node', W: 'way', R: 'relation' } as Record<string, string>)[type] ?? type.toLowerCase();
    if (isOsmType(t)) return { type: t, id };
  }
  return undefined;
}

function features(json: unknown): Feature[] {
  const o = asObject(json);
  if (!o) return [];
  if (o.type === 'FeatureCollection' && Array.isArray(o.features)) return o.features as Feature[];
  if (o.type === 'Feature') return [o as unknown as Feature];
  return [];
}

// ------------------------------------------------------------------ Google Takeout

/** Saved Places.json: a FeatureCollection whose features have a Google Maps URL. */
export function isGoogleSavedPlaces(json: unknown): boolean {
  const fs = features(json);
  return fs.length > 0 && fs.slice(0, 20).some((f) => pick(asObject(f.properties), 'Google Maps URL', 'google_maps_url') !== undefined);
}

/** Labeled places.json: features with only `name` and `address` (Home, Work, custom labels). */
export function isGoogleLabeledPlaces(json: unknown, fileName = ''): boolean {
  if (/labell?ed/i.test(fileName)) return features(json).length > 0;
  const fs = features(json);
  return (
    fs.length > 0 &&
    fs.every((f) => {
      const keys = Object.keys(asObject(f.properties) ?? {}).sort().join(',');
      return keys === 'address,name';
    })
  );
}

export function parseGoogleSavedPlaces(json: unknown, listName = 'Saved places'): ParseResult {
  const warnings: ParseWarning[] = [];
  const places: ImportedPlace[] = [];
  features(json).forEach((f, i) => {
    const props = asObject(f.properties) ?? {};
    const loc = asObject(pick(props, 'Location', 'location')) ?? {};
    const url = str(pick(props, 'Google Maps URL', 'google_maps_url'));
    const fromUrl = url ? parseGoogleMapsUrl(url) : { ids: {} };
    const name =
      str(pick(loc, 'Business Name', 'name')) ?? str(pick(props, 'Title', 'name')) ?? ('name' in fromUrl ? fromUrl.name : undefined) ?? str(pick(loc, 'Address', 'address'));
    let { lat, lon } = locate(f.geometry);
    if (lat === undefined) {
      const geo = asObject(pick(loc, 'Geo Coordinates', 'geo_coordinates'));
      const la = parseNumber(pick(geo, 'Latitude'));
      const lo = parseNumber(pick(geo, 'Longitude'));
      if (validLatLon(la, lo)) {
        lat = la!;
        lon = lo!;
      } else if (fromUrl.lat !== undefined) {
        lat = fromUrl.lat;
        lon = fromUrl.lon;
      }
    }
    const key = `g${i}`;
    if (!name) {
      warnings.push({ code: 'no-name', at: key });
      return;
    }
    if (lat === undefined) warnings.push({ code: 'no-coordinates', at: key });
    const rawComment = str(pick(props, 'Comment', 'comment', 'Note', 'note'));
    // Newer Takeout writes this in place of a comment for places it has no coordinates for.
    const comment = rawComment && /^no location information is available/i.test(rawComment) ? undefined : rawComment;
    const createdAt = parseDate(pick(props, 'Published', 'date', 'published')) ?? parseDate(pick(props, 'Updated'));
    places.push({
      key,
      name,
      ...(lat !== undefined && { lat, lon: lon! }),
      ...(str(pick(loc, 'Address', 'address')) && { address: str(pick(loc, 'Address', 'address'))! }),
      tags: [listName],
      ...(comment && { comment }),
      ...(url && { url }),
      ids: { ...fromUrl.ids },
      ...(createdAt && { createdAt }),
    });
  });
  if (places.length === 0) warnings.push({ code: 'empty' });
  return { format: 'google-saved-geojson', places, tags: [{ key: listName, name: listName }], warnings };
}

export function parseGoogleLabeledPlaces(json: unknown, listName = 'Labeled places'): ParseResult {
  const warnings: ParseWarning[] = [];
  const places: ImportedPlace[] = [];
  features(json).forEach((f, i) => {
    const props = asObject(f.properties) ?? {};
    const key = `l${i}`;
    const name = str(props.name) ?? str(props.address);
    const { lat, lon } = locate(f.geometry);
    if (!name) {
      warnings.push({ code: 'no-name', at: key });
      return;
    }
    if (lat === undefined) warnings.push({ code: 'no-coordinates', at: key });
    places.push({
      key,
      name,
      ...(lat !== undefined && { lat, lon: lon! }),
      ...(str(props.address) && { address: str(props.address)! }),
      tags: [listName],
      ids: {},
    });
  });
  if (places.length === 0) warnings.push({ code: 'empty' });
  return { format: 'google-labeled-geojson', places, tags: [{ key: listName, name: listName }], warnings };
}

// ------------------------------------------------------------------ any GeoJSON (and uMap)

export interface GenericGeoJsonOptions {
  /** Tag added to every place (e.g. the file name), optional. */
  fileTag?: string;
}

/** Turns one generic feature into an ImportedPlace (shared with the Mapstr reader). */
export function genericFeature(f: Feature, key: string, extraTags: string[], warnings: ParseWarning[]): ImportedPlace | null {
  const props = asObject(f.properties) ?? {};
  const name = str(pick(props, 'name', 'title', 'nom', 'label', 'place', 'placename', 'place_name'));
  const located = locate(f.geometry);
  if (located.unsupported) {
    warnings.push({ code: 'unsupported-geometry', at: key, detail: located.unsupported });
    return null;
  }
  if (!name) {
    warnings.push({ code: 'no-name', at: key });
    return null;
  }
  let { lat, lon } = located;
  const url = str(pick(props, 'url', 'link', 'website', 'google_maps_url', 'Google Maps URL', 'href'));
  if (lat === undefined) {
    const la = parseNumber(pick(props, 'lat', 'latitude'));
    const lo = parseNumber(pick(props, 'lon', 'lng', 'long', 'longitude'));
    if (validLatLon(la, lo)) {
      lat = la!;
      lon = lo!;
    } else if (url) {
      const g = parseGoogleMapsUrl(url);
      if (g.lat !== undefined) {
        lat = g.lat;
        lon = g.lon;
      }
    }
  }
  if (lat === undefined) warnings.push({ code: 'no-coordinates', at: key });
  const rawTags = pick(props, 'tags', 'tag', 'categories', 'category', 'lists', 'list', 'labels', 'label_names', 'folder', 'layer');
  const tags = uniq([...splitTags(rawTags), ...extraTags]);
  const comment = str(pick(props, 'comment', 'description', 'desc', 'note', 'notes', 'commentaire'));
  const status = parseStatus(pick(props, 'status', 'statut', 'state'));
  const createdAt = parseDate(pick(props, 'created', 'created_at', 'createdAt', 'date', 'added', 'timestamp', 'time'));
  const address = str(pick(props, 'address', 'adresse', 'addr', 'formatted_address'));
  const osm = osmIdFrom(props, f.id);
  const id = str(pick(props, 'id', 'uuid')) ?? (typeof f.id === 'string' || typeof f.id === 'number' ? String(f.id) : undefined);
  return {
    key,
    name,
    ...(lat !== undefined && { lat, lon: lon! }),
    ...(located.shape && { shape: located.shape }),
    ...(address && { address }),
    tags,
    ...(comment && { comment: stripHtml(comment) }),
    ...(status && { status }),
    ...(url && { url }),
    ids: { ...(osm && { osm }), ...(id && !osm && { sourceId: id }), ...(url ? parseGoogleMapsUrl(url).ids : {}) },
    ...(createdAt && { createdAt }),
  };
}

function umapLayers(json: unknown): { name: string; color?: string; features: Feature[] }[] | null {
  const o = asObject(json);
  if (!o) return null;
  if (o.type === 'umap' && Array.isArray(o.layers)) {
    return (o.layers as unknown[]).map((l, i) => {
      const lo = asObject(l) ?? {};
      const opts = asObject(lo._umap_options) ?? {};
      const color = normalizeColor(opts.color);
      return { name: str(opts.name) ?? `Layer ${i + 1}`, ...(color && { color }), features: features(lo) };
    });
  }
  return null;
}

export function parseGenericGeoJson(json: unknown, opts: GenericGeoJsonOptions = {}): ParseResult {
  const warnings: ParseWarning[] = [];
  const places: ImportedPlace[] = [];
  const tags = new Map<string, SourceTag>();
  const addTag = (name: string, color?: string) => {
    if (!tags.has(name)) tags.set(name, { key: name, name, ...(color && { color }) });
  };
  const layers = umapLayers(json) ?? [{ name: '', features: features(json) }];
  let i = 0;
  for (const layer of layers) {
    const extra = [...(layer.name ? [layer.name] : []), ...(opts.fileTag ? [opts.fileTag] : [])];
    if (layer.name) addTag(layer.name, layer.color);
    for (const f of layer.features) {
      const p = genericFeature(f, `f${i++}`, extra, warnings);
      if (!p) continue;
      // simplestyle / uMap per-feature color on the first tag.
      const props = asObject(f.properties) ?? {};
      const color = normalizeColor(pick(props, 'marker-color', 'color', 'colour')) ?? normalizeColor(asObject(props._umap_options)?.color);
      for (const t of p.tags) addTag(t, p.tags[0] === t ? color : undefined);
      places.push(p);
    }
  }
  if (places.length === 0) warnings.push({ code: 'empty' });
  return { format: 'geojson', places, tags: [...tags.values()], warnings };
}
