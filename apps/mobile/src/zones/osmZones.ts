/**
 * OSM sources of zones, through the app's single OSM client (shared rate
 * limits, cache and fixture mode):
 *
 * - neighbourhoods in the visible area: Overpass, `place=neighbourhood |
 *   quarter | suburb` ways and relations with their geometry (spec "Existing
 *   neighborhood"); relations are assembled from their outer/inner ways;
 * - named streets in the visible area: Overpass, `highway=*` ways with names,
 *   their node ids (intersections) and geometry;
 * - areas by name (neighbourhood, city, region, country): Nominatim with a
 *   server-side simplified polygon (`polygon_threshold`), simplified again
 *   here so even a country stays light (spec "Zones, by name").
 *
 * Parsing and query building are pure and unit-tested.
 */
import type { MultiPolygon, Polygon, Position } from 'geojson';
import type { OsmClient, OsmType } from '@triangulair/osm';

import type { LatLon } from '../components/map/types';
import { centroidOf, localFrame, type XY } from './geo';
import { nestRings } from './raster';
import { countPositions, simplifyRing, toAreaGeometry, type PlanarPolygon } from './simplify';
import type { StreetWay } from './streets';

export type BBoxTuple = readonly [west: number, south: number, east: number, north: number];

export interface OsmArea {
  osmType: OsmType;
  osmId: number;
  name: string;
  /** `place=quarter`, `boundary=administrative`… */
  category: string | null;
  /** Human description (Nominatim display name, or the place kind). */
  description?: string;
  geometry: Polygon | MultiPolygon;
}

/** Marker comments, so fixture mode (and logs) can tell zone queries apart. */
export const NEIGHBOURHOOD_MARK = '/* tl:neighbourhoods */';
export const STREETS_MARK = '/* tl:streets */';

const PLACE_RE = '^(neighbourhood|quarter|suburb)$';
const HIGHWAY_RE =
  '^(primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|service|footway|cycleway|path|steps|track|primary_link|secondary_link|tertiary_link)$';

function bb(b: BBoxTuple): string {
  const [w, s, e, n] = b;
  return [s, w, n, e].map((x) => x.toFixed(6)).join(',');
}

export function neighbourhoodQuery(b: BBoxTuple, timeoutSec = 25): string {
  return [
    `${NEIGHBOURHOOD_MARK}[out:json][timeout:${timeoutSec}];`,
    `(way["place"~"${PLACE_RE}"]["name"](${bb(b)});relation["place"~"${PLACE_RE}"]["name"](${bb(b)}););`,
    'out tags geom;',
  ].join('\n');
}

export function streetsQuery(b: BBoxTuple, timeoutSec = 25): string {
  return [`${STREETS_MARK}[out:json][timeout:${timeoutSec}];`, `way["highway"~"${HIGHWAY_RE}"]["name"](${bb(b)});`, 'out body geom;'].join(
    '\n',
  );
}

// ------------------------------------------------------------------ Overpass answers

interface GeomPoint {
  lat: number;
  lon: number;
}

export interface OverpassGeomElement {
  type: OsmType;
  id: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: (GeomPoint | null)[];
  members?: { type: OsmType; ref: number; role: string; geometry?: (GeomPoint | null)[] }[];
}

const key = (p: GeomPoint) => `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`;

/**
 * Joins open ways end to end into closed rings (multipolygon members are
 * often split in several ways, in any direction). Unclosable pieces are dropped.
 */
export function assembleRings(parts: readonly GeomPoint[][]): GeomPoint[][] {
  const rings: GeomPoint[][] = [];
  const open = parts.filter((p) => p.length >= 2).map((p) => p.slice());
  while (open.length) {
    let cur = open.shift()!;
    for (let guard = 0; guard < 10_000; guard++) {
      if (cur.length >= 4 && key(cur[0]!) === key(cur[cur.length - 1]!)) break;
      const end = key(cur[cur.length - 1]!);
      const i = open.findIndex((p) => key(p[0]!) === end || key(p[p.length - 1]!) === end);
      if (i < 0) break;
      const next = open.splice(i, 1)[0]!;
      cur = cur.concat((key(next[0]!) === end ? next : next.slice().reverse()).slice(1));
    }
    if (cur.length >= 4 && key(cur[0]!) === key(cur[cur.length - 1]!)) rings.push(cur);
  }
  return rings;
}

