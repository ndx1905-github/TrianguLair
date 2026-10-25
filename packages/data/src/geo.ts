// SPDX-License-Identifier: MPL-2.0
/**
 * Small, dependency-free geometry helpers (planar on lon/lat, which is accurate
 * enough at the scale of a city or a filter zone; distances use haversine).
 */
import type { Position } from 'geojson';
import type { AreaGeometry, BBox, LatLon, PlaceGeometry } from './types.ts';

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A bbox around a point, `radiusM` meters in every direction. */
export function bboxAround(p: LatLon, radiusM: number): BBox {
  const dLat = radiusM / (EARTH_RADIUS_M * RAD);
  const cos = Math.max(Math.cos(p.lat * RAD), 1e-6);
  const dLon = Math.min(180, dLat / cos);
  return [wrapLon(p.lon - dLon), Math.max(-90, p.lat - dLat), wrapLon(p.lon + dLon), Math.min(90, p.lat + dLat)];
}

function wrapLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Splits a bbox crossing the antimeridian (west > east) into two. */
export function splitBBox(b: BBox): BBox[] {
  const [w, s, e, n] = b;
  if (w <= e) return [b];
  return [
    [w, s, 180, n],
    [-180, s, e, n],
  ];
}

function positions(g: PlaceGeometry): Position[] {
  switch (g.type) {
    case 'Point':
      return [g.coordinates];
    case 'LineString':
      return g.coordinates;
    case 'MultiLineString':
    case 'Polygon':
      return g.coordinates.flat();
    case 'MultiPolygon':
      return g.coordinates.flat(2);
  }
}

export function geometryBBox(g: PlaceGeometry): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of positions(g) as [number, number][]) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/** Throws on a geometry that cannot be stored (wrong shape, out-of-range or non-finite coordinates). */
export function assertValidGeometry(g: PlaceGeometry): void {
  const ok = (p: Position) =>
    Array.isArray(p) &&
    p.length >= 2 &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    (p[0] as number) >= -180 &&
    (p[0] as number) <= 180 &&
    (p[1] as number) >= -90 &&
    (p[1] as number) <= 90;
  const types = ['Point', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];
  if (!g || !types.includes(g.type)) throw new TypeError('unsupported geometry type');
  const ps = positions(g);
  if (ps.length === 0 || !ps.every(ok)) throw new TypeError('invalid geometry coordinates');
  if (g.type === 'LineString' && g.coordinates.length < 2) throw new TypeError('a line needs 2 points');
  const rings = g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
  for (const r of rings) if (r.length < 4) throw new TypeError('a polygon ring needs 4 positions');
}

/** Ray casting on one ring (closed or not). */
function inRing(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygonRings(lon: number, lat: number, rings: Position[][]): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !inRing(lon, lat, outer)) return false;
  return !holes.some((h) => inRing(lon, lat, h));
}

export function pointInArea(p: LatLon, area: AreaGeometry): boolean {
  if (area.type === 'Polygon') return inPolygonRings(p.lon, p.lat, area.coordinates);
  return area.coordinates.some((poly) => inPolygonRings(p.lon, p.lat, poly));
}

function segments(g: PlaceGeometry): [Position, Position][] {
  const lines: Position[][] =
    g.type === 'Point'
      ? []
      : g.type === 'LineString'
        ? [g.coordinates]
        : g.type === 'MultiLineString' || g.type === 'Polygon'
          ? g.coordinates
          : g.coordinates.flat();
  const out: [Position, Position][] = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) out.push([l[i - 1]!, l[i]!]);
  return out;
}

function orient(a: Position, b: Position, c: Position): number {
  return ((b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!));
}

function segmentsCross(p1: Position, p2: Position, q1: Position, q2: Position): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Does a place geometry touch an area? Points: inside. Lines and polygons:
 * a vertex inside, the area inside the polygon, or crossing edges.
 */
export function geometryIntersectsArea(g: PlaceGeometry, area: AreaGeometry): boolean {
  if (g.type === 'Point') return pointInArea({ lon: g.coordinates[0]!, lat: g.coordinates[1]! }, area);
  if (!bboxIntersects(geometryBBox(g), geometryBBox(area))) return false;
  for (const [lon, lat] of positions(g) as [number, number][]) if (pointInArea({ lon, lat }, area)) return true;
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
    for (const [lon, lat] of positions(area) as [number, number][]) if (pointInArea({ lon, lat }, g)) return true;
  }
  const areaSegs = segments(area);
  for (const [a, b] of segments(g)) for (const [c, d] of areaSegs) if (segmentsCross(a, b, c, d)) return true;
  return false;
}

/**
 * Where to draw a badge: the point itself; the middle of the longest segment
 * of a line (spec "Zone icon"); for a polygon, a point inside the shape (the
 * middle of the widest horizontal chord through the bbox center), so an L or a
 * crescent still gets an interior point.
 */
export function representativePoint(g: PlaceGeometry): LatLon {
  if (g.type === 'Point') return { lon: g.coordinates[0]!, lat: g.coordinates[1]! };
  if (g.type === 'LineString' || g.type === 'MultiLineString') {
    let best: [Position, Position] | null = null;
    let bestLen = -1;
    for (const [a, b] of segments(g)) {
      const len = haversineM({ lon: a[0]!, lat: a[1]! }, { lon: b[0]!, lat: b[1]! });
      if (len > bestLen) {
        bestLen = len;
        best = [a, b];
      }
    }
    const [a, b] = best!;
    return { lon: (a[0]! + b[0]!) / 2, lat: (a[1]! + b[1]!) / 2 };
  }
  const [w, s, e, n] = geometryBBox(g);
  const center = { lon: (w + e) / 2, lat: (s + n) / 2 };
  if (pointInArea(center, g)) return center;
  // Try a few horizontal chords; keep the widest interior interval.
  let best: LatLon | null = null;
  let bestWidth = -1;
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  for (const t of [0.5, 0.25, 0.75, 0.375, 0.625, 0.125, 0.875]) {
    const lat = s + (n - s) * t;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i] as [number, number];
        const [xj, yj] = ring[j] as [number, number];
        if (yi > lat !== yj > lat) xs.push(((xj - xi) * (lat - yi)) / (yj - yi) + xi);
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i++) {
      const mid = { lon: (xs[i]! + xs[i + 1]!) / 2, lat };
      const width = xs[i + 1]! - xs[i]!;
      if (width > bestWidth && pointInArea(mid, g)) {
        bestWidth = width;
        best = mid;
      }
    }
    if (best) break;
  }
  if (best) return best;
  const first = positions(g)[0]!;
  return { lon: first[0]!, lat: first[1]! };
}
