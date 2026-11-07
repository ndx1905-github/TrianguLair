/**
 * "Test connection" (spec "Later, at the right moment": full test before validation — write,
 * read, delete a test file, and check that the read address responds from the outside).
 *
 * Steps, each reported as ok / warn / fail / skip with the fixes to show:
 * 1. `reach`       the write endpoint answers with these credentials (HEAD index.json);
 *                  on the web, a transport failure is told apart: server down vs CORS.
 * 2. `write`       a test file is written (creating the folder), read back byte for byte, deleted.
 * 3. `conditional` `probeConditionalWrites`: does the server enforce If-Match / If-None-Match?
 *                  If not, the adapter emulates them (racy; storage README) and the config says so.
 * 4. `publicRead`  a second test file is read **anonymously** at the read address (no
 *                  credentials, as a friend would); 401/403, 404, CORS and "other content" each
 *                  get their fix (Nextcloud share link, S3 bucket policy, CORS headers).
 * 5. `etag`        (web only) the read address exposes `ETag` to scripts, else friends on the
 *                  web download the index every time.
 * 6. `certifiable` the read address can be certified (`checkLocation`: public https).
 * 7. `existing`    an `index.json` already there (my content from another device, or someone
 *                  else's folder): information for the wizard.
 *
 * HTTPS-only mode runs `reach` (anonymous GET of index.json), `etag` and `certifiable`.
 */
import { AuthError, NetworkError, StorageError, probeConditionalWrites, type FetchLike, type StorageAdapter } from '@triangulair/storage';

import { readAdapter, writeAdapter } from './adapters';
import { readUrlProblem, type StorageConfig } from './config';
import { readCorsHeaders, s3CorsRules, s3PublicReadPolicy, webDavCorsApache, webDavCorsNginx } from './fixes';

export type StepId = 'reach' | 'write' | 'conditional' | 'publicRead' | 'etag' | 'certifiable' | 'existing';
export type StepStatus = 'running' | 'ok' | 'warn' | 'fail' | 'skip';

/** A fix: i18n `storage.fix.<id>` (with params), and optional text to copy. */
export interface Fix {
  id: string;
  params?: Record<string, string>;
  copy?: string;
}

export interface TestStep {
  id: StepId;
  status: StepStatus;
  /** i18n key suffix: `storage.test.<id>.<outcome>`. */
  outcome: string;
  /** Technical detail shown small ("HTTP 403"). Never contains credentials. */
  detail?: string;
  fixes: Fix[];
}

export interface TestReport {
  steps: TestStep[];
  /** No step failed: the storage can be used. */
  ok: boolean;
  /** Probe result to keep in the config (null: not probed). */
  conditionalWrites: boolean | null;
  /** index.json already at the write side or read address. */
  hasIndex: boolean;
  at: number;
}

export interface TestOptions {
  fetch?: FetchLike;
  /** 'web': CORS applies (the browser), so transport errors are diagnosed further. */
  platform: 'web' | 'native';
  /** The app's origin on the web ("http://127.0.0.1:4319"), for the CORS snippets. */
  origin?: string | null;
  onStep?: (steps: TestStep[]) => void;
  /** Injected in tests (memory adapters). */
  makeWriteAdapter?: (c: StorageConfig, conditionalWrites: boolean) => StorageAdapter;
  signal?: AbortSignal;
  /** Random suffix of the test files (tests). */
  random?: () => string;
  now?: () => number;
}

const TEST_PREFIX = '.triangulair-test-';

/** Test files the app may leave behind if a test is interrupted; never copied by a migration. */
export function isScratchPath(path: string): boolean {
  return path.startsWith(TEST_PREFIX) || path.startsWith('.triangulair-probe-');
}

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function httpDetail(e: unknown): string {
  if (e instanceof StorageError) return e.status ? `HTTP ${e.status}` : e.code;
  if (e instanceof Error) return e.name;
  return 'error';
}

/** On the web: a request the browser refuses for CORS still reaches the server in `no-cors` mode. */
async function reachableNoCors(fetchFn: FetchLike, url: string): Promise<boolean> {
  try {
    await fetchFn(url, { method: 'GET', mode: 'no-cors', credentials: 'omit', cache: 'no-store' });
    return true;
  } catch {
    return false;
  }
}

function writeUrl(c: StorageConfig): string {
  if (c.kind === 'webdav') return c.url;
  if (c.kind === 's3') return c.endpoint;
  return c.readUrl;
}