function areaFromRings(outer: GeomPoint[][], inner: GeomPoint[][], tolM: number): Polygon | MultiPolygon | null {
  const all = [...outer, ...inner].flat();
  if (all.length === 0) return null;
  const frame = localFrame(centroidOf(all));
  const toRing = (r: GeomPoint[]): XY[] => r.slice(0, -1).map(frame.toXY);
  // Orientation decides exterior vs hole in nestRings; force it from the member roles.
  const orient = (r: XY[], ccw: boolean) => {
    let s = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      s += a[0] * b[1] - b[0] * a[1];
    }
    return (s > 0) === ccw ? r : r.slice().reverse();
  };
  const rings = [
    ...outer.map((r) => orient(simplifyRing(toRing(r), tolM), true)),
    ...inner.map((r) => orient(simplifyRing(toRing(r), tolM), false)),
  ].filter((r) => r.length >= 3);
  const polys: PlanarPolygon[] = nestRings(rings);
  return toAreaGeometry(polys, frame);
}

/** Neighbourhood areas from an Overpass `out tags geom` answer. */
export function parseNeighbourhoods(elements: readonly OverpassGeomElement[], tolM = 2): OsmArea[] {
  const out: OsmArea[] = [];
  for (const el of elements) {
    const name = el.tags?.name;
    if (!name) continue;
    const pts = (g?: (GeomPoint | null)[]) => (g ?? []).filter((p): p is GeomPoint => !!p);
    let geometry: Polygon | MultiPolygon | null = null;
    if (el.type === 'way') {
      const rings = assembleRings([pts(el.geometry)]);
      geometry = areaFromRings(rings, [], tolM);
    } else if (el.type === 'relation') {
      const members = (el.members ?? []).filter((m) => m.type === 'way');
      const outer = assembleRings(members.filter((m) => m.role !== 'inner').map((m) => pts(m.geometry)));
      const inner = assembleRings(members.filter((m) => m.role === 'inner').map((m) => pts(m.geometry)));
      geometry = areaFromRings(outer, inner, tolM);
    }
    if (!geometry) continue;
    const place = el.tags?.place;
    out.push({
      osmType: el.type,
      osmId: el.id,
      name,
      category: place ? `place=${place}` : el.tags?.boundary ? `boundary=${el.tags.boundary}` : null,
      geometry,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Named streets from an Overpass `out body geom` answer. */
export function parseStreets(elements: readonly OverpassGeomElement[]): StreetWay[] {
  const out: StreetWay[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags?.name || !el.nodes || !el.geometry) continue;
    if (el.nodes.length !== el.geometry.length || el.geometry.some((p) => !p)) continue;
    out.push({
      id: el.id,
      name: el.tags.name,
      nodes: el.nodes,
      geometry: (el.geometry as GeomPoint[]).map((p) => ({ lat: p.lat, lon: p.lon })),
    });
  }
  return out;
}

// ------------------------------------------------------------------ Nominatim

export interface NominatimArea {
  osm_type?: string;
  osm_id?: number;
  name?: string;
  display_name?: string;
  category?: string;
  class?: string;
  type?: string;
  boundingbox?: string[];
  geojson?: { type: string; coordinates: unknown };
}

const OSM_TYPES: Record<string, OsmType> = { node: 'node', way: 'way', relation: 'relation', N: 'node', W: 'way', R: 'relation' };

/**
 * Simplifies an area so that it stays under about `maxPositions` points: the
 * tolerance grows with the size of the shape (a country keeps its outline at
 * the scale it is seen at, a neighbourhood keeps its streets).
 */
export function lightenArea(g: Polygon | MultiPolygon, maxPositions = 1500): Polygon | MultiPolygon | null {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const all = polys.flat(2).map(([lon, lat]) => ({ lat: lat as number, lon: lon as number }));
  if (all.length === 0) return null;
  const frame = localFrame(centroidOf(all));
  const xy = (r: Position[]) => r.slice(0, -1).map(([lon, lat]) => frame.toXY({ lat: lat as number, lon: lon as number }));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of all) {
    const [x, y] = frame.toXY(p);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const size = Math.max(maxX - minX, maxY - minY);
  let tol = Math.max(1, size / 4000);
  let result: Polygon | MultiPolygon | null = g;
  for (let pass = 0; pass < 8; pass++) {
    const planar: PlanarPolygon[] = polys
      .map((p) => p.map((r) => simplifyRing(xy(r), tol)).filter((r, i) => i > 0 || r.length >= 3))
      .filter((p) => p.length > 0 && p[0]!.length >= 3)
      // Drop specks (islets) smaller than the tolerance squared.
      .filter((p) => {
        let s = 0;
        const r = p[0]!;
        for (let i = 0; i < r.length; i++) s += r[i]![0] * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * r[i]![1];
        return Math.abs(s / 2) > tol * tol * 4;
      });
    result = toAreaGeometry(planar, frame);
    if (!result || countPositions(result) <= maxPositions) break;
    tol *= 2;
  }
  return result;
}

export function parseNominatimAreas(list: readonly NominatimArea[]): OsmArea[] {
  const out: OsmArea[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const type = OSM_TYPES[r.osm_type ?? ''];
    const g = r.geojson;
    if (!type || !r.osm_id || !g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    const k = `${type}/${r.osm_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const light = lightenArea(g as Polygon | MultiPolygon);
    if (!light) continue;
    const cls = r.category ?? r.class;
    out.push({
      osmType: type,
      osmId: r.osm_id,
      name: r.name || r.display_name?.split(',')[0] || k,
      category: cls && r.type ? `${cls}=${r.type}` : null,
      ...(r.display_name ? { description: r.display_name } : {}),
      geometry: light,
    });
  }
  return out;
}

export function nominatimAreaUrl(baseUrl: string, q: string, lang?: string): string {
  const p = new URLSearchParams({
    q: q.trim(),
    format: 'jsonv2',
    polygon_geojson: '1',
    // Server-side simplification (degrees): ~10 m, light enough for a neighbourhood.
    polygon_threshold: '0.0001',
    limit: '8',
  });
  if (lang) p.set('accept-language', lang);
  return `${baseUrl}/search?${p}`;
}

// ------------------------------------------------------------------ client calls

export async function fetchNeighbourhoods(osm: OsmClient, b: BBoxTuple, signal?: AbortSignal): Promise<OsmArea[]> {
  const r = await osm.overpass.query(neighbourhoodQuery(b), signal ? { signal } : {});
  return parseNeighbourhoods(r.elements as unknown as OverpassGeomElement[]);
}

export async function fetchStreets(osm: OsmClient, b: BBoxTuple, signal?: AbortSignal): Promise<StreetWay[]> {
  const r = await osm.overpass.query(streetsQuery(b), signal ? { signal } : {});
  return parseStreets(r.elements as unknown as OverpassGeomElement[]);
}

/** Areas by name. Nominatim's policy forbids search-as-you-type: call this on submit only. */
export async function searchAreas(osm: OsmClient, q: string, lang?: string, signal?: AbortSignal): Promise<OsmArea[]> {
  if (!q.trim()) return [];
  const list = await osm.http.getJson<NominatimArea[]>(
    { service: 'nominatim', url: nominatimAreaUrl(osm.endpoints.nominatim, q, lang), ttlMs: 7 * 24 * 3600_000 },
    signal ? { signal } : {},
  );
  return parseNominatimAreas(Array.isArray(list) ? list : []);
}

/** Largest dimension of a bbox, metres (to refuse queries over too large an area). */
export function bboxSizeM(b: BBoxTuple): number {
  const [w, s, e, n] = b;
  const f = localFrame({ lat: (s + n) / 2, lon: (w + e) / 2 });
  const [x0, y0] = f.toXY({ lat: s, lon: w });
  const [x1, y1] = f.toXY({ lat: n, lon: e });
  return Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
}

export type { LatLon };
