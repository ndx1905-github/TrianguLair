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
  base64,
  checkPath,
  checkPrefix,
  copyBytes,
  doFetch,
  emulatePrecondition,
  encodePath,
  httpError,
  normEtag,
  parentDirs,
  resolveFetch,
  sortEntries,
  withSlash,
  xmlElements,
  xmlHasElement,
  xmlText,
} from './util.ts';

export type WebDavAuth = { username: string; password: string } | { bearer: string };

export interface WebDavOptions {
  /**
   * Collection URL acting as root, e.g.
   * `https://cloud.example/remote.php/dav/files/alice/TrianguLair/`.
   * It must already exist (we only create sub-collections).
   */
  baseUrl: string;
  auth?: WebDavAuth;
  fetch?: FetchLike;
  /**
   * Public read URL prefix for friends (e.g. a Nextcloud public share
   * `https://cloud.example/public.php/dav/files/<token>/`). `publicUrl()`
   * returns `null` when unset.
   */
  publicBaseUrl?: string;
  /**
   * Whether the server enforces `If-Match` / `If-None-Match` on PUT and
   * DELETE. Nextcloud (sabre/dav) does; some servers (e.g. the `webdav-server`
   * npm package, some NAS firmwares) silently ignore them. With `false` the
   * adapter emulates them with a HEAD first (racy, best effort) and reports
   * `capabilities.conditionalWrites === false`. Use `probeConditionalWrites()`
   * at setup time to find out. Default true.
   */
  conditionalWrites?: boolean;
  /**
   * Guard against coarse ETags. Nextcloud, WsgiDAV and many NAS servers derive
   * the ETag from (mtime in whole seconds, size): two same-size writes within
   * one second keep the SAME ETag, so readers and conditional writers cannot
   * see the change. With the guard on, `put` remembers the previous ETag
   * (from `ifMatch`, or a HEAD first) and, if the server returns it unchanged
   * after writing new content, writes again once the clock has ticked, until
   * the ETag changes. Costs one HEAD per unconditional write. Default true.
   */
  guardCoarseEtags?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>';

/**
 * WebDAV adapter (Nextcloud, ownCloud, Apache mod_dav, nginx-dav, rclone serve...).
 * Uses GET / HEAD / PUT / DELETE / MKCOL / PROPFIND (Depth: 1, walked
 * recursively because many servers disable Depth: infinity).
 * Conditional writes rely on the server honouring `If-Match` / `If-None-Match`
 * on PUT and DELETE (RFC 7232 / RFC 4918), which sabre/dav (Nextcloud) does.
 */
export class WebDavAdapter implements StorageAdapter {
  readonly capabilities: Capabilities;
  private readonly base: string;
  private readonly basePath: string;
  private readonly fetch: FetchLike;
  private readonly authHeader: string | undefined;
  private readonly nativeConditional: boolean;
  private readonly guard: boolean;

  constructor(opts: WebDavOptions) {
    this.base = withSlash(opts.baseUrl);
    this.basePath = decodeURIComponent(new URL(this.base).pathname);
    this.fetch = resolveFetch(opts.fetch);
    const a = opts.auth;
    this.authHeader = !a
      ? undefined
      : 'bearer' in a
        ? `Bearer ${a.bearer}`
        : `Basic ${base64(`${a.username}:${a.password}`)}`;
    const pub = opts.publicBaseUrl ? withSlash(opts.publicBaseUrl) : undefined;
    this.nativeConditional = opts.conditionalWrites ?? true;
    this.guard = opts.guardCoarseEtags ?? true;
    this.capabilities = {
      readOnly: false,
      conditionalWrites: this.nativeConditional,
      list: true,
      publicUrl: (path) => (pub ? pub + encodePath(checkPath(path)) : null),
    };
  }

  private url(path: string): string {
    return this.base + encodePath(path);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.authHeader ? { Authorization: this.authHeader, ...extra } : extra;
  }

  private req(path: string, method: string, init: RequestInit = {}, extra: Record<string, string> = {}) {
    return doFetch(this.fetch, this.url(path), { ...init, method, headers: this.headers(extra) }, path);
  }

