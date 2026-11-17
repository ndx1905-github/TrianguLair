/**
 * Nextcloud Login Flow v2 and the OCS Share API (T-202), against a mock of the endpoints that
 * follows the Nextcloud developer documentation (no real server here: see the storage README).
 */
import { describe, expect, it } from 'vitest';

import { buildConfig, draftFromConfig, EMPTY_DRAFT, parseConfig } from './config';
import { NextcloudError, ensurePublicShare, nextcloudUserId, pollLoginFlow, startLoginFlow, waitForLogin } from './nextcloud';

const SERVER = 'https://cloud.example.org/nextcloud';

interface Share {
  id: number;
  share_type: number;
  permissions: number;
  password?: string | null;
  share_with?: string | null;
  url: string;
  token: string;
  path: string;
  expiration: string | null;
}

/** Mock Nextcloud: login/v2, its poll, cloud/user, MKCOL, shares (list, create). */
function mockNextcloud(o: { approveAfter?: number; loginName?: string; userId?: string; publicLinks?: 'ok' | 'disabled' | 'password'; expiration?: string | null } = {}) {
  const loginName = o.loginName ?? 'alice';
  const userId = o.userId ?? loginName;
  const appPassword = 'Abcde-Fghij-Klmno-Pqrst-Uvwxy';
  let polls = 0;
  const folders = new Set<string>();
  const shares: Share[] = [];
  const calls: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
  const auth = `Basic ${Buffer.from(`${loginName}:${appPassword}`).toString('base64')}`;
  const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const ocs = (status: number, data: unknown, message = '') => json(status, { ocs: { meta: { status: status < 300 ? 'ok' : 'failure', statuscode: status, message }, data } });

  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ method, url: url.href, headers, body });
    const p = url.pathname.replace('/nextcloud', '');
    if (method === 'POST' && p === '/index.php/login/v2') {
      return json(200, { poll: { token: 'tok-123', endpoint: `${SERVER}/login/v2/poll` }, login: `${SERVER}/login/v2/flow/flowtoken` });
    }
    if (method === 'POST' && p === '/login/v2/poll') {
      if (new URLSearchParams(body).get('token') !== 'tok-123') return new Response('', { status: 404 });
      if (++polls <= (o.approveAfter ?? 0)) return new Response('', { status: 404 });
      return json(200, { server: SERVER, loginName, appPassword });
    }
    if (headers['authorization'] !== auth) return new Response('', { status: 401 });
    if (p === '/ocs/v2.php/cloud/user') return ocs(200, { id: userId, 'display-name': 'Alice' });
    if (method === 'MKCOL') {
      const f = decodeURIComponent(p);
      if (f !== `/remote.php/dav/files/${userId}/TrianguLair/`) return new Response('', { status: 409 });
      if (folders.has(f)) return new Response('', { status: 405 });
      folders.add(f);
      return new Response('', { status: 201 });
    }
    if (p === '/ocs/v2.php/apps/files_sharing/api/v1/shares') {
      if (headers['ocs-apirequest'] !== 'true') return new Response('', { status: 412 });
      if (method === 'GET') return ocs(200, shares.filter((s) => s.path === url.searchParams.get('path')));
      const q = new URLSearchParams(body);
      if (o.publicLinks === 'disabled') return ocs(403, [], 'Public upload is not allowed');
      if (o.publicLinks === 'password') return ocs(403, [], 'Password needs to be set (enforced)');
      if (!folders.has(`/remote.php/dav/files/${userId}${q.get('path')}/`)) return ocs(404, [], 'Wrong path, file/folder does not exist');
      const s: Share = { id: shares.length + 1, share_type: Number(q.get('shareType')), permissions: Number(q.get('permissions')), url: `${SERVER}/s/Ab12Cd34Ef`, token: 'Ab12Cd34Ef', path: q.get('path')!, expiration: o.expiration ?? null };
      shares.push(s);
      return ocs(200, s);
    }
    return new Response('', { status: 404 });
  };
  return { fetch, calls, shares, folders, appPassword };
}

