/**
 * Nextcloud helpers for the storage wizard (T-202, spec "Storage protocols" › Nextcloud):
 *
 * - **Login Flow v2**: `POST <server>/index.php/login/v2` gives a login page to open in the
 *   browser and a poll endpoint; once the user approves on their Nextcloud, polling it returns
 *   `{ server, loginName, appPassword }`. The app never sees the main password, and the app
 *   password shows up (and can be revoked) in Nextcloud › Settings › Security › Devices & sessions.
 *   https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2
 * - **User id** (`GET /ocs/v2.php/cloud/user`): the WebDAV path uses the user id, which can differ
 *   from the login name (email login, LDAP).
 * - **Public share link** of the TrianguLair folder through the OCS Share API, only when the user
 *   asks for it: the folder is created (MKCOL) if needed, an existing read-only public link
 *   without password is reused, else `POST /ocs/v2.php/apps/files_sharing/api/v1/shares` with
 *   `shareType=3` (public link) and `permissions=1` (read only).
 *
 * Pure `fetch` logic, unit-tested against a mock of these endpoints (nextcloud.test.ts). The
 * manual form (app password, pasted link) stays as the fallback, e.g. when the web build cannot
 * reach these endpoints (Nextcloud sends no CORS headers on them).
 */
import type { FetchLike } from '@triangulair/storage';

import { NEXTCLOUD_FOLDER, nextcloudBase } from './config';

/** Name Nextcloud shows for the app password (from the User-Agent; browsers may not send ours). */
export const NEXTCLOUD_CLIENT_NAME = 'TrianguLair';
/** Login Flow v2 tokens are valid 20 minutes. */
export const LOGIN_FLOW_TIMEOUT_MS = 20 * 60_000;
export const LOGIN_FLOW_POLL_MS = 2_000;

export type NextcloudProblem =
  | 'unreachable' // network error, CORS on the web
  | 'notNextcloud' // the address does not answer like a Nextcloud
  | 'expired' // the 20 minutes passed without approval
  | 'cancelled'
  | 'auth' // credentials refused
  | 'sharingDisabled' // public links forbidden by the admin
  | 'passwordRequired' // the admin enforces a password on public links
  | 'failed';

export class NextcloudError extends Error {
  constructor(
    readonly problem: NextcloudProblem,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NextcloudError';
  }
}

export interface LoginFlow {
  /** Page to open in the browser. */
  loginUrl: string;
  pollEndpoint: string;
  token: string;
  /** Server base the flow was started on. */
  server: string;
}

export interface NextcloudLogin {
  /** Server base (no trailing slash). */
  server: string;
  loginName: string;
  appPassword: string;
}

export interface Creds {
  loginName: string;
  appPassword: string;
}

interface Opts {
  fetch?: FetchLike;
}

const fetchOf = (o: Opts): FetchLike => o.fetch ?? ((i, init) => globalThis.fetch(i, init));

/** Base64 of a UTF-8 string without btoa/Buffer (Hermes). */
function b64(s: string): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const b = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + (i + 1 < b.length ? A[(n >> 6) & 63]! : '=') + (i + 2 < b.length ? A[n & 63]! : '=');
  }
  return out;
}

function basic(c: Creds): string {
  return `Basic ${b64(`${c.loginName}:${c.appPassword}`)}`;
}

async function call(f: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await f(url, init);
  } catch (e) {
    throw new NextcloudError('unreachable', `${init.method ?? 'GET'} ${url}: ${(e as Error)?.message ?? e}`);
  }
}

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await res.json();
    if (v && typeof v === 'object') return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new NextcloudError('notNextcloud', `${what}: not a Nextcloud answer`, res.status);
}

