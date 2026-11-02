/**
 * Small planar helpers for zones (pure, unit-tested).
 *
 * Shapes are built in a local metric plane (equirectangular projection around
 * an origin), which is accurate to well under 1 % over a few kilometres, the
 * size of a drawn zone or a street. Screen <-> map conversion uses Web
 * Mercator, the projection of both map engines (north-up map).
 */
import type { LatLon } from '../components/map/types';

export type XY = [x: number, y: number];

const R = 6_371_008.8;
const RAD = Math.PI / 180;

export interface LocalFrame {
  origin: LatLon;
  toXY(p: LatLon): XY;
  toLatLon(p: XY): LatLon;
}

/** Local metric frame (metres, x east, y north) centred on `origin`. */
export function localFrame(origin: LatLon): LocalFrame {
  const k = Math.cos(origin.lat * RAD);
  return {
    origin,
    toXY: (p) => [(p.lon - origin.lon) * RAD * R * k, (p.lat - origin.lat) * RAD * R],
    toLatLon: ([x, y]) => ({ lat: origin.lat + y / (R * RAD), lon: origin.lon + x / (R * RAD * k) }),
  };
}

export function centroidOf(points: readonly LatLon[]): LatLon {
  if (points.length === 0) return { lat: 0, lon: 0 };
  let lat = 0;
  let lon = 0;
  for (const p of points) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / points.length, lon: lon / points.length };
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Closest point of segment ab to p, with its parameter t in [0, 1]. */
export function closestOnSegment(p: XY, a: XY, b: XY): { point: XY; t: number; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point: XY = [a[0] + t * dx, a[1] + t * dy];
  return { point, t, d: dist(p, point) };
}

/** Signed area of a ring (positive = counter-clockwise). The ring may or may not repeat its first point. */
export function signedArea(ring: readonly XY[]): number {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function pointInRing(p: XY, ring: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function orient(a: XY, b: XY, c: XY): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Proper crossing of segments ab and cd (shared endpoints and touching do not count). */
export function segmentsCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** Whether a closed ring (first point not repeated) crosses itself. */
export function ringSelfIntersects(ring: readonly XY[]): boolean {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
      if (segmentsCross(a, b, ring[j]!, ring[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ screen <-> map

/** Visible area of a north-up map and its size on screen. */
export interface Viewport {
  /** [west, south, east, north]. */
  bbox: readonly [number, number, number, number];
  width: number;
  height: number;
}

function mercY(lat: number): number {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * RAD);
  return Math.log((1 + s) / (1 - s)) / 2;
}

function invMercY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;
}

/** Screen point (px from the top-left of the map) to coordinates. */
export function screenToLatLon(v: Viewport, x: number, y: number): LatLon {
  const [w, s, e, n] = v.bbox;
  const east = e < w ? e + 360 : e;
  let lon = w + (x / v.width) * (east - w);
  if (lon > 180) lon -= 360;
  const top = mercY(n);
  const bottom = mercY(s);
  const lat = invMercY(top - (y / v.height) * (top - bottom));
  return { lat, lon };
}

/** Coordinates to a screen point (px from the top-left of the map). */
export function latLonToScreen(v: Viewport, p: LatLon): { x: number; y: number } {
  const [w, s, e, n] = v.bbox;
  const east = e < w ? e + 360 : e;
  let lon = p.lon;
  if (lon < w) lon += 360;
  const top = mercY(n);
  const bottom = mercY(s);
  return { x: ((lon - w) / (east - w)) * v.width, y: ((top - mercY(p.lat)) / (top - bottom)) * v.height };
}

/** Metres per screen pixel at the centre of a viewport. */
export function metresPerPixel(v: Viewport): number {
  const [w, s, e, n] = v.bbox;
  const lat = (s + n) / 2;
  const east = e < w ? e + 360 : e;
  return ((east - w) * RAD * R * Math.cos(lat * RAD)) / v.width;
}

export function roundCoord(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
