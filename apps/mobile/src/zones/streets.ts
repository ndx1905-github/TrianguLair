/**
 * Street segments (spec "Zones"): tap a street, choose a start and an end;
 * the path follows the streets through intersections, cut between the two
 * points. Pure, unit-tested: a small graph built from OSM ways (shared node
 * ids are intersections), points snapped onto it, Dijkstra between them.
 */
import type { LineString, MultiLineString, Position } from 'geojson';

import type { LatLon } from '../components/map/types';
import { closestOnSegment, dist, localFrame, roundCoord, type LocalFrame, type XY } from './geo';
import { simplifyLine } from './simplify';

export interface StreetWay {
  id: number;
  name: string;
  /** OSM node ids, same length as `geometry`. */
  nodes: number[];
  geometry: LatLon[];
}

export interface Snap {
  wayId: number;
  /** Index of the segment [i, i+1] of the way. */
  seg: number;
  /** Position along that segment, 0..1. */
  t: number;
  point: LatLon;
  /** Distance from the tap, metres. */
  distanceM: number;
}

export class StreetNetwork {
  readonly frame: LocalFrame;
  readonly ways: Map<number, StreetWay>;
  private readonly xy = new Map<number, XY>();
  /** node -> neighbours with edge length. */
  private readonly adj = new Map<number, { to: number; w: number }[]>();

  constructor(ways: readonly StreetWay[]) {
    const first = ways.find((w) => w.geometry.length)?.geometry[0] ?? { lat: 0, lon: 0 };
    this.frame = localFrame(first);
    this.ways = new Map(ways.filter((w) => w.nodes.length >= 2 && w.nodes.length === w.geometry.length).map((w) => [w.id, w]));
    for (const w of this.ways.values()) {
      w.nodes.forEach((n, i) => {
        if (!this.xy.has(n)) this.xy.set(n, this.frame.toXY(w.geometry[i]!));
      });
      for (let i = 0; i + 1 < w.nodes.length; i++) this.link(w.nodes[i]!, w.nodes[i + 1]!);
    }
  }

  private link(a: number, b: number): void {
    const w = dist(this.xy.get(a)!, this.xy.get(b)!);
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = this.adj.get(x) ?? [];
      list.push({ to: y, w });
      this.adj.set(x, list);
    }
  }

  /** Nearest point on any street within `maxM` metres, or null. Optionally restricted to some ways. */
  snap(at: LatLon, maxM = Infinity, onlyWays?: ReadonlySet<number>): Snap | null {
    const p = this.frame.toXY(at);
    let best: Snap | null = null;
    for (const w of this.ways.values()) {
      if (onlyWays && !onlyWays.has(w.id)) continue;
      for (let i = 0; i + 1 < w.nodes.length; i++) {
        const a = this.xy.get(w.nodes[i]!)!;
        const b = this.xy.get(w.nodes[i + 1]!)!;
        const hit = closestOnSegment(p, a, b);
        if (hit.d <= maxM && (!best || hit.d < best.distanceM)) {
          best = { wayId: w.id, seg: i, t: hit.t, point: this.frame.toLatLon(hit.point), distanceM: hit.d };
        }
      }
    }
    return best;
  }

  /** Ways sharing the name of `wayId` (one street is often split in several OSM ways). */
  sameStreet(wayId: number): Set<number> {
    const name = this.ways.get(wayId)?.name;
    const out = new Set<number>();
    for (const w of this.ways.values()) if (w.id === wayId || (name && w.name === name)) out.add(w.id);
    return out;
  }

  /** Shortest path along the streets from one snapped point to another, as coordinates. */
  path(from: Snap, to: Snap): LatLon[] {
    const fw = this.ways.get(from.wayId);
    const tw = this.ways.get(to.wayId);
    if (!fw || !tw) return [];
    const fp = this.frame.toXY(from.point);
    const tp = this.frame.toXY(to.point);
    // Same segment: a straight cut.
    if (from.wayId === to.wayId && from.seg === to.seg) return [from.point, to.point];
    // Same way: walk along it (cheaper and exact), unless the graph gives a shorter way (loops).
    const START = -1;
    const END = -2;
    const extra = new Map<number, { to: number; w: number }[]>();
    const endpoints = (s: Snap, w: StreetWay, p: XY) => {
      const a = w.nodes[s.seg]!;
      const b = w.nodes[s.seg + 1]!;
      return [
        { node: a, w: dist(p, this.xy.get(a)!) },
        { node: b, w: dist(p, this.xy.get(b)!) },
      ];
    };
    extra.set(START, endpoints(from, fw, fp).map((e) => ({ to: e.node, w: e.w })));
    const endLinks = endpoints(to, tw, tp);
    const neighbours = (n: number) => {
      const base = n === START ? extra.get(START)! : (this.adj.get(n) ?? []);
      const toEnd = endLinks.filter((e) => e.node === n).map((e) => ({ to: END, w: e.w }));
      return toEnd.length ? [...base, ...toEnd] : base;
    };
    // Dijkstra (small graphs: a linear scan of the frontier is enough).
    const d = new Map<number, number>([[START, 0]]);
    const prev = new Map<number, number>();
    const done = new Set<number>();
    for (;;) {
      let u: number | null = null;
      let best = Infinity;
      for (const [n, v] of d) {
        if (!done.has(n) && v < best) {
          best = v;
          u = n;
        }
      }
      if (u === null || u === END) break;
      done.add(u);
      for (const { to: v, w } of neighbours(u)) {
        const nd = best + w;
        if (nd < (d.get(v) ?? Infinity)) {
          d.set(v, nd);
          prev.set(v, u);
        }
      }
    }
    if (!d.has(END)) return [];
    const nodes: number[] = [];
    for (let n = prev.get(END); n !== undefined && n !== START; n = prev.get(n)) nodes.unshift(n);
    return [from.point, ...nodes.map((n) => this.frame.toLatLon(this.xy.get(n)!)), to.point];
  }

  /** Coordinates of a whole way (to highlight the tapped street). */
  wayLine(wayId: number): LatLon[] {
    return this.ways.get(wayId)?.geometry ?? [];
  }
}

