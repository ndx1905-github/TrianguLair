/**
 * Shared HTTP layer of every OSM-related service: identification headers,
 * per-service rate limiting, request coalescing, response cache with TTL,
 * timeouts, retries that honor Retry-After, and per-caller abort.
 */
import {
  AbortError,
  BadResponseError,
  HttpError,
  NetworkError,
  OsmError,
  RateLimitedError,
  TimeoutError,
  isAbortError,
} from '../errors.ts';
import type { FetchLike, RequestOptions } from '../types.ts';
import { raceAbort, throwIfAborted } from './abort.ts';
import type { CacheEntry, OsmCache } from './cache.ts';
import { MemoryCache } from './cache.ts';
import { type Clock, type RateLimit, RateLimiter, realClock } from './limiter.ts';

export type ServiceId = 'overpass' | 'photon' | 'nominatim' | 'commons' | 'wikidata' | 'panoramax' | 'osmApi';

/**
 * Default client-side limits, chosen from each service's usage policy:
 * - Nominatim (OSMF): "an absolute maximum of 1 request per second", no parallel requests.
 * - Overpass (overpass-api.de): about 2 slots per IP, short queries; we keep 1 in flight.
 * - OSM API: editing API, read-only use must stay light; 1 request per second.
 * - Photon (komoot public instance): fair use, made for search-as-you-type.
 * - Wikimedia APIs: serial requests are asked for ("make your requests in series").
 * - Panoramax: no published limit; we stay modest.
 */
export const DEFAULT_RATE_LIMITS: Record<ServiceId, RateLimit> = {
  overpass: { minIntervalMs: 1000, maxConcurrent: 1 },
  photon: { minIntervalMs: 200, maxConcurrent: 2 },
  nominatim: { minIntervalMs: 1100, maxConcurrent: 1 },
  commons: { minIntervalMs: 0, maxConcurrent: 1 },
  wikidata: { minIntervalMs: 0, maxConcurrent: 1 },
  panoramax: { minIntervalMs: 250, maxConcurrent: 2 },
  osmApi: { minIntervalMs: 1000, maxConcurrent: 1 },
};

export interface ClientIdentity {
  /**
   * Identifying User-Agent, e.g. `TrianguLair/0.1.0 (+https://github.com/…; contact@…)`.
   * Required by the Nominatim, Overpass, OSM tile/API and Wikimedia policies.
   * Build it with `buildUserAgent`.
   */
  userAgent: string;
  /** Sent as `Referer` on native platforms (the browser sets its own on the web). */
  referer?: string;
}

export interface HttpClientOptions {
  identity: ClientIdentity;
  fetch?: FetchLike;
  /**
   * `native` (React Native, Node): sends `User-Agent` and `Referer` headers.
   * `web`: browsers refuse or drop those headers (and a custom User-Agent
   * would trigger CORS preflights some services reject), so the browser's own
   * Referer identifies the page and Wikimedia gets `Api-User-Agent`.
   * Default: detected.
   */
  platform?: 'native' | 'web';
  cache?: OsmCache;
  rateLimits?: Partial<Record<ServiceId, RateLimit>>;
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number;
  /** Retries on 429/502/503/504 and network errors. Default 1. */
  maxRetries?: number;
  /** Cap on a single retry wait (Retry-After included). Default 15 s. */
  maxRetryDelayMs?: number;
  /** Serve an expired cache entry when the network fails. Default true. */
  staleIfError?: boolean;
  clock?: Clock;
}

export interface HttpRequest {
  service: ServiceId;
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Cache lifetime; 0 disables caching for this request. */
  ttlMs: number;
  /** Statuses returned as a result (data null) instead of thrown, e.g. 410 Gone on the OSM API. */
  acceptStatus?: number[];
  /** Override `maxRetries` for this request (used for endpoint failover). */
  retries?: number;
  /**
   * Cache and coalescing key; defaults to method + URL + body. Overpass sets
   * one without the endpoint, so a failover result is found again later.
   */
  key?: string;
  /** Checks the parsed body before it is cached; throwing rejects (and does not cache) it. */
  validate?: (data: unknown) => void;
}

export interface HttpResult<T> {
  status: number;
  data: T | null;
  fromCache: boolean;
  /** True when an expired cache entry was served because the network failed. */
  stale: boolean;
}

interface Shared {
  promise: Promise<HttpResult<unknown>>;
  controller: AbortController;
  subscribers: number;
}

export function detectPlatform(): 'native' | 'web' {
  const g = globalThis as { navigator?: { product?: string }; document?: unknown };
  if (g.navigator?.product === 'ReactNative') return 'native';
  if (typeof g.document !== 'undefined') return 'web';
  return 'native';
}