describe('Nextcloud Login Flow v2', () => {
  it('server address → login page to open → poll until approved → app password', async () => {
    const nc = mockNextcloud({ approveAfter: 2 });
    const flow = await startLoginFlow('cloud.example.org/nextcloud/index.php/apps/files', { fetch: nc.fetch });
    expect(flow).toEqual({ loginUrl: `${SERVER}/login/v2/flow/flowtoken`, pollEndpoint: `${SERVER}/login/v2/poll`, token: 'tok-123', server: SERVER });
    expect(nc.calls[0]).toMatchObject({ method: 'POST', url: `${SERVER}/index.php/login/v2`, headers: { 'user-agent': 'TrianguLair' } });
    expect(await pollLoginFlow(flow, { fetch: nc.fetch })).toBeNull();
    const sleeps: number[] = [];
    const login = await waitForLogin(flow, { fetch: nc.fetch, intervalMs: 2000, sleep: async (ms) => void sleeps.push(ms) });
    expect(login).toEqual({ server: SERVER, loginName: 'alice', appPassword: nc.appPassword });
    expect(sleeps).toEqual([2000]);
    const poll = nc.calls.filter((c) => c.url.endsWith('/login/v2/poll'));
    expect(poll.every((c) => c.body === 'token=tok-123' && c.headers['content-type'] === 'application/x-www-form-urlencoded')).toBe(true);
  });

  it('expires after the timeout; can be cancelled', async () => {
    const nc = mockNextcloud({ approveAfter: 1e9 });
    const flow = await startLoginFlow(SERVER, { fetch: nc.fetch });
    let t = 0;
    await expect(waitForLogin(flow, { fetch: nc.fetch, timeoutMs: 10_000, now: () => t, sleep: async (ms) => void (t += ms) })).rejects.toMatchObject({ problem: 'expired' });
    const ctl = new AbortController();
    const p = waitForLogin(flow, { fetch: nc.fetch, signal: ctl.signal, sleep: async () => void ctl.abort() });
    await expect(p).rejects.toMatchObject({ problem: 'cancelled' });
  });

  it('a transient network error while polling is retried; a server that is not Nextcloud is told apart', async () => {
    const nc = mockNextcloud();
    const flow = await startLoginFlow(SERVER, { fetch: nc.fetch });
    let fail = 2;
    const flaky: typeof nc.fetch = async (i, init) => (fail-- > 0 ? Promise.reject(new TypeError('Network request failed')) : nc.fetch(i, init));
    expect((await waitForLogin(flow, { fetch: flaky, sleep: async () => {} })).loginName).toBe('alice');

    const html = async () => new Response('<html>hello</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(startLoginFlow('https://not-nextcloud.example', { fetch: html })).rejects.toMatchObject({ problem: 'notNextcloud' });
    await expect(startLoginFlow('https://nowhere.example', { fetch: async () => Promise.reject(new TypeError('Failed to fetch')) })).rejects.toMatchObject({ problem: 'unreachable' });
    await expect(startLoginFlow('https://x.example', { fetch: async () => new Response('', { status: 404 }) })).rejects.toMatchObject({ problem: 'notNextcloud' });
  });

  it('refuses a poll endpoint on another server (the token would leak) and a non-http login page', async () => {
    const answer = (v: unknown) => async () => new Response(JSON.stringify(v), { status: 200 });
    await expect(startLoginFlow(SERVER, { fetch: answer({ poll: { token: 't', endpoint: 'https://evil.example/poll' }, login: `${SERVER}/login/v2/flow/x` }) })).rejects.toBeInstanceOf(NextcloudError);
    await expect(startLoginFlow(SERVER, { fetch: answer({ poll: { token: 't', endpoint: `${SERVER}/login/v2/poll` }, login: 'javascript:alert(1)' }) })).rejects.toMatchObject({ problem: 'notNextcloud' });
  });

  it('user id differs from the login name (email login): the WebDAV folder uses the id', async () => {
    const nc = mockNextcloud({ loginName: 'alice@example.org', userId: 'alice42' });
    const creds = { loginName: 'alice@example.org', appPassword: nc.appPassword };
    expect(await nextcloudUserId(SERVER, creds, { fetch: nc.fetch })).toBe('alice42');
    await expect(nextcloudUserId(SERVER, { ...creds, appPassword: 'wrong' }, { fetch: nc.fetch })).rejects.toMatchObject({ problem: 'auth' });
    const { config } = buildConfig({ ...EMPTY_DRAFT, choice: 'nextcloud', ncServer: SERVER, ncUser: 'alice@example.org', ncUserId: 'alice42', ncPassword: nc.appPassword, ncShareLink: `${SERVER}/s/Ab12Cd34Ef` });
    expect(config).toMatchObject({ url: `${SERVER}/remote.php/dav/files/alice42/TrianguLair/`, username: 'alice@example.org', nextcloud: { userId: 'alice42' } });
    const back = parseConfig(JSON.parse(JSON.stringify(config)));
    expect(draftFromConfig(back).ncUserId).toBe('alice42');
  });
});

describe('Nextcloud public share link (OCS Share API)', () => {
  const creds = (nc: ReturnType<typeof mockNextcloud>) => ({ loginName: 'alice', appPassword: nc.appPassword });

  it('creates the folder, then a read-only public link (shareType=3, permissions=1)', async () => {
    const nc = mockNextcloud();
    const s = await ensurePublicShare(SERVER, 'alice', creds(nc), { fetch: nc.fetch });
    expect(s).toEqual({ url: `${SERVER}/s/Ab12Cd34Ef`, token: 'Ab12Cd34Ef', created: true, expiration: null });
    const post = nc.calls.find((c) => c.method === 'POST' && c.url.includes('/shares'))!;
    expect(new URLSearchParams(post.body).toString()).toBe('path=%2FTrianguLair&shareType=3&permissions=1');
    expect(post.headers['ocs-apirequest']).toBe('true');
    // The wizard turns the link into the public DAV read address.
    const { config } = buildConfig({ ...EMPTY_DRAFT, choice: 'nextcloud', ncServer: SERVER, ncUser: 'alice', ncPassword: nc.appPassword, ncShareLink: s.url });
    expect(config?.readUrl).toBe(`${SERVER}/public.php/dav/files/Ab12Cd34Ef/`);
  });

  it('reuses an existing read-only public link instead of making another', async () => {
    const nc = mockNextcloud({ expiration: '2027-01-01 00:00:00' });
    await ensurePublicShare(SERVER, 'alice', creds(nc), { fetch: nc.fetch });
    const again = await ensurePublicShare(SERVER, 'alice', creds(nc), { fetch: nc.fetch });
    expect(again).toMatchObject({ created: false, token: 'Ab12Cd34Ef', expiration: '2027-01-01 00:00:00' });
    expect(nc.shares).toHaveLength(1);
  });

  it('a link with write permission or a password is not reused', async () => {
    const nc = mockNextcloud();
    await ensurePublicShare(SERVER, 'alice', creds(nc), { fetch: nc.fetch });
    nc.shares[0]!.permissions = 15;
    expect((await ensurePublicShare(SERVER, 'alice', creds(nc), { fetch: nc.fetch })).created).toBe(true);
    expect(nc.shares).toHaveLength(2);
  });

  it('typed problems: public links disabled, password enforced, credentials refused', async () => {
    const off = mockNextcloud({ publicLinks: 'disabled' });
    await expect(ensurePublicShare(SERVER, 'alice', creds(off), { fetch: off.fetch })).rejects.toMatchObject({ problem: 'sharingDisabled', status: 403 });
    const pw = mockNextcloud({ publicLinks: 'password' });
    await expect(ensurePublicShare(SERVER, 'alice', creds(pw), { fetch: pw.fetch })).rejects.toMatchObject({ problem: 'passwordRequired' });
    const nc = mockNextcloud();
    await expect(ensurePublicShare(SERVER, 'alice', { loginName: 'alice', appPassword: 'nope' }, { fetch: nc.fetch })).rejects.toMatchObject({ problem: 'auth' });
  });
});
