/**
 * Freehand zone by points (spec "Zones"): place the vertices one by one, tap
 * the first point to close, then move or add points. Pure state functions,
 * unit-tested; the screen keeps the state and converts taps to coordinates.
 */
import type { Polygon } from 'geojson';

import type { LatLon } from '../components/map/types';
import { centroidOf, closestOnSegment, localFrame, ringSelfIntersects, signedArea } from './geo';
import { dedupeRing, simplifyRing, toAreaGeometry } from './simplify';

export interface PointsDraft {
  points: LatLon[];
  closed: boolean;
  /** Vertex picked to be moved by the next tap (closed shapes). */
  selected: number | null;
}

export const EMPTY_POINTS: PointsDraft = { points: [], closed: false, selected: null };

/**
 * One tap at `at`. `hitM`: how close (metres) a tap must be to a vertex or an
 * edge to touch it (the screen passes about 22 px converted to metres).
 */
export function tapPoints(d: PointsDraft, at: LatLon, hitM: number): PointsDraft {
  const frame = localFrame(at);
  const p = frame.toXY(at);
  const near = (q: LatLon) => Math.hypot(...(frame.toXY(q) as [number, number])) <= hitM;
  if (!d.closed) {
    // Tap on the first point closes the shape (needs a triangle).
    if (d.points.length >= 3 && near(d.points[0]!)) return { ...d, closed: true, selected: null };
    // Tap on the last point again: ignored (double tap).
    if (d.points.length > 0 && near(d.points[d.points.length - 1]!)) return d;
    return { ...d, points: [...d.points, at] };
  }
  // Closed: a selected vertex moves to the tap.
  if (d.selected !== null) {
    const points = d.points.slice();
    points[d.selected] = at;
    return { ...d, points, selected: null };
  }
  // Tap on a vertex selects it.
  const vi = d.points.findIndex(near);
  if (vi >= 0) return { ...d, selected: vi };
  // Tap on an edge inserts a vertex there.
  let best = -1;
  let bestD = hitM;
  for (let i = 0; i < d.points.length; i++) {
    const a = frame.toXY(d.points[i]!);
    const b = frame.toXY(d.points[(i + 1) % d.points.length]!);
    const hit = closestOnSegment(p, a, b);
    if (hit.d <= bestD) {
      bestD = hit.d;
      best = i;
    }
  }
  if (best >= 0) {
    const points = d.points.slice();
    points.splice(best + 1, 0, at);
    return { ...d, points };
  }
  return d;
}

/** Removes the selected vertex, or the last one while drawing. */
export function undoPoint(d: PointsDraft): PointsDraft {
  if (d.closed && d.selected !== null) {
    if (d.points.length <= 3) return d;
    return { ...d, points: d.points.filter((_, i) => i !== d.selected), selected: null };
  }
  if (d.closed) return { ...d, closed: false, selected: null };
  return { ...d, points: d.points.slice(0, -1) };
}

/** Moves vertex `i` (drag). */
export function movePoint(d: PointsDraft, i: number, to: LatLon): PointsDraft {
  if (i < 0 || i >= d.points.length) return d;
  const points = d.points.slice();
  points[i] = to;
  return { ...d, points };
}

export type PointsProblem = 'tooFew' | 'notClosed' | 'selfIntersecting' | 'tooSmall';

/** Why the shape cannot be saved yet, or null when it can. */
export function pointsProblem(d: PointsDraft): PointsProblem | null {
  if (d.points.length < 3) return 'tooFew';
  if (!d.closed) return 'notClosed';
  const frame = localFrame(centroidOf(d.points));
  const ring = dedupeRing(d.points.map(frame.toXY), 0.01);
  if (ring.length < 3) return 'tooFew';
  if (ringSelfIntersects(ring)) return 'selfIntersecting';
  if (Math.abs(signedArea(ring)) < 25) return 'tooSmall'; // < 25 m²
  return null;
}

/**
 * The polygon to save: duplicate and nearly collinear points dropped
 * (Douglas–Peucker, 0.5 m), exterior counter-clockwise, closed, coordinates
 * rounded. Null when the shape is not valid.
 */
export function pointsToPolygon(d: PointsDraft): Polygon | null {
  if (pointsProblem(d) !== null) return null;
  const frame = localFrame(centroidOf(d.points));
  const ring = simplifyRing(d.points.map(frame.toXY), 0.5);
  if (ring.length < 3) return null;
  const g = toAreaGeometry([[ring]], frame);
  return g && g.type === 'Polygon' ? g : null;
}
