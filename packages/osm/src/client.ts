/**
 * One-call setup of every OSM service client, sharing one HTTP layer (so
 * rate limits, coalescing and the cache are global to the app).
 */
import { ClosureChecker, type ClosureCheckerOptions } from './closure/checker.ts';
import { type Endpoints, resolveEndpoints } from './endpoints.ts';
import { isAbortError } from './errors.ts';
import type { OsmCache } from './http/cache.ts';
import { type ClientIdentity, HttpClient, type HttpClientOptions, type ServiceId } from './http/client.ts';
import type { RateLimit } from './http/limiter.ts';
import type { PlaceInfo } from './normalize.ts';
import { OsmApiClient } from './osmapi.ts';
import { OverpassClient } from './overpass.ts';
import { CommonsClient } from './photos/commons.ts';
import { PanoramaxClient } from './photos/panoramax.ts';
import type { Photo } from './photos/types.ts';
import { NominatimClient, PhotonClient, PlaceSearch, SearchSession, type SearchSessionOptions } from './search.ts';
import type { FetchLike, RequestOptions } from './types.ts';

export interface OsmClientConfig extends ClientIdentity {
  /** Sent to Nominatim as `email=`. */
  contactEmail?: string;
  fetch?: FetchLike;
  platform?: 'native' | 'web';
  /** Persisted cache from the app (SQLite…); in-memory by default. */
  cache?: OsmCache;
  endpoints?: Partial<Endpoints>;
  rateLimits?: Partial<Record<ServiceId, RateLimit>>;
  timeoutMs?: number;
  photonLanguages?: string[];
  /** Set false to never call the OSM editing API (deletions then stay "not found"). */
  confirmDeletions?: boolean;
  closure?: Pick<ClosureCheckerOptions, 'maxDeletionChecks' | 'successorRadius' | 'now'>;
  /** Advanced: extra HttpClient options (clock, retries). */
  http?: Partial<HttpClientOptions>;
}

export interface PlacePhotosOptions extends RequestOptions {
  limit?: number;
  width?: number;
  /** Panoramax street views: only when Commons has none (default), always, or never. */
  streetLevel?: 'fallback' | 'always' | 'never';
}

export interface OsmClient {
  endpoints: Endpoints;
  http: HttpClient;
  overpass: OverpassClient;
  photon: PhotonClient;
  nominatim: NominatimClient;
  search: PlaceSearch;
  commons: CommonsClient;
  panoramax: PanoramaxClient;
  osmApi: OsmApiClient;
  closure: ClosureChecker;
  newSearchSession(opts?: SearchSessionOptions): SearchSession;
  /** Free photos of a place: Commons (from its tags), then Panoramax street views. */
  placePhotos(place: Pick<PlaceInfo, 'tags' | 'location'>, opts?: PlacePhotosOptions): Promise<Photo[]>;
}

export function createOsmClient(config: OsmClientConfig): OsmClient {
  const endpoints = resolveEndpoints(config.endpoints);
  const http = new HttpClient({
    identity: { userAgent: config.userAgent, ...(config.referer ? { referer: config.referer } : {}) },
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.platform ? { platform: config.platform } : {}),
    ...(config.cache ? { cache: config.cache } : {}),
    ...(config.rateLimits ? { rateLimits: config.rateLimits } : {}),
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
    ...config.http,
  });
  const overpass = new OverpassClient({ http, endpoints: endpoints.overpass });
  const photon = new PhotonClient({ http, baseUrl: endpoints.photon, ...(config.photonLanguages ? { languages: config.photonLanguages } : {}) });
  const nominatim = new NominatimClient({ http, baseUrl: endpoints.nominatim, ...(config.contactEmail ? { email: config.contactEmail } : {}) });
  const search = new PlaceSearch(photon, nominatim);
  const commons = new CommonsClient({ http, commonsApi: endpoints.commonsApi, wikidataApi: endpoints.wikidataApi });
  const panoramax = new PanoramaxClient({ http, baseUrl: endpoints.panoramax, viewerUrl: endpoints.panoramaxViewer });
  const osmApi = new OsmApiClient({ http, baseUrl: endpoints.osmApi });
  const closure = new ClosureChecker({
    overpass,
    ...(config.confirmDeletions === false ? {} : { osmApi }),
    ...config.closure,
  });

  return {
    endpoints,
    http,
    overpass,
    photon,
    nominatim,
    search,
    commons,
    panoramax,
    osmApi,
    closure,
    newSearchSession: (opts) => new SearchSession(search, opts),
    async placePhotos(place, opts = {}) {
      const limit = opts.limit ?? 5;
      const mode = opts.streetLevel ?? 'fallback';
      const photos = await commons.photosFor(place.tags, { ...opts, limit });
      if (mode === 'never' || !place.location) return photos;
      if (mode === 'fallback' && photos.length > 0) return photos;
      try {
        const street = await panoramax.picturesOf(place.location, { ...opts, limit: Math.max(1, Math.min(3, limit - photos.length)) });
        return [...photos, ...street];
      } catch (e) {
        // Street views are a bonus: their failure must not hide the Commons photos.
        if (isAbortError(e) || photos.length === 0) throw e;
        return photos;
      }
    },
  };
}
