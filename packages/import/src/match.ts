// SPDX-License-Identifier: MPL-2.0
/**
 * Matching imported places to OpenStreetMap (spec "Importing your places"):
 * by name and position, or by name (and address) alone when the source has
 * no coordinates. Confident matches are automatic, doubtful ones are offered
 * for a choice, and with no match the place becomes a manual point.
 *
 * Network use is kept low: places are grouped into tiles of about 1 km and
 * each tile is one Overpass bbox query (named POIs), whatever the number of
 * places in it; text searches run one at a time, only for places without
 * coordinates. The lookup is an interface: the app adapts its OSM client
 * (`osmLookupFromClient`), tests use fixtures.
 */
import { haversineM, nameSimilarity, normalizeText, type LatLon, type OsmType } from '@triangulair/data';

import type { ClosureSignalLike, ImportedPlace } from './model.ts';

export interface OsmCandidate {
  ref: { type: OsmType; id: number };
  name: string;
  lat: number;
  lon: number;
  /** `key=value`. */
  category: string | null;
  address?: string;
  /** Raw OSM tags (cached on the place card when saved). */
  tags?: Record<string, string>;
}

export interface SearchHit {
  /** null for an address, a street or a locality (not a place card). */
  ref: { type: OsmType; id: number } | null;
  name: string;
  lat: number;
  lon: number;
  category: string | null;
  address?: string;
  kind: 'poi' | 'address' | 'street' | 'locality' | 'region' | 'other';
}

export interface BBoxLike {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface OsmLookup {
  /** Named POIs in a bbox (at most about 1.5 km across). */
  inBBox(bbox: BBoxLike, signal?: AbortSignal): Promise<OsmCandidate[]>;
  /** Text search, for places without coordinates. Optional (offline: those places stay unlocated). */
  search?(query: string, opts: { near?: LatLon; signal?: AbortSignal }): Promise<SearchHit[]>;
}

export interface ScoredCandidate extends OsmCandidate {
  /** "Maybe closed" signals of this OSM object (lifecycle tags…), set by `buildPlan`. */
  closure?: ClosureSignalLike[];
  similarity: number;
  /** Meters from the imported point; null when the import had no coordinates. */
  distanceM: number | null;
  score: number;
}

export type MatchOutcome =
  /** The source named the OSM object (TrianguLair export, `@id` in GeoJSON). */
  | { kind: 'source'; candidates: ScoredCandidate[] }
  /** One clear OSM match. */
  | { kind: 'matched'; best: ScoredCandidate; candidates: ScoredCandidate[] }
  /** Several possible matches, or one doubtful: the user chooses. */
  | { kind: 'ambiguous'; candidates: ScoredCandidate[]; geocoded?: LatLon }
  /** No OSM match: becomes a manual point at the imported (or geocoded) position. */
  | { kind: 'manual'; candidates: ScoredCandidate[]; geocoded?: LatLon; lookupFailed?: boolean }
  /** No coordinates and nothing found: cannot be placed without the user. */
  | { kind: 'unlocated'; candidates: ScoredCandidate[]; lookupFailed?: boolean };

export interface MatchOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Tile size in degrees (default 0.01, about 1.1 km north–south). */
  tileDeg?: number;
  /** Search radius around an imported point, meters (default 250). */
  radiusM?: number;
}

/** Thresholds, exported for the tests and the README. */
export const MATCH_RULES = {
  /** Beyond this, a candidate is not considered. */
  maxDistanceM: 250,
  /** Automatic match: name similarity and distance. */
  confidentSimilarity: 0.8,
  confidentDistanceM: 80,
  /** …and the runner-up must be clearly worse. */
  confidentMargin: 0.2,
  /** Very close (same building) with a fairly similar name is also automatic. */
  closeDistanceM: 25,
  closeSimilarity: 0.6,
  /** Below this similarity a candidate is not offered at all. */
  minSimilarity: 0.45,
  maxOffered: 4,
} as const;

function addressBonus(p: ImportedPlace, c: Pick<OsmCandidate, 'address'>): number {
  if (!p.address || !c.address) return 0;
  const a = normalizeText(p.address);
  const b = normalizeText(c.address);
  // The candidate's "12 rue de bretagne" inside the imported address, or the reverse.
  const first = b.split(/\s*,\s*/)[0] ?? '';
  return first.length >= 6 && (a.includes(first) || b.includes(normalizeText(p.address.split(',')[0] ?? ''))) ? 0.15 : 0;
}

