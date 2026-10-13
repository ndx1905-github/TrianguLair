import {
  AuthError,
  InvalidPath,
  NetworkError,
  PreconditionFailed,
  ProtocolError,
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

/** Run fetch, turning transport failures into NetworkError. */
export async function doFetch(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit | Request,
  path?: string,
): Promise<Response> {
  try {
    return init instanceof Request ? await fetchFn(init) : await fetchFn(url, init);
  } catch (e) {
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
  if (status >= 500 || status === 408 || status === 429)
    return new NetworkError(`${what}: HTTP ${status}`, { status, path });
  return new ProtocolError(`${what}: unexpected HTTP ${status}`, { status, path });
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
