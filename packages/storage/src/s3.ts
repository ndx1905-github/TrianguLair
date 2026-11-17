import { PreconditionFailed, ProtocolError, QuotaExceeded, type StorageError } from './errors.ts';
import { signV4, type SigV4Options } from './sigv4.ts';
import type {
  Capabilities,
  DeleteOptions,
  FetchLike,
  GetOptions,
  GetResult,
  HeadResult,
  ListEntry,
  PutOptions,
  StorageAdapter,
} from './types.ts';
import {
  checkPath,
  checkPrefix,
  copyBytes,
  doFetch,
  emulatePrecondition,
  httpError,
  normEtag,
  resolveFetch,
  timedFetch,
  checkTimeout,
  sortEntries,
  xmlElements,
  xmlText,
  checkMaxBytes,
  readBody,
} from './util.ts';

export interface S3Options {
  /** e.g. `https://s3.eu-west-3.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, `http://localhost:9000`. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Key prefix inside the bucket, e.g. `triangulair/alice/`. */
  prefix?: string;
  /** Path-style URLs (`endpoint/bucket/key`). Default true (MinIO, Garage, R2...). */
  pathStyle?: boolean;
  /**
   * Base URL friends use to GET objects anonymously (bucket/prefix with a
   * public-read policy, or a CDN in front). Defaults to none.
   */
  publicBaseUrl?: string;
  /**
   * Whether the provider enforces `If-Match` / `If-None-Match` on PUT/DELETE.
   * AWS S3 does (PUT since Aug/Nov 2024; DELETE on general purpose buckets
   * more recently). Set `false` for providers that silently ignore them: the
   * adapter then emulates with a HEAD check first (racy, best effort).
   * Use `probeConditionalWrites()` to find out. Default true.
   */
  conditionalWrites?: boolean;
  fetch?: FetchLike;
  /**
   * Time to wait for the response headers of each request, in ms (default
   * 120 000; 0: no limit). Past it the request is aborted and `TimeoutError`
   * (a retryable `NetworkError`) is thrown.
   */
  timeoutMs?: number;
}

/** S3 error codes meaning "no space" or "upload refused for its size" (AWS, MinIO, Ceph RGW, Garage). */
const QUOTA_CODES = new Set([
  'QuotaExceeded',
  'EntityTooLarge',
  'XMinioStorageFull',
  'XMinioAdminBucketQuotaExceeded',
  'InsufficientStorage',
  'StorageFull',
]);