export function scoreCandidate(p: ImportedPlace, c: OsmCandidate): ScoredCandidate {
  const similarity = Math.min(1, nameSimilarity(p.name, c.name) + addressBonus(p, c));
  const distanceM = p.lat !== undefined && p.lon !== undefined ? haversineM({ lat: p.lat, lon: p.lon }, c) : null;
  // Distance costs up to 0.3 at the edge of the search radius.
  const score = similarity - (distanceM === null ? 0 : (0.3 * Math.min(distanceM, MATCH_RULES.maxDistanceM)) / MATCH_RULES.maxDistanceM);
  return { ...c, similarity, distanceM, score };
}

const byScore = (a: ScoredCandidate, b: ScoredCandidate) =>
  b.score - a.score || (a.distanceM ?? 0) - (b.distanceM ?? 0) || (a.ref.type + a.ref.id < b.ref.type + b.ref.id ? -1 : 1);

/** Classifies one place with coordinates against the POIs around it (pure). */
export function classify(p: ImportedPlace, pois: readonly OsmCandidate[], radiusM: number = MATCH_RULES.maxDistanceM): MatchOutcome {
  const scored = pois
    .map((c) => scoreCandidate(p, c))
    .filter((c) => c.distanceM !== null && c.distanceM <= radiusM)
    .sort(byScore);
  const offered = scored.filter((c) => c.similarity >= MATCH_RULES.minSimilarity).slice(0, MATCH_RULES.maxOffered);
  const best = offered[0];
  if (!best) return { kind: 'manual', candidates: scored.slice(0, MATCH_RULES.maxOffered) };
  const second = offered[1];
  const d = best.distanceM ?? Infinity;
  const clear = !second || best.similarity - second.similarity >= MATCH_RULES.confidentMargin;
  if (clear && best.similarity >= MATCH_RULES.confidentSimilarity && d <= MATCH_RULES.confidentDistanceM) {
    return { kind: 'matched', best, candidates: offered };
  }
  if (clear && best.similarity >= MATCH_RULES.closeSimilarity && d <= MATCH_RULES.closeDistanceM) {
    return { kind: 'matched', best, candidates: offered };
  }
  return { kind: 'ambiguous', candidates: offered };
}

/** Places without coordinates: search by name (and address); never automatic. */
export function classifySearch(p: ImportedPlace, hits: readonly SearchHit[]): MatchOutcome {
  const pois = hits.filter((h): h is SearchHit & { ref: NonNullable<SearchHit['ref']> } => h.kind === 'poi' && h.ref !== null);
  const scored = pois
    .map((h) => scoreCandidate(p, { ref: h.ref, name: h.name, lat: h.lat, lon: h.lon, category: h.category, ...(h.address && { address: h.address }) }))
    .filter((c) => c.similarity >= MATCH_RULES.minSimilarity)
    .sort(byScore)
    .slice(0, MATCH_RULES.maxOffered);
  const place = hits.find((h) => h.kind !== 'poi') ?? hits[0];
  const geocoded = place ? { lat: place.lat, lon: place.lon } : undefined;
  if (scored.length > 0) return { kind: 'ambiguous', candidates: scored, ...(geocoded && { geocoded }) };
  if (geocoded) return { kind: 'manual', candidates: [], geocoded };
  return { kind: 'unlocated', candidates: [] };
}

export function tileKey(lat: number, lon: number, deg: number): string {
  return `${Math.floor(lat / deg)}:${Math.floor(lon / deg)}`;
}

/** The bbox of a tile, widened by the search radius so places near its edge see their neighbors. */
export function tileBBox(key: string, deg: number, marginM: number): BBoxLike {
  const [y, x] = key.split(':').map(Number) as [number, number];
  const south = y * deg;
  const west = x * deg;
  const mLat = marginM / 111_320;
  const mLon = marginM / (111_320 * Math.max(0.2, Math.cos(((south + deg / 2) * Math.PI) / 180)));
  return {
    south: Math.max(-90, south - mLat),
    north: Math.min(90, south + deg + mLat),
    west: Math.max(-180, west - mLon),
    east: Math.min(180, west + deg + mLon),
  };
}

function aborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  // Hermes has no DOMException.
  const e = new Error('Import cancelled');
  e.name = 'AbortError';
  throw e;
}

/**
 * Matches every place. Returns outcomes keyed by place key. Places the
 * source already ties to OSM, and zones, are not looked up.
 */
