/**
 * Overpass API client: places around a point or in a bbox (sorted by
 * distance, for the add screen), one element by type/id (place card), and
 * batches of elements (monthly refresh and closed-place check).
 *
 * Usage policy (overpass-api.de): few, small queries; about 2 concurrent
 * slots per IP; 429/504 mean "slow down". We keep one query in flight per
 * endpoint, cache results, fail over to the next configured endpoint, and
 * batch identifiers for refreshes.
 */
import { categorize } from './categories.ts';
import { BadResponseError, HttpError, InvalidArgumentError, NetworkError, RateLimitedError, TimeoutError, isAbortError } from './errors.ts';
import { assertBBox, assertLatLon, bboxCenter, distanceMeters, fmtCoord } from './geo.ts';
import type { HttpClient } from './http/client.ts';
import { type PlaceInfo, normalizeElement } from './normalize.ts';
import type { BBox, LatLon, OsmElement, OsmRef, RequestOptions } from './types.ts';
import { refKey } from './types.ts';

export interface OverpassResponse {
  version?: number;
  generator?: string;
  osm3s?: { timestamp_osm_base?: string; copyright?: string };
  elements: OsmElement[];
  remark?: string;
}

export interface NearbyPlace extends PlaceInfo {
  /** Meters from the search center. */
  distance: number;
}

export interface NearbyOptions extends RequestOptions {
  /** Meters, default 150, at most 1000. */
  radius?: number;
  /** Maximum places returned (nearest first). Default 50. */
  limit?: number;
}

export interface BBoxOptions extends RequestOptions {
  /** Distances are measured from here; default: the bbox center. */
  center?: LatLon;
  limit?: number;
}

export interface ElementsResult {
  /** Elements Overpass returned, by `type/id`. */
  found: Map<string, OsmElement>;
  /** Requested elements Overpass did not return (deleted, or never existed). */
  missing: OsmRef[];
  /** Data timestamp of the answering server (`osm3s.timestamp_osm_base`). */
  dataTimestamp?: string;
}

export interface OverpassClientOptions {
  http: HttpClient;
  /** Interpreter URLs in order of preference. */
  endpoints: string[];
  /** Server-side timeout of a query, seconds. Default 25. */
  queryTimeoutSec?: number;
  /** Cache lifetime of nearby/bbox results. Default 24 h. */
  nearbyTtlMs?: number;
  /** Cache lifetime of element lookups. Default 24 h (refreshes use `cache: 'reload'`). */
  elementTtlMs?: number;
}

/** Keys that make an element a candidate place (with a name). */
export const POI_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'historic', 'craft', 'office', 'natural'];
const MAX_RADIUS = 1000;
/** Rough cap on bbox queries (≈ 2 km × 2 km at mid latitudes). */
const MAX_BBOX_DEG2 = 0.0006;
/** Hard cap on elements per answer, as a safety net for dense areas. */
const MAX_OUT = 500;
export const ELEMENT_BATCH_SIZE = 100;

/** Overpass "remark" values that mean the answer is incomplete. */
function checkRemark(data: unknown): void {
  const r = data as Partial<OverpassResponse> | null;
  if (!r || !Array.isArray(r.elements)) throw new BadResponseError('Overpass answer without elements');
  if (r.remark && /runtime error|timed out|out of memory/i.test(r.remark)) {
    throw new OverpassRuntimeError(r.remark);
  }
}

export class OverpassRuntimeError extends BadResponseError {
  constructor(readonly remark: string) {
    super(`Overpass runtime error: ${remark}`);
    this.name = 'OverpassRuntimeError';
  }
}

function failoverable(e: unknown): boolean {
  if (e instanceof RateLimitedError || e instanceof NetworkError || e instanceof TimeoutError) return true;
  if (e instanceof OverpassRuntimeError) return true;
  return e instanceof HttpError && e.status >= 500;
}

export function buildAroundQuery(center: LatLon, radius: number, timeoutSec = 25): string {
  assertLatLon(center);
  const r = Math.round(radius);
  const keys = POI_KEYS.join('|');
  return [
    `[out:json][timeout:${timeoutSec}];`,
    `nwr(around:${r},${fmtCoord(center.lat)},${fmtCoord(center.lon)})[name][~"^(${keys})$"~"."];`,
    `out tags center qt ${MAX_OUT};`,
  ].join('\n');
}

export function buildBBoxQuery(b: BBox, timeoutSec = 25): string {
  assertBBox(b);
  const keys = POI_KEYS.join('|');
  const bb = [b.south, b.west, b.north, b.east].map((n) => fmtCoord(n)).join(',');
  return [`[out:json][timeout:${timeoutSec}];`, `nwr(${bb})[name][~"^(${keys})$"~"."];`, `out tags center qt ${MAX_OUT};`].join('\n');
}

export function buildElementsQuery(refs: OsmRef[], timeoutSec = 25): string {
  const ids = { node: [] as number[], way: [] as number[], relation: [] as number[] };
  for (const r of refs) {
    if (!Number.isSafeInteger(r.id) || r.id <= 0) throw new InvalidArgumentError(`Invalid OSM id ${r.id}`);
    if (!(r.type in ids)) throw new InvalidArgumentError(`Invalid OSM type ${String(r.type)}`);
    ids[r.type].push(r.id);
  }
  const parts: string[] = [];
  const sorted = (a: number[]) => [...new Set(a)].sort((x, y) => x - y).join(',');
  if (ids.node.length) parts.push(`node(id:${sorted(ids.node)});`);
  if (ids.way.length) parts.push(`way(id:${sorted(ids.way)});`);
  if (ids.relation.length) parts.push(`rel(id:${sorted(ids.relation)});`);
  return [`[out:json][timeout:${timeoutSec}];`, `(${parts.join('')});`, 'out meta center;'].join('\n');
}

