/**
 * Pin clustering (T-103, basic version). Pure logic, unit-tested.
 *
 * Radius clustering in Web Mercator pixels at the current zoom (512 px tiles,
 * as MapLibre): points closer than `radiusPx` on screen are grouped.
 * Above `maxClusterZoom` every pin is shown on its own. A cluster is drawn in
 * the color of its majority tag among the places matching the filter
 * (spec "Clustering"), grey when none matches.
 */
export interface ClusterInput {
  id: string;
  lat: number;
  lon: number;
  /** Color of the place's pin (main or filtered tag); null for greyed pins. */
  color: string | null;
}

export interface Cluster {
  id: string;
  lat: number;
  lon: number;
  count: number;
  /** Majority color among matching members, null when none matches. */
  color: string | null;
  memberIds: string[];
  /** [west, south, east, north] of the members. */
  bbox: [number, number, number, number];
}

export interface ClusterResult<T extends ClusterInput> {
  singles: T[];
  clusters: Cluster[];
}

export interface ClusterOptions {
  zoom: number;
  /** Grouping distance in screen pixels. Default 56. */
  radiusPx?: number;
  /** No clustering at or above this zoom. Default 15. */
  maxClusterZoom?: number;
  /** Smallest group drawn as a cluster. Default 2. */
  minPoints?: number;
}

const TILE = 512;

export function project(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const scale = TILE * 2 ** zoom;
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

export function majorityColor(colors: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>();
  let best: string | null = null;
  let bestN = 0;
  for (const c of colors) {
    if (!c) continue;
    const n = (counts.get(c) ?? 0) + 1;
    counts.set(c, n);
    // Ties keep the color seen first (stable across renders).
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

export function clusterPins<T extends ClusterInput>(points: readonly T[], opts: ClusterOptions): ClusterResult<T> {
  const radius = opts.radiusPx ?? 56;
  const maxZoom = opts.maxClusterZoom ?? 15;
  const minPoints = Math.max(2, opts.minPoints ?? 2);
  if (opts.zoom >= maxZoom || points.length < minPoints) return { singles: [...points], clusters: [] };

  // Greedy radius clustering (as supercluster does per zoom level): each
  // point not yet taken gathers the free points within `radius` pixels.
  // Points are visited in a stable order so clusters do not flicker.
  const pts = points
    .map((p) => ({ p, ...project(p.lat, p.lon, opts.zoom) }))
    .sort((a, b) => (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0));
  const grid = new Map<string, number[]>();
  const cellOf = (x: number, y: number) => [Math.floor(x / radius), Math.floor(y / radius)] as const;
  pts.forEach((q, i) => {
    const [cx, cy] = cellOf(q.x, q.y);
    const k = `${cx}:${cy}`;
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  const taken = new Uint8Array(pts.length);
  const groups: { members: T[]; key: string }[] = [];
  pts.forEach((q, i) => {
    if (taken[i]) return;
    taken[i] = 1;
    const members = [q.p];
    const [cx, cy] = cellOf(q.x, q.y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (taken[j]) continue;
          const o = pts[j]!;
          if ((o.x - q.x) ** 2 + (o.y - q.y) ** 2 <= radius * radius) {
            taken[j] = 1;
            members.push(o.p);
          }
        }
      }
    }
    groups.push({ members, key: q.p.id });
  });

  const singles: T[] = [];
  const clusters: Cluster[] = [];
  for (const { key, members } of groups) {
    if (members.length < minPoints) {
      singles.push(...members);
      continue;
    }
    let lat = 0;
    let lon = 0;
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const m of members) {
      lat += m.lat;
      lon += m.lon;
      w = Math.min(w, m.lon);
      e = Math.max(e, m.lon);
      s = Math.min(s, m.lat);
      n = Math.max(n, m.lat);
    }
    clusters.push({
      id: `cluster:${opts.zoom.toFixed(0)}:${key}`,
      lat: lat / members.length,
      lon: lon / members.length,
      count: members.length,
      color: majorityColor(members.map((m) => m.color)),
      memberIds: members.map((m) => m.id),
      bbox: [w, s, e, n],
    });
  }
  return { singles, clusters };
}

/** Zoom that shows a cluster's members apart (fits its bbox, at least +2). */
export function expansionZoom(c: Cluster, current: number, viewport: { width: number; height: number }, maxZoom = 18): number {
  const [w, s, e, n] = c.bbox;
  const a = project(n, w, 0);
  const b = project(s, e, 0);
  const dx = Math.max(1e-9, Math.abs(b.x - a.x));
  const dy = Math.max(1e-9, Math.abs(b.y - a.y));
  const fit = Math.log2(Math.min((viewport.width * 0.6) / dx, (viewport.height * 0.6) / dy));
  return Math.min(maxZoom, Math.max(current + 2, fit));
}
