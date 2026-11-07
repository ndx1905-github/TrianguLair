/**
 * Storage settings against a real WebDAV server (T-203): Apache mod_dav on 127.0.0.1:8081, started
 * by packages/storage/scripts/real-servers.sh (as root). Skipped when it is not running.
 *
 * - The browser reaches the write side through a small CORS proxy started here (the reverse-proxy
 *   rule the connection test suggests); pointing at Apache directly shows the CORS diagnosis.
 * - The read address must be a public https URL to be certified, so friends' address is
 *   `https://friends.triangulair.test/pub/…`, answered by Playwright from Apache's anonymous `/pub`
 *   alias of the same folders (with `Access-Control-Allow-Origin: *`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';

import { autostart, expect, test } from './helpers';

const DAV = 'http://127.0.0.1:8081';
const AUTH = 'Basic ' + Buffer.from('alice:s3cret').toString('base64');
const FRIENDS = 'https://friends.triangulair.test';

let proxy: http.Server | null = null;
let proxyUrl = '';

async function davUp(): Promise<boolean> {
  try {
    const r = await fetch(`${DAV}/dav/`, { method: 'PROPFIND', headers: { authorization: AUTH, depth: '0' } });
    return r.status === 207;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  if (!(await davUp())) return;
  proxy = http.createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-methods': 'GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, Depth, If-Match, If-None-Match',
      'access-control-expose-headers': 'ETag, OC-ETag, Content-Length',
      vary: 'Origin',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const up = http.request({ host: '127.0.0.1', port: 8081, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1:8081' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...r.headers, ...cors });
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502, cors);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
});

test.beforeEach(async ({ page }) => {
  test.skip(!proxy, 'Apache WebDAV on 127.0.0.1:8081 is not running (packages/storage/scripts/real-servers.sh)');
  // Friends' read address: anonymous GET on Apache's /pub alias, made readable by any origin.
  await page.route(`${FRIENDS}/**`, async (route) => {
    const url = route.request().url().replace(FRIENDS, DAV);
    const r = await route.fetch({ url, headers: {} });
    await route.fulfill({ response: r, headers: { ...r.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' } });
  });
});

const folder = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function davPut(path: string, body: Uint8Array | string): Promise<void> {
  const parts = path.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) await fetch(`${DAV}/dav/${parts.slice(0, i).join('/')}/`, { method: 'MKCOL', headers: { authorization: AUTH } });
  const r = await fetch(`${DAV}/dav/${path}`, { method: 'PUT', headers: { authorization: AUTH }, body: typeof body === 'string' ? body : Buffer.from(body) });
  expect(r.status).toBeLessThan(300);
}

/** Every file under `dir` (relative paths), by PROPFIND depth 1 per folder. */
async function davList(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    const r = await fetch(`${DAV}/dav/${dir}/${rel}`, { method: 'PROPFIND', headers: { authorization: AUTH, depth: '1' } });
    const xml = await r.text();
    for (const m of xml.matchAll(/<D:href>([^<]+)<\/D:href>/g)) {
      const href = decodeURIComponent(m[1]!);
      const sub = href.slice(href.indexOf(`/dav/${dir}/`) + `/dav/${dir}/`.length);
      if (!sub || sub === rel) continue;
      if (sub.endsWith('/')) await walk(sub);
      else out.push(sub);
    }
  };
  await walk('');
  return out.sort();
}

async function davGet(path: string): Promise<Buffer | null> {
  const r = await fetch(`${DAV}/dav/${path}`, { headers: { authorization: AUTH } });
  return r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null;
}

/** Fills the generic WebDAV form for `dir` (write through `base`) and runs the test. */
async function fillWebDav(page: Page, base: string, dir: string, password = 's3cret'): Promise<void> {
  await page.getByTestId('choice-webdav').click();
  await page.getByTestId('field-davUrl').fill(`${base}/dav/${dir}/`);
  await page.getByTestId('field-davUser').fill('alice');
  await page.getByTestId('field-davPassword').fill(password);
  await page.getByTestId('field-readUrl').fill(`${FRIENDS}/pub/${dir}/`);
  await page.getByTestId('setup-test').click();
  await expect(page.getByTestId('test-summary')).toBeVisible({ timeout: 30_000 });
}