export class OverpassClient {
  private readonly http: HttpClient;
  private readonly endpoints: string[];
  private readonly timeoutSec: number;
  private readonly nearbyTtlMs: number;
  private readonly elementTtlMs: number;

  constructor(o: OverpassClientOptions) {
    if (o.endpoints.length === 0) throw new InvalidArgumentError('At least one Overpass endpoint is required');
    this.http = o.http;
    this.endpoints = o.endpoints;
    this.timeoutSec = o.queryTimeoutSec ?? 25;
    this.nearbyTtlMs = o.nearbyTtlMs ?? 24 * 3600_000;
    this.elementTtlMs = o.elementTtlMs ?? 24 * 3600_000;
  }

  /** Runs an Overpass QL query, failing over across endpoints. */
  async query(ql: string, opts: RequestOptions & { ttlMs?: number } = {}): Promise<OverpassResponse> {
    let lastError: unknown;
    for (let i = 0; i < this.endpoints.length; i++) {
      const url = this.endpoints[i]!;
      const isLast = i === this.endpoints.length - 1;
      try {
        return await this.http.getJson<OverpassResponse>(
          {
            service: 'overpass',
            url,
            method: 'POST',
            body: `data=${encodeURIComponent(ql)}`,
            contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
            ttlMs: opts.ttlMs ?? this.nearbyTtlMs,
            key: `overpass\n${ql}`,
            validate: checkRemark,
            ...(isLast ? {} : { retries: 0 }),
          },
          opts,
        );
      } catch (e) {
        if (isAbortError(e) || !failoverable(e) || isLast) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  /** Named places around a point, nearest first (the add screen's list). */
  async nearby(center: LatLon, opts: NearbyOptions = {}): Promise<NearbyPlace[]> {
    const radius = Math.min(Math.max(opts.radius ?? 150, 1), MAX_RADIUS);
    const r = await this.query(buildAroundQuery(center, radius, this.timeoutSec), opts);
    return rankByDistance(r.elements, center, opts.limit ?? 50, radius);
  }

  /** Named places in the visible area, nearest to `center` first. */
  async inBBox(bbox: BBox, opts: BBoxOptions = {}): Promise<NearbyPlace[]> {
    assertBBox(bbox);
    const area = (bbox.north - bbox.south) * Math.abs(bbox.east - bbox.west);
    if (area > MAX_BBOX_DEG2) throw new InvalidArgumentError('Area too large for an Overpass query; zoom in');
    const r = await this.query(buildBBoxQuery(bbox, this.timeoutSec), opts);
    return rankByDistance(r.elements, opts.center ?? bboxCenter(bbox), opts.limit ?? 50);
  }

  /** Raw elements by reference, in batches. Missing ones are listed in `missing`. */
  async getElements(refs: OsmRef[], opts: RequestOptions & { batchSize?: number } = {}): Promise<ElementsResult> {
    const found = new Map<string, OsmElement>();
    const size = Math.max(1, Math.min(opts.batchSize ?? ELEMENT_BATCH_SIZE, 500));
    let dataTimestamp: string | undefined;
    for (let i = 0; i < refs.length; i += size) {
      const batch = refs.slice(i, i + size);
      const r = await this.query(buildElementsQuery(batch, this.timeoutSec), { ...opts, ttlMs: this.elementTtlMs });
      dataTimestamp ??= r.osm3s?.timestamp_osm_base;
      for (const el of r.elements) found.set(refKey(el), el);
    }
    const missing = dedupeRefs(refs).filter((r) => !found.has(refKey(r)));
    return { found, missing, ...(dataTimestamp ? { dataTimestamp } : {}) };
  }

  /** One element, raw (null if Overpass does not have it). */
  async getElement(ref: OsmRef, opts: RequestOptions = {}): Promise<OsmElement | null> {
    const r = await this.getElements([ref], opts);
    return r.found.get(refKey(ref)) ?? null;
  }

  /** One place card (null if missing or not a place). */
  async getPlace(ref: OsmRef, opts: RequestOptions = {}): Promise<PlaceInfo | null> {
    const el = await this.getElement(ref, opts);
    return el ? normalizeElement(el) : null;
  }
}

function dedupeRefs(refs: OsmRef[]): OsmRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = refKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Normalizes, drops non-places, sorts by distance and cuts to `limit`. */
export function rankByDistance(elements: OsmElement[], center: LatLon, limit: number, maxDistance = Infinity): NearbyPlace[] {
  const out: NearbyPlace[] = [];
  for (const el of elements) {
    if (!el.tags || !categorize(el.tags)) continue;
    const p = normalizeElement(el);
    if (!p?.location) continue;
    const distance = distanceMeters(center, p.location);
    // Overpass's `around` matches any part of a way; keep large ones by their center within a margin.
    if (distance > maxDistance * 2) continue;
    out.push({ ...p, distance });
  }
  out.sort((a, b) => a.distance - b.distance || (a.name ?? '').localeCompare(b.name ?? ''));
  return out.slice(0, limit);
}
