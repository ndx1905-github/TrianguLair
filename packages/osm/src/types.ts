/** Shared types of the OSM client. */

/** Same shape as the global `fetch`, so React Native, browsers and Node all fit. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LatLon {
  lat: number;
  lon: number;
}

/** south, west, north, east (Overpass order), in degrees. */
export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type OsmType = 'node' | 'way' | 'relation';

export interface OsmRef {
  type: OsmType;
  id: number;
}

export type OsmTags = Record<string, string>;

/** An element as returned by Overpass (`out tags center` / `out meta center`) or the OSM API. */
export interface OsmElement {
  type: OsmType;
  id: number;
  lat?: number;
  lon?: number;
  center?: LatLon;
  tags?: OsmTags;
  version?: number;
  timestamp?: string;
  changeset?: number;
  user?: string;
  uid?: number;
  /** OSM API only: false for a deleted version in a history. */
  visible?: boolean;
}

/** Common options of every network call. */
export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * - `default`: use a fresh cache entry, otherwise fetch and store.
   * - `reload`: skip the cache read (refresh), store the result.
   * - `no-store`: neither read nor write the cache.
   */
  cache?: 'default' | 'reload' | 'no-store';
}

export function refKey(ref: OsmRef): string {
  return `${ref.type}/${ref.id}`;
}

export function parseRefKey(key: string): OsmRef | null {
  const m = /^(node|way|relation)\/(\d+)$/.exec(key);
  if (!m) return null;
  return { type: m[1] as OsmType, id: Number(m[2]) };
}

export function osmUrl(ref: OsmRef): string {
  return `https://www.openstreetmap.org/${ref.type}/${ref.id}`;
}