/** Parses a Retry-After header (seconds or HTTP date) into ms from `now`. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const s = value.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - now);
}

const RETRIABLE_STATUS = new Set([429, 502, 503, 504]);

export class HttpClient {
  readonly identity: ClientIdentity;
  readonly platform: 'native' | 'web';
  readonly cache: OsmCache;
  readonly clock: Clock;
  private readonly fetchFn: FetchLike;
  private readonly rateLimits: Record<ServiceId, RateLimit>;
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly inflight = new Map<string, Shared>();
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly staleIfError: boolean;

  constructor(options: HttpClientOptions) {
    validateUserAgent(options.identity.userAgent);
    this.identity = options.identity;
    if (!options.fetch && typeof globalThis.fetch !== 'function') {
      throw new OsmError('invalid_argument', 'No fetch implementation available');
    }
    // Keep `this` unbound: some platforms' fetch throws when called as a method.
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.platform = options.platform ?? detectPlatform();
    this.cache = options.cache ?? new MemoryCache();
    this.clock = options.clock ?? realClock;
    this.rateLimits = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 15_000;
    this.staleIfError = options.staleIfError ?? true;
  }

  /** The limiter of a service at an origin (one per endpoint, so failover endpoints do not share a budget). */
  limiter(service: ServiceId, url: string): RateLimiter {
    const key = `${service}|${originOf(url)}`;
    let l = this.limiters.get(key);
    if (!l) {
      l = new RateLimiter(this.rateLimits[service], this.clock);
      this.limiters.set(key, l);
    }
    return l;
  }

  /** Number of distinct requests currently in flight (after coalescing). */
  get inflightCount(): number {
    return this.inflight.size;
  }

  async getJson<T>(req: HttpRequest, opts: RequestOptions = {}): Promise<T> {
    const r = await this.request<T>(req, opts);
    if (r.data === null) throw new BadResponseError(`Empty response from ${req.url}`);
    return r.data;
  }

  async request<T>(req: HttpRequest, opts: RequestOptions = {}): Promise<HttpResult<T>> {
    throwIfAborted(opts.signal);
    const key = cacheKey(req);
    const mode = opts.cache ?? 'default';
    const useCache = req.ttlMs > 0 && mode !== 'no-store';

    let cached: CacheEntry | undefined;
    if (useCache) {
      cached = await this.cache.get(key);
      if (cached && mode === 'default' && cached.expiresAt > this.clock.now()) {
        const v = cached.value as { status: number; data: T | null };
        return { status: v.status, data: v.data, fromCache: true, stale: false };
      }
    }

    let shared = this.inflight.get(key);
    if (!shared) {
      const controller = new AbortController();
      const promise = this.fetchWithRetries(req, controller.signal).then(async (r) => {
        if (r.data !== null) req.validate?.(r.data);
        if (useCache) {
          const now = this.clock.now();
          await this.cache.set(key, {
            value: { status: r.status, data: r.data },
            storedAt: now,
            expiresAt: now + req.ttlMs,
          });
        }
        return r;
      });
      const s: Shared = { promise, controller, subscribers: 0 };
      shared = s;
      this.inflight.set(key, s);
      // The shared promise is always awaited through raceAbort; avoid unhandled rejections.
      promise.catch(() => {}).finally(() => {
        if (this.inflight.get(key) === s) this.inflight.delete(key);
      });
    }

    const s = shared;
    s.subscribers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      s.subscribers--;
      if (s.subscribers === 0 && this.inflight.get(key) === s) {
        // Nobody wants this response any more: cancel it.
        s.controller.abort();
        this.inflight.delete(key);
      }
    };
    const onAbort = () => release();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return (await raceAbort(s.promise, opts.signal)) as HttpResult<T>;
    } catch (e) {
      if (isAbortError(e) || opts.signal?.aborted) throw new AbortError();
      if (this.staleIfError && cached && isServiceFailure(e)) {
        const v = cached.value as { status: number; data: T | null };
        return { status: v.status, data: v.data, fromCache: true, stale: true };
      }
      throw e;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      if (!released) {
        released = true;
        s.subscribers--;
      }
    }
  }

  private headersFor(req: HttpRequest): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', ...req.headers };
    if (req.contentType) h['Content-Type'] = req.contentType;
    if (this.platform === 'native') {
      h['User-Agent'] = this.identity.userAgent;
      if (this.identity.referer) h['Referer'] = this.identity.referer;
    } else if (req.service === 'commons' || req.service === 'wikidata') {
      // Wikimedia's documented substitute for User-Agent in browsers (CORS-allowed).
      h['Api-User-Agent'] = this.identity.userAgent;
    }
    return h;
  }

  private async fetchWithRetries(req: HttpRequest, signal: AbortSignal): Promise<HttpResult<unknown>> {
    const limiter = this.limiter(req.service, req.url);
    const retries = req.retries ?? this.maxRetries;
    for (let attempt = 0; ; attempt++) {
      try {
        return await limiter.run(() => this.fetchOnce(req, signal), signal);
      } catch (e) {
        if (isAbortError(e)) throw e;
        const retriable =
          e instanceof NetworkError ||
          e instanceof TimeoutError ||
          (e instanceof HttpError && RETRIABLE_STATUS.has(e.status));
        if (e instanceof RateLimitedError || (e instanceof HttpError && RETRIABLE_STATUS.has(e.status))) {
          const wait = (e as RateLimitedError).retryAfterMs ?? backoff(attempt);
          limiter.pauseUntil(this.clock.now() + Math.min(wait, this.maxRetryDelayMs));
        }
        if (!retriable || attempt >= retries) throw e;
        if (e instanceof NetworkError || e instanceof TimeoutError) {
          await this.clock.sleep(Math.min(backoff(attempt), this.maxRetryDelayMs), signal);
        }
      }
    }
  }

  private async fetchOnce(req: HttpRequest, outer: AbortSignal): Promise<HttpResult<unknown>> {
    throwIfAborted(outer);
    const controller = new AbortController();
    const onOuter = () => controller.abort();
    outer.addEventListener('abort', onOuter, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchFn(req.url, {
          method: req.method ?? 'GET',
          headers: this.headersFor(req),
          body: req.body,
          signal: controller.signal,
        });
      } catch (e) {
        if (outer.aborted) throw new AbortError();
        if (timedOut) throw new TimeoutError(req.url, this.timeoutMs);
        throw new NetworkError(req.url, e);
      }
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        if (outer.aborted) throw new AbortError();
        if (timedOut) throw new TimeoutError(req.url, this.timeoutMs);
        throw new NetworkError(req.url, e);
      }
      if (req.acceptStatus?.includes(res.status)) {
        return { status: res.status, data: null, fromCache: false, stale: false };
      }
      if (res.status === 429) {
        throw new RateLimitedError(
          429,
          req.url,
          text.slice(0, 500),
          parseRetryAfter(res.headers.get('Retry-After'), this.clock.now()),
        );
      }
      if (!res.ok) {
        const retryAfter = parseRetryAfter(res.headers.get('Retry-After'), this.clock.now());
        if (res.status === 503 && retryAfter !== undefined) {
          throw new RateLimitedError(503, req.url, text.slice(0, 500), retryAfter);
        }
        throw new HttpError(res.status, req.url, text.slice(0, 500));
      }
      if (text.trim() === '') return { status: res.status, data: null, fromCache: false, stale: false };
      try {
        return { status: res.status, data: JSON.parse(text) as unknown, fromCache: false, stale: false };
      } catch (e) {
        throw new BadResponseError(`Invalid JSON from ${req.url}: ${text.slice(0, 120)}`, { cause: e });
      }
    } finally {
      clearTimeout(timer);
      outer.removeEventListener('abort', onOuter);
    }
  }
}

