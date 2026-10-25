/**
 * Typed errors of the OSM client. Every service failure is mapped onto one of
 * these classes so the app can show the right message (offline, rate limited,
 * service down) whatever the service.
 */

export type OsmErrorCode =
  | 'aborted'
  | 'timeout'
  | 'network'
  | 'http'
  | 'rate_limited'
  | 'bad_response'
  | 'invalid_argument';

export class OsmError extends Error {
  readonly code: OsmErrorCode;
  constructor(code: OsmErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OsmError';
    this.code = code;
  }
}

/** The caller aborted the request (its AbortSignal fired). */
export class AbortError extends OsmError {
  constructor(message = 'The request was aborted') {
    super('aborted', message);
    this.name = 'AbortError';
  }
}

export class TimeoutError extends OsmError {
  constructor(url: string, ms: number) {
    super('timeout', `Request to ${url} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

export class NetworkError extends OsmError {
  constructor(url: string, cause: unknown) {
    super('network', `Network error for ${url}`, { cause });
    this.name = 'NetworkError';
  }
}

export class HttpError extends OsmError {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string, code: OsmErrorCode = 'http') {
    super(code, `HTTP ${status} from ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** 429 (or Overpass 504 "server too busy"): the service asks us to slow down. */
export class RateLimitedError extends HttpError {
  /** Milliseconds the service asked us to wait, when it said so. */
  readonly retryAfterMs: number | undefined;
  constructor(status: number, url: string, body: string, retryAfterMs: number | undefined) {
    super(status, url, body, 'rate_limited');
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** The service answered, but not with what we expected (bad JSON, Overpass runtime error…). */
export class BadResponseError extends OsmError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('bad_response', message, options);
    this.name = 'BadResponseError';
  }
}

export class InvalidArgumentError extends OsmError {
  constructor(message: string) {
    super('invalid_argument', message);
    this.name = 'InvalidArgumentError';
  }
}

/** True for our AbortError and for platform AbortErrors (DOMException or RN polyfills). */
export function isAbortError(e: unknown): boolean {
  return (
    e instanceof AbortError ||
    (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError')
  );
}