function httpUrl(v: unknown): URL | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/** Step 1: asks the server for a login page and a poll token. */
export async function startLoginFlow(serverInput: string, o: Opts = {}): Promise<LoginFlow> {
  const server = nextcloudBase(serverInput);
  if (!server) throw new NextcloudError('notNextcloud', 'not a server address');
  const res = await call(fetchOf(o), `${server}/index.php/login/v2`, {
    method: 'POST',
    headers: { 'User-Agent': NEXTCLOUD_CLIENT_NAME, Accept: 'application/json' },
    credentials: 'omit',
  });
  if (!res.ok) throw new NextcloudError(res.status === 404 ? 'notNextcloud' : 'failed', `login/v2: HTTP ${res.status}`, res.status);
  const body = await json(res, 'login/v2');
  const poll = body['poll'] as Record<string, unknown> | undefined;
  const login = httpUrl(body['login']);
  const endpoint = httpUrl(poll?.['endpoint']);
  const token = poll?.['token'];
  if (!login || !endpoint || typeof token !== 'string' || !token) throw new NextcloudError('notNextcloud', 'login/v2: unexpected answer');
  // The token only goes back to the server that issued it.
  if (endpoint.origin !== new URL(server).origin) throw new NextcloudError('notNextcloud', 'login/v2: poll endpoint on another server');
  return { loginUrl: login.href, pollEndpoint: endpoint.href, token, server };
}

