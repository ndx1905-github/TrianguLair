/**
 * Strokes to an area (pure, unit-tested): used for finger painting (spec:
 * "each stroke is widened to its thickness, the strokes are merged, then the
 * shape is smoothed and simplified") and for buffering street segments into
 * a polygon (a street zone used as a list filter, "places on this street").
 *
 * Instead of a polygon union (fragile, and heavy as a dependency), strokes are
 * rasterized on a fine grid in metres: a cell is filled when its centre is
 * within the stroke radius of a stroke segment; eraser strokes clear cells.
 * The grid outline is then traced into rings (holes included, cells touching
 * only by a corner kept apart), simplified with Douglas–Peucker and, for a
 * painted zone, rounded with Chaikin. The result is a valid GeoJSON Polygon
 * or MultiPolygon (exterior counter-clockwise, holes clockwise).
 */
import type { MultiPolygon, Polygon } from 'geojson';

import type { LatLon } from '../components/map/types';
import { centroidOf, closestOnSegment, localFrame, pointInRing, signedArea, type LocalFrame, type XY } from './geo';
import { chaikinRing, simplifyRing, toAreaGeometry, type PlanarPolygon } from './simplify';

export interface Stroke {
  points: readonly LatLon[];
  /** Half the brush thickness, metres. */
  radiusM: number;
  /** Eraser stroke: clears instead of filling. */
  erase?: boolean;
}

export interface AreaOptions {
  /** Round the outline (painted zones). Default true. */
  smooth?: boolean;
  /** Upper bound on grid cells (speed / memory). Default 250 000. */
  maxCells?: number;
  /** Douglas–Peucker tolerance as a multiple of the cell size. Default 0.9. */
  simplifyCells?: number;
  /** Drop pieces smaller than this many cells. Default 6. */
  minCells?: number;
}

export interface Grid {
  cols: number;
  rows: number;
  cell: number;
  /** Lower-left corner of the grid in the local frame. */
  x0: number;
  y0: number;
  data: Uint8Array;
}

/** Rasterizes strokes (in the local frame) on a grid. */
export function rasterize(strokes: readonly { points: readonly XY[]; radius: number; erase?: boolean }[], maxCells = 250_000): Grid | null {
  const drawn = strokes.filter((s) => s.points.length > 0 && s.radius > 0);
  const fill = drawn.filter((s) => !s.erase);
  if (fill.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minR = Infinity;
  for (const s of fill) {
    minR = Math.min(minR, s.radius);
    for (const [x, y] of s.points) {
      minX = Math.min(minX, x - s.radius);
      minY = Math.min(minY, y - s.radius);
      maxX = Math.max(maxX, x + s.radius);
      maxY = Math.max(maxY, y + s.radius);
    }
  }
  const w = maxX - minX;
  const h = maxY - minY;
  // About 4 cells per brush radius, coarser if the area is large.
  const cell = Math.max(minR / 4, Math.sqrt((w * h) / maxCells), 0.05);
  const pad = 2;
  const cols = Math.ceil(w / cell) + pad * 2;
  const rows = Math.ceil(h / cell) + pad * 2;
  const x0 = minX - pad * cell;
  const y0 = minY - pad * cell;
  const data = new Uint8Array(cols * rows);
  for (const s of drawn) {
    const pts = s.points.length === 1 ? [s.points[0]!, s.points[0]!] : s.points;
    const value = s.erase ? 0 : 1;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      const c0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - s.radius - x0) / cell));
      const c1 = Math.min(cols - 1, Math.ceil((Math.max(a[0], b[0]) + s.radius - x0) / cell));
      const r0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - s.radius - y0) / cell));
      const r1 = Math.min(rows - 1, Math.ceil((Math.max(a[1], b[1]) + s.radius - y0) / cell));
      for (let r = r0; r <= r1; r++) {
        const cy = y0 + (r + 0.5) * cell;
        for (let c = c0; c <= c1; c++) {
          const idx = r * cols + c;
          if (data[idx] === value) continue;
          const cx = x0 + (c + 0.5) * cell;
          if (closestOnSegment([cx, cy], a, b).d <= s.radius) data[idx] = value;
        }
      }
    }
  }
  return { cols, rows, cell, x0, y0, data };
}

/**
 * Outline of the filled cells as rings in grid-corner coordinates, filled
 * side on the left: exteriors counter-clockwise, holes clockwise. At a corner
 * where two filled cells touch diagonally, the trace turns left, which keeps
 * them in separate rings (4-connectivity).
 */