function writeCorsFixes(c: StorageConfig, origin: string): Fix[] {
  if (c.kind === 's3') return [{ id: 's3Cors', copy: s3CorsRules(origin) }];
  const fixes: Fix[] = [];
  if (c.kind === 'webdav' && c.flavor === 'nextcloud') fixes.push({ id: 'nextcloudCors' });
  fixes.push({ id: 'webdavCorsApache', copy: webDavCorsApache(origin) }, { id: 'webdavCorsNginx', copy: webDavCorsNginx(origin) });
  return fixes;
}

function notPublicFixes(c: StorageConfig): Fix[] {
  if (c.kind === 'webdav' && c.flavor === 'nextcloud') return [{ id: 'nextcloudShare', params: { folder: 'TrianguLair' } }];
  if (c.kind === 's3') return [{ id: 's3Policy', params: { bucket: c.bucket, prefix: c.prefix }, copy: s3PublicReadPolicy(c.bucket, c.prefix) }, { id: 's3BlockPublic' }];
  if (c.kind === 'webdav') return [{ id: 'webdavPublic' }];
  return [{ id: 'httpsPublish' }];
}

/** Runs every step; never throws (an unexpected error becomes a failed step). */
export async function runConnectionTest(config: StorageConfig, opts: TestOptions): Promise<TestReport> {
  const fetchFn: FetchLike = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const web = opts.platform === 'web';
  const origin = opts.origin ?? null;
  const r = opts.random ?? rand;
  const steps: TestStep[] = [];
  let conditionalWrites: boolean | null = null;
  let hasIndex = false;

  const emit = () => opts.onStep?.(steps.map((s) => ({ ...s, fixes: [...s.fixes] })));
  const begin = (id: StepId): TestStep => {
    const s: TestStep = { id, status: 'running', outcome: 'running', fixes: [] };
    steps.push(s);
    emit();
    return s;
  };
  const end = (s: TestStep, status: StepStatus, outcome: string, more: Partial<TestStep> = {}) => {
    Object.assign(s, { status, outcome }, more);
    emit();
  };
  const aborted = () => opts.signal?.aborted === true;

  // The read address first (cheap, pure): it decides whether friends can ever read.
  const certifiable = (): void => {
    const s = begin('certifiable');
    const p = readUrlProblem(config.readUrl);
    if (p) end(s, 'fail', p, { fixes: [{ id: config.kind === 'webdav' && config.flavor === 'nextcloud' ? 'nextcloudShare' : 'readUrlHttps', params: { folder: 'TrianguLair' } }] });
    else end(s, 'ok', 'ok');
  };

  // Anonymous GET at the read address of a file we know (or index.json in HTTPS mode).
  const publicRead = async (path: string, expected: Uint8Array | null): Promise<void> => {
    const s = begin(expected ? 'publicRead' : 'reach');
    const url = config.readUrl + path;
    let res: Response;
    try {
      res = await fetchFn(url, { method: 'GET', credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      if (web && (await reachableNoCors(fetchFn, url))) {
        end(s, 'fail', 'cors', { detail: 'CORS', fixes: [{ id: 'readCors', copy: readCorsHeaders() }, ...(config.kind === 's3' ? [{ id: 's3Cors', copy: s3CorsRules(origin) }] : [])] });
      } else {
        end(s, 'fail', 'unreachable', { detail: httpDetail(e), fixes: [{ id: 'checkAddress' }] });
      }
      return;
    }
    if (res.status === 401 || res.status === 403) return end(s, 'fail', 'notPublic', { detail: `HTTP ${res.status}`, fixes: notPublicFixes(config) });
    if (res.status === 404 || res.status === 410) {
      if (!expected) return end(s, 'warn', 'nothingPublished', { detail: `HTTP ${res.status}`, fixes: [{ id: 'httpsPublish' }] });
      return end(s, 'fail', 'otherFolder', { detail: `HTTP ${res.status}`, fixes: notPublicFixes(config) });
    }
    if (!res.ok) return end(s, 'fail', 'httpError', { detail: `HTTP ${res.status}`, fixes: [{ id: 'checkAddress' }] });
    const body = new Uint8Array(await res.arrayBuffer());
    if (expected && !equal(body, expected)) return end(s, 'fail', 'otherContent', { detail: `${body.length} B`, fixes: notPublicFixes(config) });
    if (!expected) hasIndex = true;
    end(s, 'ok', expected ? 'ok' : 'indexFound');
    if (web) {
      const e = begin('etag');
      if (res.headers.get('etag')) end(e, 'ok', 'ok');
      else end(e, 'warn', 'hidden', { fixes: [{ id: 'readCors', copy: readCorsHeaders() }] });
    }
  };

  try {
    if (config.kind === 'https') {
      await publicRead('index.json', null);
      certifiable();
      return report();
    }

    const make = (cw: boolean) => (opts.makeWriteAdapter ? opts.makeWriteAdapter(config, cw) : writeAdapter(config, { conditionalWrites: cw, ...(opts.fetch ? { fetch: opts.fetch } : {}) }));
    // The server is asked to enforce the conditions while probing.
    const adapter = make(true);

    // 1. reach
    const reach = begin('reach');
    try {
      const head = await adapter.head('index.json');
      hasIndex = head !== null;
      end(reach, 'ok', 'ok');
    } catch (e) {
      if (e instanceof AuthError) {
        end(reach, 'fail', 'auth', { detail: httpDetail(e), fixes: [{ id: config.kind === 's3' ? 's3Keys' : config.kind === 'webdav' && config.flavor === 'nextcloud' ? 'nextcloudAppPassword' : 'davCredentials' }] });
      } else if (e instanceof NetworkError && web && origin && (await reachableNoCors(fetchFn, writeUrl(config)))) {
        end(reach, 'fail', 'cors', { detail: 'CORS', fixes: writeCorsFixes(config, origin) });
      } else if (e instanceof NetworkError) {
        end(reach, 'fail', 'unreachable', { detail: httpDetail(e), fixes: [{ id: 'checkAddress' }] });
      } else {
        end(reach, 'fail', 'unexpected', { detail: httpDetail(e), fixes: [{ id: 'checkAddress' }] });
      }
      certifiable();
      return report();
    }
    if (aborted()) return report();

    // 2. write, read back, delete
    const w = begin('write');
    const testPath = `${TEST_PREFIX}${r()}.bin`;
    const bytes = randomBytes(64);
    try {
      await adapter.put(testPath, bytes);
      const back = await adapter.get(testPath);
      if (!back || !equal(back.data, bytes)) {
        await adapter.delete(testPath).catch(() => {});
        end(w, 'fail', 'readBack', { fixes: [{ id: 'checkAddress' }] });
        certifiable();
        return report();
      }
      await adapter.delete(testPath);
      if ((await adapter.head(testPath)) !== null) {
        end(w, 'fail', 'deleteFailed', {});
        certifiable();
        return report();
      }
      end(w, 'ok', 'ok');
    } catch (e) {
      const quota = e instanceof StorageError && e.status === 507;
      end(w, 'fail', e instanceof AuthError ? 'readOnlyCredentials' : quota ? 'quota' : 'failed', {
        detail: httpDetail(e),
        fixes: e instanceof AuthError ? [{ id: config.kind === 's3' ? 's3KeyPolicy' : 'davCredentials' }] : [{ id: 'checkAddress' }],
      });
      certifiable();
      return report();
    }
    if (aborted()) return report();

    // 3. conditional writes
    const cw = begin('conditional');
    try {
      conditionalWrites = await probeConditionalWrites(adapter);
      if (conditionalWrites) end(cw, 'ok', 'ok');
      else end(cw, 'warn', 'emulated', { fixes: [{ id: 'conditionalEmulated' }] });
    } catch (e) {
      conditionalWrites = false;
      end(cw, 'warn', 'probeFailed', { detail: httpDetail(e), fixes: [{ id: 'conditionalEmulated' }] });
    }
    if (aborted()) return report();

    // 4. public read (+ 5. ETag on the web)
    const pubPath = `${TEST_PREFIX}${r()}-public.bin`;
    const pubBytes = randomBytes(48);
    try {
      await adapter.put(pubPath, pubBytes, { contentType: 'application/octet-stream' });
      await publicRead(pubPath, pubBytes);
    } catch (e) {
      const s = begin('publicRead');
      end(s, 'fail', 'failed', { detail: httpDetail(e), fixes: [{ id: 'checkAddress' }] });
    } finally {
      await adapter.delete(pubPath).catch(() => {});
    }

    // 6. certifiable, 7. existing content
    certifiable();
    const ex = begin('existing');
    end(ex, hasIndex ? 'warn' : 'ok', hasIndex ? 'found' : 'empty');
    return report();
  } catch (e) {
    const s = begin('reach');
    end(s, 'fail', 'unexpected', { detail: httpDetail(e) });
    return report();
  }

  function report(): TestReport {
    return { steps, ok: steps.length > 0 && !steps.some((s) => s.status === 'fail' || s.status === 'running'), conditionalWrites, hasIndex, at: (opts.now ?? Date.now)() };
  }
}