export async function matchPlaces(places: readonly ImportedPlace[], lookup: OsmLookup | null, opts: MatchOptions = {}): Promise<Map<string, MatchOutcome>> {
  const out = new Map<string, MatchOutcome>();
  const deg = opts.tileDeg ?? 0.01;
  const radius = opts.radiusM ?? MATCH_RULES.maxDistanceM;
  const tiles = new Map<string, ImportedPlace[]>();
  const toSearch: ImportedPlace[] = [];
  for (const p of places) {
    if (p.ids.osm || p.ids.placeId) {
      out.set(p.key, { kind: 'source', candidates: [] });
    } else if (p.shape) {
      out.set(p.key, { kind: 'manual', candidates: [] });
    } else if (p.lat !== undefined && p.lon !== undefined) {
      const k = tileKey(p.lat, p.lon, deg);
      (tiles.get(k) ?? tiles.set(k, []).get(k)!).push(p);
    } else {
      toSearch.push(p);
    }
  }
  const total = tiles.size + toSearch.length;
  let done = 0;
  opts.onProgress?.(0, total);
  for (const [k, ps] of tiles) {
    aborted(opts.signal);
    let pois: OsmCandidate[] | null = null;
    if (lookup) {
      try {
        pois = await lookup.inBBox(tileBBox(k, deg, radius), opts.signal);
      } catch (e) {
        aborted(opts.signal);
        pois = null;
        void e;
      }
    }
    for (const p of ps) {
      out.set(p.key, pois ? classify(p, pois, radius) : { kind: 'manual', candidates: [], lookupFailed: true });
    }
    opts.onProgress?.(++done, total);
  }
  for (const p of toSearch) {
    aborted(opts.signal);
    if (!lookup?.search) {
      out.set(p.key, { kind: 'unlocated', candidates: [], lookupFailed: !lookup });
    } else {
      try {
        const q = p.address ? `${p.name}, ${p.address}` : p.name;
        let hits = await lookup.search(q, opts.signal ? { signal: opts.signal } : {});
        if (hits.length === 0 && p.address) hits = await lookup.search(p.address, opts.signal ? { signal: opts.signal } : {});
        out.set(p.key, classifySearch(p, hits));
      } catch {
        aborted(opts.signal);
        out.set(p.key, { kind: 'unlocated', candidates: [], lookupFailed: true });
      }
    }
    opts.onProgress?.(++done, total);
  }
  return out;
}

// ------------------------------------------------------------------ adapter for @triangulair/osm

/** The parts of `@triangulair/osm`'s client the import uses (structural, so this package does not depend on it). */
export interface OsmClientLike {
  overpass: {
    inBBox(
      bbox: BBoxLike,
      opts?: { signal?: AbortSignal; limit?: number },
    ): Promise<
      {
        ref: { type: OsmType; id: number };
        name?: string;
        location: LatLon | null;
        primaryTag?: { key: string; value: string };
        address: { formatted?: string };
        tags: Record<string, string>;
      }[]
    >;
  };
  search?: {
    search(
      q: string,
      opts?: { signal?: AbortSignal; mode?: 'autocomplete' | 'submit'; near?: LatLon; limit?: number },
    ): Promise<
      {
        ref?: { type: OsmType; id: number };
        name: string;
        label: string;
        location: LatLon;
        kind: SearchHit['kind'];
        osmKey?: string;
        osmValue?: string;
      }[]
    >;
  };
}

export function osmLookupFromClient(client: OsmClientLike): OsmLookup {
  const search = client.search;
  return {
    async inBBox(bbox, signal) {
      const r = await client.overpass.inBBox(bbox, { limit: 500, ...(signal && { signal }) });
      return r
        .filter((p) => p.location && p.name)
        .map((p) => ({
          ref: p.ref,
          name: p.name!,
          lat: p.location!.lat,
          lon: p.location!.lon,
          category: p.primaryTag ? `${p.primaryTag.key}=${p.primaryTag.value}` : null,
          ...(p.address.formatted && { address: p.address.formatted }),
          tags: p.tags,
        }));
    },
    ...(search && {
      async search(q: string, o: { near?: LatLon; signal?: AbortSignal }) {
        // Photon only ("autocomplete" mode): Nominatim's policy discourages bulk geocoding.
        const r = await search.search(q, { mode: 'autocomplete', limit: 8, ...(o.near && { near: o.near }), ...(o.signal && { signal: o.signal }) });
        return r.map((h) => ({
          ref: h.ref ?? null,
          name: h.name,
          lat: h.location.lat,
          lon: h.location.lon,
          category: h.osmKey && h.osmValue ? `${h.osmKey}=${h.osmValue}` : null,
          ...(h.label && { address: h.label }),
          kind: h.kind,
        }));
      },
    }),
  };
}