export function traceRings(g: Grid): XY[][] {
  const { cols, rows, data } = g;
  const filled = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && data[r * cols + c] === 1;
  // Directed boundary edges, keyed by their start corner.
  const key = (x: number, y: number) => y * (cols + 1) + x;
  const out = new Map<number, [number, number][]>();
  let count = 0;
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    const k = key(x1, y1);
    const list = out.get(k) ?? [];
    list.push([x2, y2]);
    out.set(k, list);
    count++;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!filled(c, r)) continue;
      if (!filled(c, r - 1)) add(c, r, c + 1, r); // bottom, going east
      if (!filled(c + 1, r)) add(c + 1, r, c + 1, r + 1); // right, going north
      if (!filled(c, r + 1)) add(c + 1, r + 1, c, r + 1); // top, going west
      if (!filled(c - 1, r)) add(c, r + 1, c, r); // left, going south
    }
  }
  const rings: XY[][] = [];
  while (count > 0) {
    // Any remaining edge starts a ring.
    let startKey = -1;
    for (const [k, list] of out) {
      if (list.length) {
        startKey = k;
        break;
      }
    }
    if (startKey < 0) break;
    const sx = startKey % (cols + 1);
    const sy = Math.floor(startKey / (cols + 1));
    const ring: XY[] = [];
    let x = sx;
    let y = sy;
    let dx = 0;
    let dy = 0;
    const limit = count + 4;
    for (let guard = 0; guard <= limit; guard++) {
      const list = out.get(key(x, y));
      if (!list || list.length === 0) break;
      let pick = 0;
      if (list.length > 1) {
        // Prefer a left turn, then straight, then right.
        let best = -Infinity;
        list.forEach(([nx, ny], i) => {
          const ex = nx - x;
          const ey = ny - y;
          const cross = dx * ey - dy * ex;
          const dot = dx * ex + dy * ey;
          const score = cross > 0 ? 2 : dot > 0 ? 1 : 0;
          if (score > best) {
            best = score;
            pick = i;
          }
        });
      }
      const [nx, ny] = list.splice(pick, 1)[0]!;
      count--;
      const ndx = nx - x;
      const ndy = ny - y;
      // Keep only corners (direction changes).
      if (ndx !== dx || ndy !== dy || ring.length === 0) ring.push([x, y]);
      dx = ndx;
      dy = ndy;
      x = nx;
      y = ny;
      if (x === sx && y === sy) break;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Groups rings into polygons: each hole goes to the smallest exterior containing it. */
export function nestRings(rings: readonly XY[][]): PlanarPolygon[] {
  const outers = rings.filter((r) => signedArea(r) > 0).map((r) => ({ ring: r, area: signedArea(r), holes: [] as XY[][] }));
  for (const h of rings.filter((r) => signedArea(r) < 0)) {
    const probe = h[0]!;
    const host = outers
      .filter((o) => pointInRing(probe, o.ring))
      .sort((a, b) => a.area - b.area)[0];
    host?.holes.push(h);
  }
  return outers.map((o) => [o.ring, ...o.holes]);
}

function gridToFrame(g: Grid, ring: readonly XY[]): XY[] {
  return ring.map(([x, y]) => [g.x0 + x * g.cell, g.y0 + y * g.cell]);
}

/** Area covered by strokes in a local frame, as planar polygons (simplified, optionally smoothed). */
export function strokesToPlanar(
  strokes: readonly { points: readonly XY[]; radius: number; erase?: boolean }[],
  opts: AreaOptions = {},
): { polygons: PlanarPolygon[]; cell: number } | null {
  const grid = rasterize(strokes, opts.maxCells);
  if (!grid) return null;
  const minArea = (opts.minCells ?? 6) * grid.cell * grid.cell;
  const tol = (opts.simplifyCells ?? 0.9) * grid.cell;
  const smooth = opts.smooth ?? true;
  const polygons: PlanarPolygon[] = [];
  for (const poly of nestRings(traceRings(grid))) {
    const rings: XY[][] = [];
    for (const [i, raw] of poly.entries()) {
      const metric = gridToFrame(grid, raw);
      if (Math.abs(signedArea(metric)) < minArea) {
        if (i === 0) break;
        continue;
      }
      let r = simplifyRing(metric, tol);
      if (smooth && r.length >= 3) r = simplifyRing(chaikinRing(r, 2), tol * 0.25);
      if (r.length < 3) {
        if (i === 0) break;
        continue;
      }
      rings.push(r);
    }
    if (rings.length) polygons.push(rings);
  }
  return { polygons, cell: grid.cell };
}

/** Painted zone (or buffered lines) as GeoJSON, from strokes in coordinates. */
export function strokesToArea(strokes: readonly Stroke[], opts: AreaOptions = {}): Polygon | MultiPolygon | null {
  const all = strokes.flatMap((s) => s.points);
  if (all.length === 0) return null;
  const frame: LocalFrame = localFrame(centroidOf(all));
  const planar = strokesToPlanar(
    strokes.map((s) => ({ points: s.points.map(frame.toXY), radius: s.radiusM, ...(s.erase ? { erase: true } : {}) })),
    opts,
  );
  if (!planar) return null;
  return toAreaGeometry(planar.polygons, frame);
}

/** Polygon around lines (street segments), `radiusM` on each side; sharp, not smoothed. */
export function bufferLines(lines: readonly (readonly LatLon[])[], radiusM: number): Polygon | MultiPolygon | null {
  return strokesToArea(
    lines.filter((l) => l.length > 0).map((points) => ({ points, radiusM })),
    { smooth: false, simplifyCells: 0.6 },
  );
}
