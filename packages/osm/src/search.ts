/**
 * Place search: Photon for search-as-you-type, Nominatim as the fallback.
 *
 * Nominatim's usage policy (nominatim.openstreetmap.org) forbids
 * autocomplete, so it is only used for an explicit search (`mode: 'submit'`)
 * and for reverse geocoding when Photon fails: at most 1 request per second,
 * results cached, identifying User-Agent/Referer and optionally an `email`.
 */
import { type CategoryId, categoryForTag } from './categories.ts';
import { AbortError, HttpError, NetworkError, OsmError, RateLimitedError, TimeoutError, isAbortError } from './errors.ts';
import { assertLatLon, distanceMeters, fmtCoord } from './geo.ts';
import type { HttpClient } from './http/client.ts';
import { type Address, formatAddress } from './normalize.ts';
import type { BBox, LatLon, OsmRef, OsmType, RequestOptions } from './types.ts';

export type ResultKind = 'poi' | 'address' | 'street' | 'locality' | 'region' | 'other';

export interface SearchResult {
  source: 'photon' | 'nominatim';
  ref?: OsmRef;
  name: string;
  /** Secondary line: address or locality. */
  label: string;
  location: LatLon;
  kind: ResultKind;
  category: CategoryId | null;
  osmKey?: string;
  osmValue?: string;
  address: Address;
  extent?: BBox;
  /** Meters from `near`, when given. */
  distance?: number;
}

export interface SearchOptions extends RequestOptions {
  /** `autocomplete`: Photon only. `submit`: Photon, then Nominatim if Photon fails or finds nothing. */
  mode?: 'autocomplete' | 'submit';
  near?: LatLon;
  /** Restricts Photon (bbox param) and biases Nominatim (viewbox). */
  bbox?: BBox;
  limit?: number;
  /** BCP-47 language for names, e.g. "fr". */
  lang?: string;
}

// ---------------------------------------------------------------------------
// Photon

interface PhotonFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    osm_type?: 'N' | 'W' | 'R';
    osm_id?: number;
    osm_key?: string;
    osm_value?: string;
    type?: string;
    name?: string;
    housenumber?: string;
    street?: string;
    postcode?: string;
    district?: string;
    city?: string;
    locality?: string;
    county?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    extent?: [number, number, number, number];
  };
}

interface PhotonResponse {
  type: 'FeatureCollection';
  features: PhotonFeature[];
}

const PHOTON_TYPES: Record<string, OsmType> = { N: 'node', W: 'way', R: 'relation' };

function kindFrom(key: string | undefined, value: string | undefined, type: string | undefined): ResultKind {
  if (key && value && categoryForTag(key, value)) return 'poi';
  if (type === 'house' || key === 'building' || (key === 'place' && value === 'house')) return 'address';
  if (type === 'street' || key === 'highway') return 'street';
  if (type === 'city' || type === 'district' || type === 'locality' || key === 'place') return 'locality';
  if (type === 'county' || type === 'state' || type === 'country' || key === 'boundary') return 'region';
  return 'other';
}

export function parsePhoton(r: PhotonResponse, near?: LatLon): SearchResult[] {
  const out: SearchResult[] = [];
  for (const f of r.features ?? []) {
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const address: Address = {};
    if (p.street) address.street = p.street;
    if (p.housenumber) address.housenumber = p.housenumber;
    if (p.postcode) address.postcode = p.postcode;
    const city = p.city ?? p.locality;
    if (city) address.city = city;
    if (p.countrycode) address.country = p.countrycode.toUpperCase();
    const formatted = formatAddress(address);
    if (formatted) address.formatted = formatted;
    const kind = kindFrom(p.osm_key, p.osm_value, p.type);
    const name = p.name ?? (formatAddress({ ...address, postcode: undefined, city: undefined }) || city || '');
    if (!name) continue;
    const labelParts = kind === 'poi' || kind === 'other' ? [formatted] : [city !== name ? city : undefined, p.state, p.country];
    const res: SearchResult = {
      source: 'photon',
      name,
      label: labelParts.filter(Boolean).join(', ') || [p.state, p.country].filter(Boolean).join(', '),
      location: { lat, lon },
      kind,
      category: p.osm_key && p.osm_value ? categoryForTag(p.osm_key, p.osm_value) : null,
      address,
    };
    const t = p.osm_type ? PHOTON_TYPES[p.osm_type] : undefined;
    if (t && typeof p.osm_id === 'number') res.ref = { type: t, id: p.osm_id };
    if (p.osm_key) res.osmKey = p.osm_key;
    if (p.osm_value) res.osmValue = p.osm_value;
    if (p.extent) {
      const [w, n, e, s] = p.extent;
      res.extent = { south: s, west: w, north: n, east: e };
    }
    if (near) res.distance = distanceMeters(near, res.location);
    out.push(res);
  }
  return out;
}

export interface PhotonClientOptions {
  http: HttpClient;
  baseUrl: string;
  /** Languages the instance supports; others fall back to the default. Public instance: en, de, fr, it. */
  languages?: string[];
  ttlMs?: number;
}