function samePoint(a: LatLon, b: LatLon, eps = 1e-6): boolean {
  return Math.abs(a.lat - b.lat) < eps && Math.abs(a.lon - b.lon) < eps;
}

/**
 * Segments to the zone geometry: one LineString, or a MultiLineString for
 * separate segments. A segment starting where the previous one ends is
 * chained into it (contiguous). Points within 0.3 m of the line are dropped.
 */
export function segmentsToGeometry(segments: readonly (readonly LatLon[])[]): LineString | MultiLineString | null {
  const lines: LatLon[][] = [];
  for (const s of segments) {
    if (s.length < 2) continue;
    const last = lines[lines.length - 1];
    if (last && samePoint(last[last.length - 1]!, s[0]!)) last.push(...s.slice(1));
    else lines.push([...s]);
  }
  const coords: Position[][] = [];
  for (const l of lines) {
    const frame = localFrame(l[0]!);
    const simple = simplifyLine(l.map(frame.toXY), 0.3).map(frame.toLatLon);
    const pos = simple
      .map((p): Position => [roundCoord(p.lon), roundCoord(p.lat)])
      .filter((p, i, all) => i === 0 || p[0] !== all[i - 1]![0] || p[1] !== all[i - 1]![1]);
    if (pos.length >= 2) coords.push(pos);
  }
  if (coords.length === 0) return null;
  if (coords.length === 1) return { type: 'LineString', coordinates: coords[0]! };
  return { type: 'MultiLineString', coordinates: coords };
}

/** Lines of a street zone geometry, as coordinates. */
export function linesOf(g: LineString | MultiLineString): LatLon[][] {
  const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
  return lines.map((l) => l.map(([lon, lat]) => ({ lat: lat!, lon: lon! })));
}

/** Length of lines in metres. */
export function linesLengthM(lines: readonly (readonly LatLon[])[]): number {
  let total = 0;
  for (const l of lines) {
    if (l.length < 2) continue;
    const f = localFrame(l[0]!);
    for (let i = 0; i + 1 < l.length; i++) total += dist(f.toXY(l[i]!), f.toXY(l[i + 1]!));
  }
  return total;
}