async function connect(page: Page, dir: string): Promise<void> {
  await page.goto(autostart('/storage'));
  await page.getByTestId('storage-connect').click();
  await fillWebDav(page, proxyUrl, dir);
  await expect(page.getByTestId('test-summary')).toContainText('Everything works');
  await page.getByTestId('master-go').click();
  await expect(page.getByTestId('storage-connected-banner')).toBeVisible();
}

test('connection test: wrong password, CORS, then a working storage is connected', async ({ page }) => {
  const dir = folder();
  await page.goto(autostart('/storage'));
  await expect(page.getByTestId('storage-local')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('storage-connect').click();

  // Wrong password: rejected credentials.
  await fillWebDav(page, proxyUrl, dir, 'wrong');
  await expect(page.getByTestId('step-reach-fail')).toBeVisible();
  await expect(page.getByTestId('step-reach-outcome')).toContainText('refused the user name or password');
  await expect(page.getByTestId('fix-davCredentials')).toBeVisible();

  // Apache directly: no CORS headers, so the browser cannot talk to it; the fix carries this origin.
  await page.getByTestId('field-davUrl').fill(`${DAV}/dav/${dir}/`);
  await page.getByTestId('field-davPassword').fill('s3cret');
  await page.getByTestId('setup-test').click();
  await expect(page.getByTestId('step-reach-outcome')).toContainText('CORS', { timeout: 30_000 });
  await expect(page.getByTestId('fix-webdavCorsApache-copy')).toContainText('Access-Control-Allow-Origin "http://127.0.0.1:');

  // A read address on a private network cannot be certified.
  await page.getByTestId('field-davUrl').fill(`${proxyUrl}/dav/${dir}/`);
  await page.getByTestId('field-readUrl').fill('https://192.168.1.20/pub/');
  await expect(page.getByTestId('field-readUrl-problem')).toBeVisible();

  // Through the CORS proxy, with a public read address: every step passes, then connect.
  await page.getByTestId('field-readUrl').fill(`${FRIENDS}/pub/${dir}/`);
  await page.getByTestId('setup-test').click();
  await expect(page.getByTestId('test-summary')).toContainText('Everything works', { timeout: 30_000 });
  for (const s of ['reach', 'write', 'publicRead', 'etag', 'certifiable', 'existing']) await expect(page.getByTestId(`step-${s}-ok`)).toBeVisible();
  // No test file left behind.
  const listing = await fetch(`${DAV}/dav/${dir}/`, { method: 'PROPFIND', headers: { authorization: AUTH, depth: '1' } });
  expect(await listing.text()).not.toContain('.triangulair-test-');
  await page.screenshot({ path: 'test-results/storage-test-ok.png', fullPage: true });

  await page.getByTestId('master-go').click(); // primary device: no phrase needed
  await expect(page.getByTestId('storage-connected-banner')).toBeVisible();
  await page.getByTestId('storage-done').click();
  await expect(page.getByTestId('storage-read-address')).toHaveText(`${FRIENDS}/pub/${dir}/`);
  await expect(page.getByTestId('storage-protocol')).toHaveText('WebDAV');

  // Kept across reloads (secret store).
  await page.reload();
  await expect(page.getByTestId('storage-read-address')).toHaveText(`${FRIENDS}/pub/${dir}/`, { timeout: 30_000 });
});

test('move to another storage: lossless copy, verified, certified, old storage kept as redirect', async ({ page }) => {
  const a = folder();
  const b = folder();
  await connect(page, a);

  // The sync engine publishes the (demo) places on A once connected: packs, my document, vault, index.
  await expect.poll(async () => !!(await davGet(`${a}/index.json`)), { timeout: 30_000 }).toBe(true);
  // A photo another device uploaded (not listed yet): copied too.
  await davPut(`${a}/media/photo-1.bin`, new Uint8Array(200_000).map((_, j) => (j * 7) % 251));
  const files: Record<string, Uint8Array> = {};
  for (const p of await davList(a)) files[p] = new Uint8Array((await davGet(`${a}/${p}`))!);
  expect(Object.keys(files).filter((p) => p.startsWith('packs/')).length).toBeGreaterThan(0);

  await page.getByTestId('storage-done').click();
  await page.getByTestId('storage-change').click();
  await fillWebDav(page, proxyUrl, b);
  await expect(page.getByTestId('test-summary')).toContainText('Everything works');
  await page.getByTestId('setup-use').click();

  await expect(page.getByTestId('move-plan')).toContainText(`${Object.keys(files).length} files`, { timeout: 30_000 });
  await expect(page.getByTestId('move-invitations')).toBeVisible();
  await page.screenshot({ path: 'test-results/storage-move-plan.png', fullPage: true });
  await page.getByTestId('move-start').click();
  await expect(page.getByTestId('move-verified')).toContainText(`All ${Object.keys(files).length} files verified`, { timeout: 60_000 });
  await page.getByTestId('master-go').click();
  await expect(page.getByTestId('move-done')).toBeVisible({ timeout: 30_000 });
  // The sync engine published right away (no "at the next synchronization").
  await expect(page.getByTestId('move-republish')).toHaveCount(0);

  // A untouched except its index, which is now the signed redirect: the same bytes as B's new index
  // (certifying B's address). Every file that index lists is on B, identical to A's copy when A had
  // it (the engine may have rewritten my own document at B, then removed the superseded copy).
  for (const [p, d] of Object.entries(files)) {
    if (p === 'index.json') continue;
    expect(Buffer.compare((await davGet(`${a}/${p}`))!, Buffer.from(d)), p).toBe(0);
  }
  const newIndex = (await davGet(`${b}/index.json`))!;
  const idx = JSON.parse(newIndex.toString()) as { sharing_cert: { location: string }; packs: { file: string }[] };
  expect(idx.sharing_cert.location).toBe(`${FRIENDS}/pub/${b}/`);
  expect(Buffer.compare((await davGet(`${a}/index.json`))!, newIndex)).toBe(0);
  for (const { file } of idx.packs) {
    const onB = await davGet(`${b}/${file}`);
    expect(onB, file).not.toBeNull();
    if (files[file]) expect(Buffer.compare(onB!, Buffer.from(files[file]!)), file).toBe(0);
  }
  expect(Buffer.compare((await davGet(`${b}/media/photo-1.bin`))!, Buffer.from(files['media/photo-1.bin']!))).toBe(0);

  await page.getByTestId('move-finish').click();
  await expect(page.getByTestId('storage-read-address')).toHaveText(`${FRIENDS}/pub/${b}/`);
  await expect(page.getByTestId('storage-previous')).toContainText(`${FRIENDS}/pub/${a}/`);
  await expect(page.getByTestId('storage-previous')).toContainText('Redirect kept until');
});

test('a move onto a folder holding other content overwrites nothing', async ({ page }) => {
  const a = folder();
  const b = folder();
  await connect(page, a);
  await davPut(`${a}/packs/b2b256-x.bin`, 'mine');
  await davPut(`${a}/index.json`, '{"seq":1}');
  await davPut(`${b}/index.json`, '{"someone":"else","seq":42}');
  await page.getByTestId('storage-done').click();
  await page.getByTestId('storage-change').click();
  await fillWebDav(page, proxyUrl, b);
  await page.getByTestId('setup-use').click();
  await expect(page.getByTestId('move-conflict')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('move-start')).toHaveCount(0);
  expect((await davGet(`${b}/index.json`))!.toString()).toBe('{"someone":"else","seq":42}');
});