  async get(path: string): Promise<GetResult | null> {
    checkPath(path);
    const res = await this.req(path, 'GET', { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(res, `GET ${path}`, path);
    const data = new Uint8Array(await res.arrayBuffer());
    const etag = res.headers.get('etag');
    if (etag) return { data, etag: normEtag(etag) };
    const h = await this.head(path);
    if (!h) return null;
    return { data, etag: h.etag };
  }

  async head(path: string): Promise<HeadResult | null> {
    checkPath(path);
    const res = await this.req(path, 'HEAD', { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(res, `HEAD ${path}`, path);
    let etag = res.headers.get('etag');
    let size = Number(res.headers.get('content-length') ?? NaN);
    if (!etag || Number.isNaN(size)) {
      // Fall back to PROPFIND Depth: 0 (some servers omit ETag on HEAD).
      const p = await this.propfind(path, '0');
      const own = p?.[0];
      if (!own || own.dir) return null;
      etag = own.etag;
      size = own.size;
    }
    return { etag: normEtag(etag), size };
  }

  async put(path: string, data: Uint8Array, opts: PutOptions = {}): Promise<{ etag: string }> {
    checkPath(path);
    let prev = opts.ifMatch;
    if (this.guard && prev === undefined && opts.ifNoneMatch !== '*') prev = (await this.head(path))?.etag;
    const first = await this.rawPut(path, data, opts);
    if (!this.guard || prev === undefined || first.etag !== prev) return first;
    // Coarse ETag: the content changed but the ETag did not. Rewrite the same
    // bytes once the server's timestamp has moved on, guarded by the ETag we
    // just got so we never clobber a concurrent writer.
    let current = first.etag;
    for (let i = 0; i < 3; i++) {
      await sleep(1100);
      const again = await this.rawPut(path, data, { contentType: opts.contentType, ifMatch: current });
      if (again.etag !== prev) return again;
      current = again.etag;
    }
    throw new ProtocolError(`PUT ${path}: server ETag does not change on overwrite`, { path });
  }

  private async rawPut(path: string, data: Uint8Array, opts: PutOptions): Promise<{ etag: string }> {
    const cond: Record<string, string> = { 'Content-Type': opts.contentType ?? 'application/octet-stream' };
    // A weak ETag (Apache marks files modified in the last second as W/"…")
    // never matches If-Match, which uses strong comparison (RFC 9110 13.1.1):
    // fall back to the emulated check for that request.
    const weak = opts.ifMatch?.startsWith('W/') ?? false;
    if (!this.nativeConditional || weak) {
      await emulatePrecondition((p) => this.head(p), path, opts.ifMatch, opts.ifNoneMatch);
    } else {
      if (opts.ifMatch !== undefined) cond['If-Match'] = opts.ifMatch;
      if (opts.ifNoneMatch === '*') cond['If-None-Match'] = '*';
    }
    const body = copyBytes(data);
    let res = await this.req(path, 'PUT', { body }, cond);
    if (res.status === 409 || res.status === 404) {
      // Parent collection (or the storage root itself) missing: create, then retry once.
      await this.ensureRoot();
      if (path.includes('/')) await this.mkcols(path);
      res = await this.req(path, 'PUT', { body }, cond);
    }
    if (res.status === 412) throw new PreconditionFailed(path, { status: 412 });
    if (!res.ok) throw httpError(res, `PUT ${path}`, path);
    // Nextcloud returns ETag (and OC-ETag) on PUT. If the server does not,
    // fall back to HEAD; this is racy (another writer could slip in between),
    // which only affects the *next* conditional write, which would then fail safely.
    const etag = res.headers.get('etag') ?? res.headers.get('oc-etag');
    if (etag) return { etag: normEtag(etag) };
    const h = await this.head(path);
    if (!h) throw new ProtocolError(`PUT ${path} succeeded but object is missing`, { path });
    return { etag: h.etag };
  }

  private rootReady = false;

  /**
   * Create the base collection (e.g. `.../files/alice/triangulair/`) and any
   * missing ancestors. Ancestors above it may legitimately refuse MKCOL
   * (`/remote.php/` on Nextcloud): only the base itself must end up existing.
   */
  private async ensureRoot(): Promise<void> {
    if (this.rootReady) return;
    const u = new URL(this.base);
    const segs = u.pathname.split('/').filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      const url = `${u.origin}/${segs.slice(0, i).join('/')}/`;
      const res = await doFetch(this.fetch, url, { method: 'MKCOL', headers: this.headers() }, '');
      if (i === segs.length && !(res.ok || res.status === 405 || res.status === 301)) {
        if (!(await this.propfind('', '0'))?.[0]) throw httpError(res, 'MKCOL <root>', '');
      }
    }
    this.rootReady = true;
  }

  private async mkcols(path: string): Promise<void> {
    for (const dir of parentDirs(path)) {
      const res = await doFetch(
        this.fetch,
        `${this.url(dir)}/`,
        { method: 'MKCOL', headers: this.headers() },
        dir,
      );
      // 201 created; 405 already exists (RFC 4918 9.3.1); some servers answer 301.
      if (res.ok || res.status === 405 || res.status === 301) continue;
      // Concurrent MKCOL of the same collection (parallel pack uploads) may fail
      // on some servers: accept if it exists now.
      if ((await this.propfind(dir, '0'))?.[0]?.dir) continue;
      throw httpError(res, `MKCOL ${dir}`, dir);
    }
  }

  async delete(path: string, opts: DeleteOptions = {}): Promise<void> {
    checkPath(path);
    const extra: Record<string, string> = {};
    if (opts.ifMatch !== undefined) {
      if (this.nativeConditional && !opts.ifMatch.startsWith('W/')) extra['If-Match'] = opts.ifMatch;
      else await emulatePrecondition((p) => this.head(p), path, opts.ifMatch, undefined);
    }
    const res = await this.req(path, 'DELETE', {}, extra);
    if (res.status === 404) {
      if (opts.ifMatch !== undefined) throw new PreconditionFailed(path, { status: 404, detail: 'missing' });
      return;
    }
    if (res.status === 412) throw new PreconditionFailed(path, { status: 412 });
    if (!res.ok) throw httpError(res, `DELETE ${path}`, path);
  }

  async list(prefix: string): Promise<ListEntry[]> {
    checkPrefix(prefix);
    const slash = prefix.lastIndexOf('/');
    const startDir = slash >= 0 ? prefix.slice(0, slash) : '';
    const out: ListEntry[] = [];
    const queue = [startDir];
    while (queue.length) {
      const dir = queue.shift()!;
      const entries = await this.propfind(dir, '1');
      if (!entries) continue;
      for (const e of entries) {
        if (e.rel === dir) continue; // the collection itself
        if (e.dir) {
          // Only descend into directories that can contain matches.
          const d = `${e.rel}/`;
          if (d.startsWith(prefix) || prefix.startsWith(d)) queue.push(e.rel);
        } else if (e.rel.startsWith(prefix)) {
          out.push({ path: e.rel, etag: normEtag(e.etag), size: e.size });
        }
      }
    }
    return sortEntries(out);
  }

  /** PROPFIND on a collection or file. Returns null on 404. */
  private async propfind(
    dir: string,
    depth: '0' | '1',
  ): Promise<{ rel: string; dir: boolean; etag: string; size: number }[] | null> {
    const url = dir === '' ? this.base : `${this.url(dir)}${depth === '1' ? '/' : ''}`;
    const res = await doFetch(
      this.fetch,
      url,
      {
        method: 'PROPFIND',
        headers: this.headers({ Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }),
        body: PROPFIND_BODY,
      },
      dir,
    );
    if (res.status === 404) return null;
    if (res.status !== 207 && !res.ok) throw httpError(res, `PROPFIND ${dir || '/'}`, dir);
    const xml = await res.text();
    const out = [];
    for (const r of xmlElements(xml, 'response')) {
      const href = xmlText(r, 'href');
      if (!href) continue;
      // Pick the 200 propstat (ignore 404 propstat for unknown props).
      const ok = xmlElements(r, 'propstat').find((ps) => /\s200\s/.test(xmlText(ps, 'status') ?? ''));
      const props = ok ?? r;
      let p = decodeURIComponent(new URL(href, this.base).pathname);
      if (!p.startsWith(this.basePath)) {
        if (`${p}/` === this.basePath) p = this.basePath;
        else continue;
      }
      const rel = p.slice(this.basePath.length).replace(/\/$/, '');
      const isDir = xmlHasElement(xmlElements(props, 'resourcetype')[0] ?? '', 'collection');
      out.push({
        rel,
        dir: isDir,
        etag: xmlText(props, 'getetag') ?? '',
        size: Number(xmlText(props, 'getcontentlength') ?? 0),
      });
    }
    return out;
  }
}