export class PhotonClient {
  private readonly languages: string[];
  private readonly ttlMs: number;
  constructor(private readonly o: PhotonClientOptions) {
    this.languages = o.languages ?? ['en', 'de', 'fr', 'it'];
    this.ttlMs = o.ttlMs ?? 24 * 3600_000;
  }

  private lang(lang?: string): string | undefined {
    const l = lang?.slice(0, 2).toLowerCase();
    return l && this.languages.includes(l) ? l : undefined;
  }

  async search(q: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: q.trim(), limit: String(opts.limit ?? 10) });
    const lang = this.lang(opts.lang);
    if (lang) params.set('lang', lang);
    if (opts.near) {
      assertLatLon(opts.near);
      params.set('lat', fmtCoord(opts.near.lat, 5));
      params.set('lon', fmtCoord(opts.near.lon, 5));
    }
    if (opts.bbox) {
      const b = opts.bbox;
      params.set('bbox', [b.west, b.south, b.east, b.north].map((n) => fmtCoord(n, 5)).join(','));
    }
    const r = await this.o.http.getJson<PhotonResponse>(
      { service: 'photon', url: `${this.o.baseUrl}/api?${params}`, ttlMs: this.ttlMs },
      opts,
    );
    return parsePhoton(r, opts.near);
  }

  async reverse(p: LatLon, opts: RequestOptions & { lang?: string } = {}): Promise<SearchResult | null> {
    assertLatLon(p);
    const params = new URLSearchParams({ lat: fmtCoord(p.lat, 6), lon: fmtCoord(p.lon, 6), limit: '1' });
    const lang = this.lang(opts.lang);
    if (lang) params.set('lang', lang);
    const r = await this.o.http.getJson<PhotonResponse>(
      { service: 'photon', url: `${this.o.baseUrl}/reverse?${params}`, ttlMs: 30 * 24 * 3600_000 },
      opts,
    );
    return parsePhoton(r, p)[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Nominatim

interface NominatimPlace {
  place_id?: number;
  licence?: string;
  osm_type?: OsmType;
  osm_id?: number;
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  addresstype?: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string>;
  boundingbox?: [string, string, string, string];
  error?: string;
}

export function parseNominatim(list: NominatimPlace[], near?: LatLon): SearchResult[] {
  const out: SearchResult[] = [];
  for (const p of list) {
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const a = p.address ?? {};
    const address: Address = {};
    const street = a.road ?? a.pedestrian ?? a.footway ?? a.square;
    if (street) address.street = street;
    if (a.house_number) address.housenumber = a.house_number;
    if (a.postcode) address.postcode = a.postcode;
    const city = a.city ?? a.town ?? a.village ?? a.municipality;
    if (city) address.city = city;
    if (a.country_code) address.country = a.country_code.toUpperCase();
    const formatted = formatAddress(address);
    if (formatted) address.formatted = formatted;
    const typeHint =
      p.addresstype === 'house' || p.addresstype === 'building'
        ? 'house'
        : p.addresstype === 'road'
          ? 'street'
          : ['city', 'town', 'village', 'suburb', 'neighbourhood', 'quarter'].includes(p.addresstype ?? '')
            ? 'city'
            : p.addresstype;
    const kind = kindFrom(p.category, p.type, typeHint);
    const name = p.name || formatted || p.display_name?.split(',')[0]?.trim() || '';
    if (!name) continue;
    const res: SearchResult = {
      source: 'nominatim',
      name,
      label:
        (kind === 'poi' ? formatted : undefined) ??
        (p.display_name ?? '')
          .split(',')
          .slice(1)
          .map((s) => s.trim())
          .join(', '),
      location: { lat, lon },
      kind,
      category: p.category && p.type ? categoryForTag(p.category, p.type) : null,
      address,
    };
    if (p.osm_type && typeof p.osm_id === 'number') res.ref = { type: p.osm_type, id: p.osm_id };
    if (p.category) res.osmKey = p.category;
    if (p.type) res.osmValue = p.type;
    if (p.boundingbox) {
      const [s, n, w, e] = p.boundingbox.map(Number) as [number, number, number, number];
      res.extent = { south: s, north: n, west: w, east: e };
    }
    if (near) res.distance = distanceMeters(near, res.location);
    out.push(res);
  }
  return out;
}

export interface NominatimClientOptions {
  http: HttpClient;
  baseUrl: string;
  /** Contact e-mail sent as `email=` (asked by the policy for heavier use). */
  email?: string;
  /** The policy asks to cache results; default 7 days. */
  ttlMs?: number;
}

export class NominatimClient {
  private readonly ttlMs: number;
  constructor(private readonly o: NominatimClientOptions) {
    this.ttlMs = o.ttlMs ?? 7 * 24 * 3600_000;
  }

  private common(lang?: string): URLSearchParams {
    const p = new URLSearchParams({ format: 'jsonv2', addressdetails: '1' });
    if (lang) p.set('accept-language', lang);
    if (this.o.email) p.set('email', this.o.email);
    return p;
  }

  async search(q: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    if (opts.mode === 'autocomplete') {
      throw new OsmError('invalid_argument', 'Nominatim must not be used for search-as-you-type (usage policy)');
    }
    const params = this.common(opts.lang);
    params.set('q', q.trim());
    params.set('limit', String(Math.min(opts.limit ?? 10, 40)));
    if (opts.bbox) {
      const b = opts.bbox;
      params.set('viewbox', [b.west, b.north, b.east, b.south].map((n) => fmtCoord(n, 5)).join(','));
      params.set('bounded', '0');
    }
    const r = await this.o.http.getJson<NominatimPlace[]>(
      { service: 'nominatim', url: `${this.o.baseUrl}/search?${params}`, ttlMs: this.ttlMs },
      opts,
    );
    const results = parseNominatim(Array.isArray(r) ? r : [], opts.near);
    if (opts.near) results.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    return results;
  }

  async reverse(p: LatLon, opts: RequestOptions & { lang?: string } = {}): Promise<SearchResult | null> {
    assertLatLon(p);
    const params = this.common(opts.lang);
    params.set('lat', fmtCoord(p.lat, 6));
    params.set('lon', fmtCoord(p.lon, 6));
    params.set('zoom', '18');
    const r = await this.o.http.getJson<NominatimPlace>(
      { service: 'nominatim', url: `${this.o.baseUrl}/reverse?${params}`, ttlMs: 30 * 24 * 3600_000 },
      opts,
    );
    if (!r || r.error) return null;
    return parseNominatim([r], p)[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Combined search

function serviceDown(e: unknown): boolean {
  return (
    e instanceof NetworkError ||
    e instanceof TimeoutError ||
    e instanceof RateLimitedError ||
    (e instanceof HttpError && e.status >= 500)
  );
}

export class PlaceSearch {
  constructor(
    readonly photon: PhotonClient,
    readonly nominatim: NominatimClient,
  ) {}

  /**
   * `autocomplete` (default): Photon only; errors propagate so the app can
   * offer an explicit search. `submit`: Photon, and Nominatim when Photon is
   * down or finds nothing.
   */
  async search(q: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const mode = opts.mode ?? 'autocomplete';
    if (!q.trim()) return [];
    if (mode === 'autocomplete') return this.photon.search(q, opts);
    try {
      const r = await this.photon.search(q, opts);
      if (r.length > 0) return r;
    } catch (e) {
      if (isAbortError(e) || !serviceDown(e)) throw e;
    }
    return this.nominatim.search(q, { ...opts, mode: 'submit' });
  }

  /** Reverse geocoding (long press on the map): Photon, then Nominatim if Photon is down. */
  async reverse(p: LatLon, opts: RequestOptions & { lang?: string } = {}): Promise<SearchResult | null> {
    try {
      return await this.photon.reverse(p, opts);
    } catch (e) {
      if (isAbortError(e) || !serviceDown(e)) throw e;
      return this.nominatim.reverse(p, opts);
    }
  }
}

export interface SearchSessionOptions extends Omit<SearchOptions, 'signal' | 'mode'> {
  /** Wait after the last keystroke, ms. Default 300. */
  debounceMs?: number;
  /** Minimum trimmed length before searching. Default 3. */
  minLength?: number;
}

/**
 * Search-as-you-type helper: debounces keystrokes and aborts the previous
 * request when the text changes, so only the latest query reaches Photon.
 * `update` resolves with results, or null when superseded or too short.
 */
export class SearchSession {
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: ((v: SearchResult[] | null) => void) | null = null;

  constructor(
    private readonly search: PlaceSearch,
    private readonly options: SearchSessionOptions = {},
  ) {}

  update(text: string): Promise<SearchResult[] | null> {
    this.cancel();
    if (text.trim().length < (this.options.minLength ?? 3)) return Promise.resolve(null);
    return this.schedule(text, 'autocomplete', this.options.debounceMs ?? 300);
  }

  /** Explicit search (enter key): no debounce, Nominatim fallback allowed. */
  submit(text: string): Promise<SearchResult[] | null> {
    this.cancel();
    if (!text.trim()) return Promise.resolve(null);
    return this.schedule(text, 'submit', 0);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.pending?.(null);
    this.pending = null;
  }

  private schedule(text: string, mode: 'autocomplete' | 'submit', delay: number): Promise<SearchResult[] | null> {
    const controller = new AbortController();
    this.controller = controller;
    return new Promise((resolve, reject) => {
      this.pending = resolve;
      const run = () => {
        this.timer = null;
        const { debounceMs: _d, minLength: _m, ...searchOpts } = this.options;
        this.search.search(text, { ...searchOpts, mode, signal: controller.signal }).then(
          (r) => {
            if (this.pending === resolve) this.pending = null;
            resolve(controller.signal.aborted ? null : r);
          },
          (e: unknown) => {
            if (this.pending === resolve) this.pending = null;
            if (isAbortError(e) || e instanceof AbortError) resolve(null);
            else reject(e);
          },
        );
      };
      if (delay > 0) this.timer = setTimeout(run, delay);
      else run();
    });
  }
}
