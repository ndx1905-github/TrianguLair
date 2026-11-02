/**
 * Line and ring simplification (pure, unit-tested): Douglas–Peucker to drop
 * points, Chaikin to round the corners of a painted zone. Shapes are
 * simplified before they are saved (spec "Zones": only the final shape is
 * stored), so a zone stays a few dozen points.
 */
import type { MultiPolygon, Polygon, Position } from 'geojson';

import { closestOnSegment, roundCoord, signedArea, type LocalFrame, type XY } from './geo';

/** Douglas–Peucker on an open polyline; the end points are kept. */
export function simplifyLine(points: readonly XY[], tolerance: number): XY[] {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let best = -1;
    let bestD = tolerance;
    for (let k = i + 1; k < j; k++) {
      const d = closestOnSegment(points[k]!, points[i]!, points[j]!).d;
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  return points.filter((_, k) => keep[k] === 1);
}

/** Removes consecutive duplicates (within `eps`) and a repeated closing point. */
export function dedupeRing(ring: readonly XY[], eps = 1e-9): XY[] {
  const out: XY[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > eps || Math.abs(last[1] - p[1]) > eps) out.push(p);
  }
  while (out.length > 1) {
    const a = out[0]!;
    const b = out[out.length - 1]!;
    if (Math.abs(a[0] - b[0]) > eps || Math.abs(a[1] - b[1]) > eps) break;
    out.pop();
  }
  return out;
}

/**
 * Douglas–Peucker on a closed ring (first point not repeated). The ring is
 * split at its two farthest-apart points so the result does not depend on
 * where it starts. Returns at least a triangle, or [] when the ring collapses.
 */
export function simplifyRing(ring: readonly XY[], tolerance: number): XY[] {
  const r = dedupeRing(ring);
  if (r.length < 3) return [];
  if (r.length <= 4 || tolerance <= 0) return r;
  // Anchor: point farthest from the first, then split there.
  let far = 0;
  let farD = -1;
  for (let i = 1; i < r.length; i++) {
    const d = Math.hypot(r[i]![0] - r[0]![0], r[i]![1] - r[0]![1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplifyLine(r.slice(0, far + 1), tolerance);
  const b = simplifyLine([...r.slice(far), r[0]!], tolerance);
  const out = [...a, ...b.slice(1, -1)];
  // The two anchors themselves may be superfluous (e.g. the start in the middle of an edge).
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const prev = out[(i - 1 + out.length) % out.length]!;
      const next = out[(i + 1) % out.length]!;
      if (closestOnSegment(out[i]!, prev, next).d <= tolerance) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out.length >= 3 ? out : [];
}

/** Chaikin corner cutting on a closed ring (each pass doubles the points and rounds corners). */
export function chaikinRing(ring: readonly XY[], passes = 2): XY[] {
  let r = ring.slice();
  for (let k = 0; k < passes; k++) {
    const next: XY[] = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    r = next;
  }
  return r;
}

/** Ring with the wanted orientation (RFC 7946: exterior counter-clockwise, holes clockwise). */
export function orientRing(ring: readonly XY[], ccw: boolean): XY[] {
  const isCcw = signedArea(ring) > 0;
  return isCcw === ccw ? ring.slice() : ring.slice().reverse();
}

/** A polygon in the local plane: exterior ring then holes (none closed). */
export type PlanarPolygon = XY[][];

/** GeoJSON positions of a ring: closed, coordinates rounded to 1e-6 degree (~10 cm). */
export function ringToPositions(ring: readonly XY[], frame: LocalFrame): Position[] {
  const out: Position[] = ring.map((p) => {
    const ll = frame.toLatLon(p);
    return [roundCoord(ll.lon), roundCoord(ll.lat)];
  });
  // Rounding may create duplicates.
  const clean = out.filter((p, i) => i === 0 || p[0] !== out[i - 1]![0] || p[1] !== out[i - 1]![1]);
  if (clean.length && (clean[0]![0] !== clean[clean.length - 1]![0] || clean[0]![1] !== clean[clean.length - 1]![1])) {
    clean.push([clean[0]![0]!, clean[0]![1]!]);
  }
  return clean;
}

/** Valid GeoJSON Polygon / MultiPolygon from planar polygons (null if nothing is left). */
export function toAreaGeometry(polys: readonly PlanarPolygon[], frame: LocalFrame): Polygon | MultiPolygon | null {
  const out: Position[][][] = [];
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (!outer || outer.length < 3) continue;
    const ext = ringToPositions(orientRing(outer, true), frame);
    if (ext.length < 4) continue;
    const rings = [ext];
    for (const h of holes) {
      if (h.length < 3) continue;
      const pos = ringToPositions(orientRing(h, false), frame);
      if (pos.length >= 4) rings.push(pos);
    }
    out.push(rings);
  }
  if (out.length === 0) return null;
  if (out.length === 1) return { type: 'Polygon', coordinates: out[0]! };
  return { type: 'MultiPolygon', coordinates: out };
}

/** Number of positions of an area geometry. */
export function countPositions(g: Polygon | MultiPolygon): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);
}
