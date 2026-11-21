import {
  AuthError,
  InvalidPath,
  NetworkError,
  PreconditionFailed,
  ProtocolError,
  QuotaExceeded,
  TimeoutError,
  TooLarge,
  type StorageError,
} from './errors.ts';
import type { FetchLike } from './types.ts';

/** Validate a relative storage path. Returns it unchanged. */
export function checkPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) throw new InvalidPath(String(path), 'empty');
  if (path.startsWith('/')) throw new InvalidPath(path, 'must be relative (no leading "/")');
  if (path.endsWith('/')) throw new InvalidPath(path, 'must name a file (no trailing "/")');
  if (path.includes('\\')) throw new InvalidPath(path, 'backslash not allowed');
  for (const seg of path.split('/')) {
    if (seg === '') throw new InvalidPath(path, 'empty segment');
    if (seg === '.' || seg === '..') throw new InvalidPath(path, 'dot segments not allowed');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(seg)) throw new InvalidPath(path, 'control characters not allowed');
  }
  return path;
}

/** Validate a list prefix: "" or a relative path fragment (may end with "/"). */
export function checkPrefix(prefix: string): string {
  if (prefix === '') return prefix;
  checkPath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
  return prefix;
}

/** Percent-encode each path segment. */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Ensure a base URL ends with "/". */
export function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** Normalise an ETag to quoted strong form when the server omitted quotes. */
export function normEtag(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"') || s.startsWith('W/"')) return s;
  return `"${s}"`;
}

export function parentDirs(path: string): string[] {
  const segs = path.split('/');
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join('/'));
  return out;
}

export function sortEntries<T extends { path: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** UTF-8 aware base64 (no dependency on btoa/Buffer, for Hermes). */
export function base64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]!;
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : B64[c & 63]!;
  }
  return out;
}

export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Copy to a fresh ArrayBuffer-backed Uint8Array (fetch bodies, isolation from caller mutation). */
export function copyBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out;
}

export function resolveFetch(f: FetchLike | undefined): FetchLike {
  if (f) return f;
  if (typeof globalThis.fetch !== 'function') throw new Error('No fetch available: pass `fetch` in adapter options');
  return globalThis.fetch.bind(globalThis);
}

/** Validates a `maxBytes` option (undefined = no limit). */
export function checkMaxBytes(maxBytes: number | undefined): number | undefined {
  if (maxBytes === undefined) return undefined;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer');
  return maxBytes;
}

/** The whole body; a connection cut while reading it is a NetworkError. */
async function wholeBody(res: Response, path: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new NetworkError(`Reading ${path} failed: ${(e as Error)?.message ?? e}`, { path, cause: e });
  }
}

/**
 * Reads a response body, refusing more than `maxBytes`: the announced
 * Content-Length is checked first, then the body is streamed and the read
 * cancelled as soon as the limit is passed. Without a readable stream (some
 * React Native fetch implementations), the whole body is read and checked
 * after the fact (the Content-Length check still applies).
 */
export async function readBody(res: Response, path: string, maxBytes: number | undefined): Promise<Uint8Array<ArrayBuffer>> {
  if (maxBytes === undefined) return wholeBody(res, path);
  const len = res.headers.get('content-length');
  if (len !== null && /^\d+$/.test(len.trim()) && Number(len) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new TooLarge(path, maxBytes, { size: Number(len) });
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const data = await wholeBody(res, path);
    if (data.byteLength > maxBytes) throw new TooLarge(path, maxBytes, { size: data.byteLength });
    return data;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TooLarge(path, maxBytes);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof TooLarge) throw e;
    throw new NetworkError(`Reading ${path} failed: ${(e as Error)?.message ?? e}`, { path, cause: e });
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/**
 * Default time an HTTP adapter waits for the response headers of one request
 * (an upload's headers come after the whole body is sent, so it is generous).
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Validates a `timeoutMs` option: undefined → default, 0 → none. */
export function checkTimeout(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('timeoutMs must be a non-negative number');
  return ms;
}

/**
 * Wraps a fetch so that a request with no response headers after `timeoutMs`
 * (> 0) is aborted and rejected with a `TimeoutError`. The race does not rely
 * on the fetch implementation honouring `signal` (older React Native builds
 * do not). Reading the body afterwards is not bounded by this timer.
 */
export function timedFetch(fetchFn: FetchLike, timeoutMs: number): FetchLike {
  if (!(timeoutMs > 0)) return fetchFn;
  return async (input, init = {}) => {
    const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TimeoutError(`${init.method ?? 'GET'}: no response after ${timeoutMs} ms`, timeoutMs));
        ctl?.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([fetchFn(input, ctl && !init.signal ? { ...init, signal: ctl.signal } : init), expired]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Run fetch, turning transport failures into NetworkError (and naming the path in a TimeoutError). */
export async function doFetch(fetchFn: FetchLike, url: string, init: RequestInit, path?: string): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (e) {
    if (e instanceof TimeoutError) {
      throw new TimeoutError(`${init.method ?? 'GET'} ${path ?? url}: no response after ${e.timeoutMs} ms`, e.timeoutMs, { path, cause: e });
    }
    throw new NetworkError(`Request failed: ${(e as Error)?.message ?? e}`, { path, cause: e });
  }
}

/**
 * Map a non-success HTTP status to a typed error. Callers handle 404 /
 * 304 themselves where they have a natural meaning.
 */
export function httpError(res: Response, what: string, path?: string): StorageError {
  const status = res.status;
  if (status === 401 || status === 403)
    return new AuthError(`${what}: HTTP ${status}`, { status, path });
  if (status === 412) return new PreconditionFailed(path ?? what, { status });
  // 507 Insufficient Storage (WebDAV quota, MinIO), 413 Content Too Large (upload limit).
  if (status === 507 || status === 413) return new QuotaExceeded(`${what}: HTTP ${status} (storage full or upload too large)`, { status, path });
  if (status >= 500 || status === 408 || status === 429)
    return new NetworkError(`${what}: HTTP ${status}`, { status, path });
  return new ProtocolError(`${what}: unexpected HTTP ${status}`, { status, path });
}

/**
 * Client-side emulation of If-Match / If-None-Match for servers that ignore
 * them: HEAD, compare, throw. NOT atomic: another writer can slip in between
 * the check and the write. Used only when the adapter is configured with
 * `conditionalWrites: false`.
 */
export async function emulatePrecondition(
  head: (path: string) => Promise<{ etag: string } | null>,
  path: string,
  ifMatch: string | undefined,
  ifNoneMatch: '*' | undefined,
): Promise<void> {
  if (ifMatch === undefined && ifNoneMatch === undefined) return;
  const cur = await head(path);
  if (ifNoneMatch === '*' && cur) throw new PreconditionFailed(path, { detail: 'exists (emulated)' });
  if (ifMatch !== undefined && cur?.etag !== ifMatch)
    throw new PreconditionFailed(path, { detail: cur ? 'etag mismatch (emulated)' : 'missing (emulated)' });
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Tiny namespace-prefix-agnostic XML helpers. Good enough for WebDAV
 * multistatus and S3 ListBucketResult; avoids needing DOMParser (absent in
 * React Native).
 */
export function xmlElements(xml: string, local: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${local}\\s*>`, 'g');
  const out: string[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1] ?? '');
  return out;
}

export function xmlText(xml: string, local: string): string | undefined {
  const v = xmlElements(xml, local)[0];
  return v === undefined ? undefined : decodeXmlEntities(v.trim());
}

export function xmlHasElement(xml: string, local: string): boolean {
  return new RegExp(`<(?:[\\w.-]+:)?${local}[\\s/>]`).test(xml);
}
