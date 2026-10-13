import { AwsClient } from 'aws4fetch';
import { PreconditionFailed, ProtocolError } from './errors.ts';
import type {
  Capabilities,
  DeleteOptions,
  FetchLike,
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
  httpError,
  normEtag,
  resolveFetch,
  sortEntries,
  toHex,
  xmlElements,
  xmlText,
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
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * S3 adapter over `fetch` + SigV4 (aws4fetch, which uses WebCrypto
 * `crypto.subtle`). Conditional PUT via `If-Match` / `If-None-Match: *`.
 */
export class S3Adapter implements StorageAdapter {
  readonly capabilities: Capabilities;
  private readonly client: AwsClient;
  private readonly fetch: FetchLike;
  private readonly bucketUrl: string;
  private readonly keyPrefix: string;
  private readonly nativeConditional: boolean;

  constructor(opts: S3Options) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
      service: 's3',
      region: opts.region,
      retries: 0,
    });
    this.fetch = resolveFetch(opts.fetch);
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
    let signed: Request;
    try {
      if (body) {
        headers['x-amz-content-sha256'] = toHex(await crypto.subtle.digest('SHA-256', body));
      }
      signed = await this.client.sign(url, { method, headers, ...(body ? { body } : {}) });
    } catch (e) {
      throw new ProtocolError(`SigV4 signing failed: ${(e as Error).message}`, { path, cause: e });
    }
    return doFetch(this.fetch, url, signed, path);
  }

  async get(path: string): Promise<GetResult | null> {
    checkPath(path);
    const res = await this.send(this.objectUrl(path), 'GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(res, `GET ${path}`, path);
    const data = new Uint8Array(await res.arrayBuffer());
    const etag = res.headers.get('etag');
    if (!etag) throw new ProtocolError(`GET ${path}: no ETag`, { path });
    return { data, etag: normEtag(etag) };
  }

  async head(path: string): Promise<HeadResult | null> {
    checkPath(path);
    const res = await this.send(this.objectUrl(path), 'HEAD', path);
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(res, `HEAD ${path}`, path);
    const etag = res.headers.get('etag');
    if (!etag) throw new ProtocolError(`HEAD ${path}: no ETag`, { path });
    return { etag: normEtag(etag), size: Number(res.headers.get('content-length') ?? 0) };
  }

  private async emulateCheck(path: string, ifMatch?: string, ifNoneMatch?: '*'): Promise<void> {
    if (ifMatch === undefined && ifNoneMatch === undefined) return;
    const cur = await this.head(path);
    if (ifNoneMatch === '*' && cur) throw new PreconditionFailed(path, { detail: 'exists (emulated)' });
    if (ifMatch !== undefined && cur?.etag !== ifMatch) throw new PreconditionFailed(path, { detail: 'emulated' });
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
    if (!res.ok) throw httpError(res, `PUT ${path}`, path);
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
    if (!res.ok) throw httpError(res, `DELETE ${path}`, path);
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
      if (!res.ok) throw httpError(res, `LIST ${prefix}`, prefix);
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
