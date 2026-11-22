/**
 * Shared lists end to end (T-211, T-212), against the real Apache WebDAV server of
 * packages/storage/scripts/real-servers.sh (as root; 127.0.0.1:8081, /dav with a password, /pub
 * anonymous). Skipped when it is not running.
 *
 * Two browser contexts. Anna has a storage (write side through a small CORS proxy, read address
 * `https://friends.triangulair.test/pub/<folder>/` answered from Apache's /pub). Ben has no storage
 * and is not her contact: he follows her link-only list with its link alone, then loses it when
 * she makes a new link. Then Anna makes the list public: its GeoJSON file opens (valid, with the
 * ODbL notice) and the uMap link is well-formed; Ben follows the public list by its link too.
 *
 * `SHOTS=1` also writes the screenshots of docs/ (share sheet, follow preview, followed lists,
 * gone link, public warning, uMap; French, dark mode, tablet).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import { autostart, expect, jump, preparePage, test } from './helpers';

const DAV = 'http://127.0.0.1:8081';
const AUTH = 'Basic ' + Buffer.from('alice:s3cret').toString('base64');
const FRIENDS = 'https://friends.triangulair.test';
const SHOTS = process.env['SHOTS'] === '1';
const SHARED = 'Le Comptoir des Archives';
const LIST = 'Marais evenings';

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
      const location = typeof r.headers.location === 'string' ? r.headers.location.replace(DAV, proxyUrl) : undefined;
      res.writeHead(r.statusCode ?? 502, { ...r.headers, ...cors, ...(location && { location }) });
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

const folder = (who: string) => `e2e-lists-${who}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface Person {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  location: string | null;
}

/** A person's context: friends' read addresses are answered from Apache's /pub (anonymous, read-only). */
async function context(browser: Browser, viewport = { width: 390, height: 844 }): Promise<Person> {
  const ctx = await browser.newContext({ viewport, locale: 'en-US', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  const errors = await preparePage(page);
  await page.route(`${FRIENDS}/**`, async (route) => {
    const url = route.request().url().replace(FRIENDS, DAV);
    const r = await route.fetch({ url, headers: {} });
    await route.fulfill({ response: r, headers: { ...r.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' } });
  });
  // "View on uMap" must not reach the real uMap from a test.
  await ctx.route('https://umap.openstreetmap.fr/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>uMap</title>' }));
  return { ctx, page, errors, location: null };
}

async function withStorage(p: Person, name: string): Promise<void> {
  const page = p.page;
  const dir = folder(name.toLowerCase());
  await page.goto(autostart(`/storage?name=${name}`));
  await page.getByTestId('storage-connect').click();
  await page.getByTestId('choice-webdav').click();
  await page.getByTestId('field-davUrl').fill(`${proxyUrl}/dav/${dir}/`);
  await page.getByTestId('field-davUser').fill('alice');
  await page.getByTestId('field-davPassword').fill('s3cret');
  await page.getByTestId('field-readUrl').fill(`${FRIENDS}/pub/${dir}/`);
  await page.getByTestId('setup-test').click();
  await expect(page.getByTestId('test-summary')).toContainText('Everything works', { timeout: 30_000 });
  await page.getByTestId('master-go').click();
  await expect(page.getByTestId('storage-connected-banner')).toBeVisible();
  p.location = `${FRIENDS}/pub/${dir}/`;
  await syncNow(page);
}

/** One pass from Settings › Sync status ("Sync now" is disabled while a pass runs). */
async function syncNow(page: Page): Promise<void> {
  await page.goto(autostart('/sync'));
  const now = page.getByTestId('sync-now');
  await expect(now).toBeVisible({ timeout: 30_000 });
  await expect(now).toBeEnabled({ timeout: 60_000 });
  await now.click();
  await expect(now).toBeEnabled({ timeout: 60_000 });
  await settle(page);
}

const settle = (page: Page) => page.waitForTimeout(1200);

async function shot(page: Page, file: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `docs/${file}` });
}

async function addPlace(page: Page, name: string): Promise<void> {
  await page.goto(autostart('/'));
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await jump(page, 48.8594, 2.3624, 16);
  await page.getByTestId('open-add').click();
  await page.getByTestId(`candidate-${name}`).click();
  const form = page.getByTestId('add-form');
  await expect(form).toBeVisible();
  await form.getByTestId('comment').fill('Cider on the terrace, ask for Paul.');
  await page.getByTestId('save-place').click();
  await expect(page.getByTestId('place-card')).toBeVisible();
  await page.getByTestId('card-close').click();
  await settle(page);
}

/** A manual list with one of my places and one demo place; returns the share screen's address. */
async function makeList(page: Page): Promise<void> {
  await page.goto(autostart('/lists'));
  await page.getByTestId('new-list').click();
  await expect(page.getByTestId('list-editor')).toBeVisible();
  await page.getByTestId('list-name').fill(LIST);
  await page.getByTestId('list-kind').getByText('Selection by hand', { exact: true }).click();
  await page.getByTestId('list-toggle-out').click();
  await page.getByTestId(`list-add-${SHARED}`).click();
  await page.getByTestId('list-add-Le Comptoir du Relais').click();
  await page.getByTestId('list-save').click();
  await expect(page.getByTestId('list-summary')).toContainText('2 places');
  await settle(page);
}

test('link-only list: followed without being a contact, cut by a new link; public list in GeoJSON and uMap', async ({ browser }) => {
  test.skip(!proxy, 'Apache WebDAV on 127.0.0.1:8081 is not running (packages/storage/scripts/real-servers.sh)');
  test.setTimeout(300_000);
  const anna = await context(browser);
  await withStorage(anna, 'Anna');
  const a = anna.page;
  await addPlace(a, SHARED);
  await makeList(a);

  // Anna's list → Share → Create the link (published before it is shown).
  await a.getByTestId('share-list').click();
  await expect(a.getByTestId('share-list-screen')).toBeVisible();
  await expect(a.getByTestId('storage-needed')).toHaveCount(0);
  await a.getByTestId('share-create-link').click();
  await expect(a.getByTestId('share-link-ready')).toBeVisible({ timeout: 60_000 });
  const link = (await a.getByTestId('share-link-link').textContent())!;
  expect(link).toMatch(/^https?:\/\/[^/#]+(?:\/[^#]*)?\/l#[A-Za-z0-9_-]+$/);
  expect(link.length).toBeLessThan(260);
  // The QR code holds the same link.
  await expect(a.getByTestId('share-qr')).toHaveAttribute('data-qr-value', link);
  await shot(a, 'phone-list-share-link.png');

  // Ben: no storage, not Anna's contact. He opens the link (deep link: the key stays in memory).
  const ben = await context(browser);
  const b = ben.page;
  await b.goto(autostart('/'));
  await expect(b.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await b.goto(`${autostart('/l')}#${link.split('#')[1]!}`);
  // Nothing is read before the user asks for the preview (review L-07).
  await expect(b.getByTestId('follow-offer')).toBeVisible({ timeout: 60_000 });
  await expect(b.getByTestId('follow-preview')).toHaveCount(0);
  await b.getByTestId('follow-show-preview').click();
  await expect(b.getByTestId('follow-preview')).toBeVisible({ timeout: 60_000 });
  // The fragment left the address bar.
  expect(new URL(b.url()).hash).toBe('');
  await expect(b.getByTestId('follow-preview-name')).toHaveText(LIST);
  await expect(b.getByTestId('follow-preview-meta')).toContainText('2 places');
  await expect(b.getByTestId(`follow-place-${SHARED}`)).toBeVisible();
  // Only public comments travel with a link: Anna's comment (friends) is not shown.
  await expect(b.getByTestId('follow-places')).not.toContainText('Cider on the terrace');
  await shot(b, 'phone-list-follow-preview.png');
  await b.getByTestId('follow-confirm').click();
  await expect(b.getByTestId('followed-list')).toBeVisible({ timeout: 60_000 });
  await b.getByTestId('followed-list-view-mode').getByText('List', { exact: true }).click();
  await expect(b.getByTestId(`followed-list-place-${SHARED}`)).toBeVisible();
  await shot(b, 'phone-list-followed.png');
  // The web build saves its database file shortly after a write: wait before reloading the page.
  await settle(b);
  // Still not a contact: no request was sent, nothing exchanged.
  await b.goto(autostart('/contacts'));
  await expect(b.getByTestId('contacts-empty')).toBeVisible();
  // Its places are on Ben's map like friends' places.
  await b.goto(autostart('/list'));
  await b.getByTestId('list-search').fill('Comptoir des Archives');
  await expect(b.getByTestId(`row-${SHARED}`)).toBeVisible({ timeout: 30_000 });
  await b.goto(autostart('/lists/followed'));
  await expect(b.getByTestId(`followed-${LIST}`)).toContainText('2 places');

  // Anna makes a new link: the old one stops working for Ben.
  await a.getByTestId('share-new-link').click();
  await expect(a.getByTestId('share-new-confirm')).toBeVisible();
  await shot(a, 'phone-list-share-new-link.png');
  await a.getByTestId('share-new-link-confirm').click();
  await expect(a.getByTestId('share-new-confirm')).toHaveCount(0, { timeout: 60_000 });
  await expect(a.getByTestId('share-link-link')).not.toHaveText(link, { timeout: 60_000 });
  const newLink = (await a.getByTestId('share-link-link').textContent())!;

  await syncNow(b);
  await b.goto(autostart('/lists/followed'));
  await expect(b.getByTestId(`followed-${LIST}`)).toContainText('This link no longer works', { timeout: 30_000 });
  await b.getByTestId(`followed-${LIST}`).click();
  await expect(b.getByTestId('followed-gone-link-dead')).toBeVisible();
  await b.getByTestId('followed-list-view-mode').getByText('List', { exact: true }).click();
  await expect(b.getByTestId(`followed-list-place-${SHARED}`)).toHaveCount(0);
  await shot(b, 'phone-list-followed-gone.png');
  await b.goto(autostart('/list'));
  await b.getByTestId('list-search').fill('Comptoir des Archives');
  await expect(b.getByTestId(`row-${SHARED}`)).toHaveCount(0);
  // Pasting the old link again says so; the new one works.
  await b.goto(autostart('/lists/follow'));
  await b.getByTestId('follow-input').fill(`Anna: ${link}`);
  await b.getByTestId('follow-open').click();
  await expect(b.getByTestId('follow-problem-link-dead')).toContainText('This link no longer works');
  await b.getByTestId('follow-input').fill(newLink);
  await b.getByTestId('follow-open').click();
  await expect(b.getByTestId('follow-preview')).toBeVisible({ timeout: 60_000 });
  if (SHOTS) {
    await b.goto(autostart('/lists/follow?lang=fr'));
    await b.getByTestId('follow-input').fill(newLink);
    await b.getByTestId('follow-open').click();
    await expect(b.getByTestId('follow-preview')).toBeVisible({ timeout: 60_000 });
    await expect(b.getByTestId('follow-confirm')).toHaveText('Suivre cette liste');
    await shot(b, 'phone-fr-list-follow-preview.png');
  }

  // Anna makes the list public: a warning first, then the file and "View on uMap".
  await a.getByTestId('share-visibility').getByText('Public', { exact: true }).click();
  await expect(a.getByTestId('share-public-warning')).toBeVisible();
  await shot(a, 'phone-list-public-warning.png');
  await a.getByTestId('share-public-warning-confirm').click();
  await expect(a.getByTestId('share-public-ready')).toBeVisible({ timeout: 60_000 });
  await expect(a.getByTestId('share-busy')).toHaveCount(0, { timeout: 60_000 });
  await expect(a.getByTestId('share-failed')).toHaveCount(0);
  const file = (await a.getByTestId('share-public-file-link').textContent())!;
  expect(file).toBe(`${anna.location}public/lists.geojson`);
  // The file opens and is valid GeoJSON with the ODbL notice.
  const res = await anna.ctx.request.get(file.replace(FRIENDS, DAV));
  expect(res.status()).toBe(200);
  const geo = (await res.json()) as { type: string; attribution: string; license: { name: string }; features: { type: string; geometry: { type: string }; properties: { name: string; list_name: string; _umap_options: { color: string } } }[] };
  expect(geo.type).toBe('FeatureCollection');
  expect(geo.attribution).toContain('© OpenStreetMap contributors');
  expect(geo.license.name).toBe('ODbL-1.0');
  expect(geo.features.map((f) => f.properties.name).sort()).toEqual(['Le Comptoir des Archives', 'Le Comptoir du Relais']);
  for (const f of geo.features) {
    expect(f.type).toBe('Feature');
    expect(f.geometry.type).toBe('Point');
    expect(f.properties.list_name).toBe(LIST);
    expect(f.properties._umap_options.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  }
  // The uMap link: a new uMap map importing the file.
  const umap = new URL((await a.getByTestId('share-umap-url').textContent())!);
  expect(umap.origin).toBe('https://umap.openstreetmap.fr');
  expect(umap.pathname).toBe('/en/map/new/');
  expect(umap.searchParams.get('dataUrl')).toBe(file);
  expect(umap.searchParams.get('dataFormat')).toBe('geojson');
  const popup = anna.ctx.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
  await a.getByTestId('share-umap').click();
  const opened = await popup;
  // The new page's URL is empty until its first navigation commits (slow or blocked network).
  if (opened) await opened.waitForURL((u) => u.href.startsWith('https://'), { waitUntil: 'commit', timeout: 15_000 }).catch(() => {});
  expect(opened ? opened.url() : a.url()).toBe(umap.href);
  await opened?.close();
  await shot(a, 'phone-list-share-public.png');

  // Ben follows the public list with its in-app link.
  const pubLink = (await a.getByTestId('share-public-link-link').textContent())!;
  await b.goto(autostart('/lists/follow'));
  await b.getByTestId('follow-input').fill(pubLink);
  await b.getByTestId('follow-open').click();
  await expect(b.getByTestId('follow-preview-meta')).toContainText('public', { timeout: 60_000 });
  await b.getByTestId('follow-confirm').click();
  await expect(b.getByTestId('followed-list')).toBeVisible({ timeout: 60_000 });
  await settle(b);
  await b.goto(autostart('/lists/followed'));
  await expect(b.getByTestId(`followed-author-Anna`)).toBeVisible();
  await shot(b, 'phone-lists-followed.png');

  if (SHOTS) {
    await a.emulateMedia({ colorScheme: 'dark' });
    await a.reload();
    await expect(a.getByTestId('share-public-ready')).toBeVisible({ timeout: 60_000 });
    await shot(a, 'phone-dark-list-share-public.png');
    await a.emulateMedia({ colorScheme: 'light' });
    await b.setViewportSize({ width: 834, height: 1112 });
    await b.goto(autostart('/lists/followed?lang=fr'));
    await b.getByTestId(`followed-${LIST}`).filter({ hasText: 'publique' }).click();
    await expect(b.getByTestId('followed-list')).toBeVisible();
    await b.getByTestId(`followed-list-place-${SHARED}`).click();
    await shot(b, 'tablet-fr-list-followed.png');
    await b.setViewportSize({ width: 390, height: 844 });
  }

  expect(anna.errors).toEqual([]);
  expect(ben.errors).toEqual([]);
  await anna.ctx.close();
  await ben.ctx.close();
});

test('without a storage, sharing a list asks for one and comes back', async ({ page }) => {
  await page.goto(autostart('/lists'));
  await page.getByTestId('new-list').click();
  await page.getByTestId('list-name').fill('Weekend');
  await page.getByTestId('list-kind').getByText('Selection by hand', { exact: true }).click();
  await page.getByTestId('list-toggle-out').click();
  await page.getByTestId('list-add-Le Comptoir du Relais').click();
  // Going public asks to acknowledge the warning before saving.
  await page.getByTestId('list-visibility').getByText('Public', { exact: true }).click();
  await expect(page.getByTestId('list-public-warning')).toBeVisible();
  await expect(page.getByTestId('list-save')).toBeDisabled();
  await page.getByTestId('list-public-ok').click();
  await page.getByTestId('list-save').click();
  await page.getByTestId('share-list').click();
  await expect(page.getByTestId('storage-needed')).toBeVisible();
  await page.getByTestId('storage-needed-connect').click();
  await expect(page).toHaveURL(/\/storage\/setup\?reason=public-list&return=%2Flists%2Fshare/);
});