/** Like `httpError`, but reads the S3 XML `<Code>` first (quota errors come as 400/403 on some providers). */
async function s3Error(res: Response, what: string, path: string): Promise<StorageError> {
  let code: string | undefined;
  try {
    code = xmlText((await res.text()).slice(0, 8192), 'Code');
  } catch {
    code = undefined;
  }
  if (code && QUOTA_CODES.has(code)) return new QuotaExceeded(`${what}: ${code}`, { status: res.status, path, serverCode: code });
  return httpError(res, what, path);
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * S3 adapter over `fetch` + SigV4 (`sigv4.ts`: pure JS on `@noble/hashes`,
 * so it also runs on Hermes, which has no WebCrypto). Conditional PUT via
 * `If-Match` / `If-None-Match: *`.
 */
export class S3Adapter implements StorageAdapter {
  readonly capabilities: Capabilities;
  private readonly signing: Omit<SigV4Options, 'datetime'>;
  private readonly fetch: FetchLike;
  private readonly bucketUrl: string;
  private readonly keyPrefix: string;
  private readonly nativeConditional: boolean;

  constructor(opts: S3Options) {
    this.signing = {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
      service: 's3',
      region: opts.region,
    };
    this.fetch = timedFetch(resolveFetch(opts.fetch), checkTimeout(opts.timeoutMs));
    const ep = new URL(opts.endpoint);
    const epBase = `${ep.protocol}//${ep.host}${ep.pathname.replace(/\/$/, '')}`;
    this.bucketUrl =
      opts.pathStyle === false
        ? `${ep.protocol}//${opts.bucket}.${ep.host}${ep.pathname.replace(/\/$/, '')}/`
        : `${epBase}/${rfc3986(opts.bucket)}/`;
    this.keyPrefix = opts.prefix ? opts.prefix.replace(/^\/+/, '').replace(/\/?$/, '/') : '';
    this.nativeConditional = opts.conditionalWrites ?? true;
    const pub = opts.publicBaseUrl ? opts.publicBaseUrl.replace(/\/?$/, '/') : undefined;
    this.capabilities = {
      readOnly: false,
      conditionalWrites: this.nativeConditional,
      list: true,
      publicUrl: (path) => (pub ? pub + checkPath(path).split('/').map(rfc3986).join('/') : null),
    };
  }

  private objectUrl(path: string): string {
    return this.bucketUrl + (this.keyPrefix + path).split('/').map(rfc3986).join('/');
  }

  private async send(
    url: string,
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: Uint8Array<ArrayBuffer>,
  ): Promise<Response> {
    let signed: ReturnType<typeof signV4>;
    try {
      // The payload hash is signed (x-amz-content-sha256); no body: UNSIGNED-PAYLOAD, as aws4fetch did.
      signed = signV4({ method, url, headers, ...(body ? { body } : {}) }, this.signing);
    } catch (e) {
      throw new ProtocolError(`SigV4 signing failed: ${(e as Error).message}`, { path, cause: e });
    }
    return doFetch(this.fetch, url, { method, headers: signed.headers, ...(body ? { body } : {}) }, path);
  }

  async get(path: string, opts: GetOptions = {}): Promise<GetResult | null> {
    const max = checkMaxBytes(opts.maxBytes);
    checkPath(path);
    const res = await this.send(this.objectUrl(path), 'GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw await s3Error(res, `GET ${path}`, path);
    const data = await readBody(res, path, max);
    const etag = res.headers.get('etag');
    if (!etag) throw new ProtocolError(`GET ${path}: no ETag`, { path });
    return { data, etag: normEtag(etag) };
  }

  async head(path: string): Promise<HeadResult | null> {
    checkPath(path);
    const res = await this.send(this.objectUrl(path), 'HEAD', path);
    if (res.status === 404) return null;
    if (!res.ok) throw await s3Error(res, `HEAD ${path}`, path);
    const etag = res.headers.get('etag');
    if (!etag) throw new ProtocolError(`HEAD ${path}: no ETag`, { path });
    return { etag: normEtag(etag), size: Number(res.headers.get('content-length') ?? 0) };
  }

  private emulateCheck(path: string, ifMatch?: string, ifNoneMatch?: '*'): Promise<void> {
    return emulatePrecondition((p) => this.head(p), path, ifMatch, ifNoneMatch);
  }

  async put(path: string, data: Uint8Array, opts: PutOptions = {}): Promise<{ etag: string }> {
    checkPath(path);
    const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'application/octet-stream' };
    if (!this.nativeConditional) await this.emulateCheck(path, opts.ifMatch, opts.ifNoneMatch);
    else {
      if (opts.ifMatch !== undefined) headers['if-match'] = opts.ifMatch;
      if (opts.ifNoneMatch === '*') headers['if-none-match'] = '*';
    }
    const res = await this.send(this.objectUrl(path), 'PUT', path, headers, copyBytes(data));
    // 412: mismatch. 409 ConditionalRequestConflict: concurrent conditional write.
    // 404 with If-Match: object does not exist.
    if (res.status === 412 || (res.status === 409 && (opts.ifMatch || opts.ifNoneMatch)))
      throw new PreconditionFailed(path, { status: res.status });
    if (res.status === 404 && opts.ifMatch !== undefined)
      throw new PreconditionFailed(path, { status: 404, detail: 'missing' });
    if (!res.ok) throw await s3Error(res, `PUT ${path}`, path);
    const etag = res.headers.get('etag');
    if (etag) return { etag: normEtag(etag) };
    const h = await this.head(path);
    if (!h) throw new ProtocolError(`PUT ${path} succeeded but object is missing`, { path });
    return { etag: h.etag };
  }

  async delete(path: string, opts: DeleteOptions = {}): Promise<void> {
    checkPath(path);
    const headers: Record<string, string> = {};
    if (opts.ifMatch !== undefined) {
      // Always pre-check: S3 DELETE of a missing key returns 204 even with If-Match
      // on some providers. The If-Match header is still sent for atomicity where supported.
      await this.emulateCheck(path, opts.ifMatch);
      if (this.nativeConditional) headers['if-match'] = opts.ifMatch;
    }
    const res = await this.send(this.objectUrl(path), 'DELETE', path, headers);
    if (res.status === 412 || (res.status === 404 && opts.ifMatch !== undefined))
      throw new PreconditionFailed(path, { status: res.status });
    if (res.status === 404) return;
    if (!res.ok) throw await s3Error(res, `DELETE ${path}`, path);
  }

  async list(prefix: string): Promise<ListEntry[]> {
    checkPrefix(prefix);
    const out: ListEntry[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix: this.keyPrefix + prefix });
      if (token) q.set('continuation-token', token);
      const url = `${this.bucketUrl}?${q.toString().replace(/\+/g, '%20')}`;
      const res = await this.send(url, 'GET', prefix);
      if (!res.ok) throw await s3Error(res, `LIST ${prefix}`, prefix);
      const xml = await res.text();
      for (const c of xmlElements(xml, 'Contents')) {
        const key = xmlText(c, 'Key');
        if (!key || !key.startsWith(this.keyPrefix) || key.endsWith('/')) continue;
        out.push({
          path: key.slice(this.keyPrefix.length),
          etag: normEtag(xmlText(c, 'ETag') ?? ''),
          size: Number(xmlText(c, 'Size') ?? 0),
        });
      }
      token = xmlText(xml, 'IsTruncated') === 'true' ? xmlText(xml, 'NextContinuationToken') : undefined;
    } while (token);
    return sortEntries(out);
  }
}