function backoff(attempt: number): number {
  return 1000 * 2 ** attempt;
}

function originOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.exec(url);
  return m ? m[0].toLowerCase() : url;
}

function cacheKey(req: HttpRequest): string {
  if (req.key) return req.key;
  return `${req.method ?? 'GET'} ${req.url}${req.body ? `\n${req.body}` : ''}`;
}

/** Failures for which a stale cached copy is better than nothing. */
function isServiceFailure(e: unknown): boolean {
  if (e instanceof NetworkError || e instanceof TimeoutError || e instanceof RateLimitedError) return true;
  if (e instanceof HttpError) return e.status >= 500;
  return false;
}

/**
 * Builds an identifying User-Agent as the OSMF and Wikimedia policies ask:
 * application name and version, plus a way to contact the maintainers.
 */
export function buildUserAgent(app: { name: string; version: string; contact: string }): string {
  return `${app.name}/${app.version} (${app.contact})`;
}

const STOCK_AGENTS = /^(mozilla|node|undici|okhttp|axios|python|curl|wget|java|go-http|cfnetwork|dart|react-native)\b/i;

/**
 * Refuses empty or stock User-Agents (both Nominatim and Wikimedia block
 * them), and agents with no contact (URL or e-mail).
 */
export function validateUserAgent(ua: string): void {
  const s = ua?.trim() ?? '';
  if (!s) throw new OsmError('invalid_argument', 'An identifying User-Agent is required');
  if (STOCK_AGENTS.test(s)) throw new OsmError('invalid_argument', `Stock User-Agent refused: ${s}`);
  if (!/https?:\/\/|@/.test(s)) {
    throw new OsmError('invalid_argument', 'The User-Agent must include a contact (URL or e-mail)');
  }
}