/** Step 2, once: the credentials when the user has approved, null while they have not (404). */
export async function pollLoginFlow(flow: LoginFlow, o: Opts = {}): Promise<NextcloudLogin | null> {
  const res = await call(fetchOf(o), flow.pollEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `token=${encodeURIComponent(flow.token)}`,
    credentials: 'omit',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new NextcloudError('failed', `login/v2/poll: HTTP ${res.status}`, res.status);
  const body = await json(res, 'login/v2/poll');
  const { loginName, appPassword } = body as { loginName?: unknown; appPassword?: unknown };
  if (typeof loginName !== 'string' || typeof appPassword !== 'string' || !loginName || !appPassword) {
    throw new NextcloudError('notNextcloud', 'login/v2/poll: unexpected answer');
  }
  const announced = httpUrl(body['server']);
  const server = (announced && nextcloudBase(announced.href)) || flow.server;
  return { server, loginName, appPassword };
}

/**
 * Step 2: polls every `intervalMs` until approved, `timeoutMs` passed (`expired`) or `signal`
 * aborted (`cancelled`). A transient network error while polling is retried.
 */
export async function waitForLogin(
  flow: LoginFlow,
  o: Opts & { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<NextcloudLogin> {
  const interval = o.intervalMs ?? LOGIN_FLOW_POLL_MS;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = now() + (o.timeoutMs ?? LOGIN_FLOW_TIMEOUT_MS);
  let failures = 0;
  for (;;) {
    if (o.signal?.aborted) throw new NextcloudError('cancelled', 'cancelled');
    try {
      const r = await pollLoginFlow(flow, o);
      if (r) return r;
      failures = 0;
    } catch (e) {
      if (!(e instanceof NextcloudError) || e.problem !== 'unreachable' || ++failures >= 5) throw e;
    }
    if (now() >= end) throw new NextcloudError('expired', 'login not approved in time');
    await sleep(interval);
  }
}

function ocsHeaders(c: Creds): Record<string, string> {
  return { Authorization: basic(c), 'OCS-APIRequest': 'true', Accept: 'application/json' };
}

function ocsData(body: Record<string, unknown>): unknown {
  return (body['ocs'] as Record<string, unknown> | undefined)?.['data'];
}

function ocsMessage(body: Record<string, unknown>): string {
  const meta = (body['ocs'] as Record<string, unknown> | undefined)?.['meta'] as Record<string, unknown> | undefined;
  return typeof meta?.['message'] === 'string' ? meta['message'] : '';
}

/** The user id (WebDAV path), which may differ from the login name. */
export async function nextcloudUserId(server: string, c: Creds, o: Opts = {}): Promise<string> {
  const res = await call(fetchOf(o), `${server}/ocs/v2.php/cloud/user?format=json`, { method: 'GET', headers: ocsHeaders(c), credentials: 'omit' });
  if (res.status === 401 || res.status === 403) throw new NextcloudError('auth', `cloud/user: HTTP ${res.status}`, res.status);
  if (!res.ok) throw new NextcloudError('failed', `cloud/user: HTTP ${res.status}`, res.status);
  const id = (ocsData(await json(res, 'cloud/user')) as Record<string, unknown> | undefined)?.['id'];
  if (typeof id !== 'string' || !id) throw new NextcloudError('notNextcloud', 'cloud/user: no id');
  return id;
}

/** Creates the TrianguLair folder if it is missing (MKCOL: 201 created, 405 already there). */
export async function ensureNextcloudFolder(server: string, userId: string, c: Creds, o: Opts = {}): Promise<void> {
  const url = `${server}/remote.php/dav/files/${encodeURIComponent(userId)}/${NEXTCLOUD_FOLDER}/`;
  const res = await call(fetchOf(o), url, { method: 'MKCOL', headers: { Authorization: basic(c) }, credentials: 'omit' });
  if (res.status === 401 || res.status === 403) throw new NextcloudError('auth', `MKCOL: HTTP ${res.status}`, res.status);
  if (!(res.ok || res.status === 405)) throw new NextcloudError('failed', `MKCOL: HTTP ${res.status}`, res.status);
}

export interface PublicShare {
  /** `https://cloud.example/s/<token>`: what the wizard puts in the share-link field. */
  url: string;
  token: string;
  /** False when an existing read-only public link was reused. */
  created: boolean;
  /** Expiry date set by the server (an admin default): friends lose access then. */
  expiration: string | null;
}

const SHARES = '/ocs/v2.php/apps/files_sharing/api/v1/shares';
const PUBLIC_LINK = 3;
const READ = 1;

function asShare(v: unknown, created: boolean): PublicShare | null {
  const s = v as Record<string, unknown> | undefined;
  const url = httpUrl(s?.['url']);
  const token = s?.['token'];
  if (!url || typeof token !== 'string' || !token) return null;
  const exp = s?.['expiration'];
  return { url: url.href, token, created, expiration: typeof exp === 'string' && exp ? exp : null };
}

/**
 * The read-only public link of the TrianguLair folder: reuses one (read only, no password),
 * otherwise creates it. Creates the folder first.
 */
export async function ensurePublicShare(server: string, userId: string, c: Creds, o: Opts = {}): Promise<PublicShare> {
  const f = fetchOf(o);
  await ensureNextcloudFolder(server, userId, c, o);
  const path = `/${NEXTCLOUD_FOLDER}`;
  const list = await call(f, `${server}${SHARES}?format=json&path=${encodeURIComponent(path)}&reshares=false&subfiles=false`, {
    method: 'GET',
    headers: ocsHeaders(c),
    credentials: 'omit',
  });
  if (list.status === 401 || list.status === 403) throw new NextcloudError('auth', `shares: HTTP ${list.status}`, list.status);
  if (list.ok) {
    const data = ocsData(await json(list, 'shares'));
    for (const s of Array.isArray(data) ? (data as Record<string, unknown>[]) : []) {
      if (Number(s['share_type']) === PUBLIC_LINK && Number(s['permissions']) === READ && !s['password'] && !s['share_with']) {
        const found = asShare(s, false);
        if (found) return found;
      }
    }
  }
  const res = await call(f, `${server}${SHARES}?format=json`, {
    method: 'POST',
    headers: { ...ocsHeaders(c), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `path=${encodeURIComponent(path)}&shareType=${PUBLIC_LINK}&permissions=${READ}`,
    credentials: 'omit',
  });
  if (res.status === 401) throw new NextcloudError('auth', 'create share: HTTP 401', 401);
  if (!res.ok) {
    let msg = '';
    try {
      msg = ocsMessage(await json(res, 'create share'));
    } catch {
      msg = '';
    }
    const problem: NextcloudProblem = /password/i.test(msg) ? 'passwordRequired' : res.status === 403 ? 'sharingDisabled' : 'failed';
    throw new NextcloudError(problem, `create share: HTTP ${res.status} ${msg}`.trim(), res.status);
  }
  const made = asShare(ocsData(await json(res, 'create share')), true);
  if (!made) throw new NextcloudError('notNextcloud', 'create share: unexpected answer');
  return made;
}
