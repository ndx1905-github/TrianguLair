import { ReadOnly, Unsupported } from './errors.ts';
import type {
  Capabilities,
  FetchLike,
  GetResult,
  HeadResult,
  ListEntry,
  StorageAdapter,
} from './types.ts';
import { checkPath, doFetch, encodePath, httpError, normEtag, resolveFetch, withSlash } from './util.ts';

export interface HttpsReadOnlyOptions {
  /** Base URL of the published folder; files are fetched at `baseUrl + path`. */
  baseUrl: string;
  fetch?: FetchLike;
  /** Extra headers (e.g. a share-link token). */
  headers?: Record<string, string>;
}

/**
 * Read-only adapter over plain HTTPS GET/HEAD. This is how friends read
 * someone else's published packs. Writes throw `ReadOnly`; `list` throws
 * `Unsupported` (enumerate via the signed index instead).
 *
 * If the server sends no ETag, a weak substitute is built from
 * Last-Modified + Content-Length (prefixed `W/"lm:`), good enough for
 * "skip if unchanged" but not for conditional writes (which are impossible here anyway).
 */
export class HttpsReadOnlyAdapter implements StorageAdapter {
  readonly capabilities: Capabilities;
  private readonly base: string;
  private readonly fetch: FetchLike;
  private readonly headers: Record<string, string>;

  constructor(opts: HttpsReadOnlyOptions) {
    this.base = withSlash(opts.baseUrl);
    this.fetch = resolveFetch(opts.fetch);
    this.headers = opts.headers ?? {};
    this.capabilities = {
      readOnly: true,
      conditionalWrites: false,
      list: false,
      publicUrl: (path) => this.url(path),
    };
  }

  private url(path: string): string {
    return this.base + encodePath(checkPath(path));
  }

  private etagOf(res: Response, size: number): string {
    const e = res.headers.get('etag');
    if (e) return normEtag(e);
    return `W/"lm:${res.headers.get('last-modified') ?? ''}:${size}"`;
  }

  async get(path: string): Promise<GetResult | null> {
    const url = this.url(path);
    const res = await doFetch(this.fetch, url, { method: 'GET', headers: this.headers, cache: 'no-store' }, path);
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw httpError(res, `GET ${path}`, path);
    const data = new Uint8Array(await res.arrayBuffer());
    return { data, etag: this.etagOf(res, data.byteLength) };
  }

  async head(path: string): Promise<HeadResult | null> {
    const url = this.url(path);
    const res = await doFetch(this.fetch, url, { method: 'HEAD', headers: this.headers, cache: 'no-store' }, path);
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw httpError(res, `HEAD ${path}`, path);
    const len = res.headers.get('content-length');
    if (len === null) {
      // Some servers/CDNs omit Content-Length on HEAD (chunked): fall back to GET.
      const g = await this.get(path);
      return g ? { etag: g.etag, size: g.data.byteLength } : null;
    }
    const size = Number(len);
    return { etag: this.etagOf(res, size), size };
  }

  async put(path: string): Promise<{ etag: string }> {
    checkPath(path);
    throw new ReadOnly(path);
  }

  async delete(path: string): Promise<void> {
    checkPath(path);
    throw new ReadOnly(path);
  }

  async list(_prefix: string): Promise<ListEntry[]> {
    throw new Unsupported('HTTPS read-only adapter cannot list; read the signed index instead');
  }
}
