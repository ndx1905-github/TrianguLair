/**
 * The installable web app (PWA), on its own build: `npm run export:web:pwa:fixtures` (fixture mode,
 * service worker on, base path /triangulair), served like a plain static host (YunoHost "My
 * webapp": no fallback page, see scripts/serve.py). Project "pwa" in playwright.config.ts.
 *
 * - the manifest and icons are served and valid, the iOS tags are there, the service worker registers;
 * - after one visit, the app opens offline with my places (and the service worker cached nothing
 *   outside the app's own files);
 * - everything works under the sub-path: routes, deep links (/l#…, /i#…, /r#…), assets, the map's worker.
 */
import type { Page } from '@playwright/test';

import { autostart, expect, jump, openMap, test } from './helpers';

const BASE = '/triangulair';
const NAME = 'Le Comptoir des Archives';

/** Width and height of a PNG (IHDR). */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Waits until the service worker is active and controls the page. */
async function controlled(page: Page): Promise<string> {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 30_000 });
  return page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
}

test('the manifest is served and valid, with the icons and iOS tags; the service worker registers', async ({ page, request }) => {
  await openMap(page, `${BASE}/`);

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe(`${BASE}/manifest.webmanifest`);
  const res = await request.get(href!);
  expect(res.ok()).toBe(true);
  expect(res.headers()['content-type']).toContain('manifest+json');
  const m = await res.json();
  expect(m).toMatchObject({ name: 'TrianguLair', short_name: 'TrianguLair', display: 'standalone', start_url: `${BASE}/`, scope: `${BASE}/`, id: `${BASE}/` });
  expect(m.theme_color).toMatch(/^#[0-9A-F]{6}$/i);
  expect(m.background_color).toMatch(/^#[0-9A-F]{6}$/i);
  const icons = m.icons as { src: string; sizes: string; type: string; purpose: string }[];
  const want = [
    ['192x192', 'any'],
    ['512x512', 'any'],
    ['512x512', 'maskable'],
  ];
  for (const [sizes, purpose] of want) {
    const icon = icons.find((i) => i.sizes === sizes && i.purpose === purpose && i.type === 'image/png');
    expect(icon, `${sizes} ${purpose} icon`).toBeTruthy();
    expect(icon!.src.startsWith(`${BASE}/`)).toBe(true);
    const img = await request.get(icon!.src);
    expect(img.ok()).toBe(true);
    const [w, h] = sizes!.split('x').map(Number);
    expect(pngSize(await img.body())).toEqual({ width: w, height: h });
  }

  // iOS: home-screen icon (180 px) and the standalone tags.
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect(pngSize(await (await request.get(apple!)).body())).toEqual({ width: 180, height: 180 });
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'TrianguLair');
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', /^#/);

  // The service worker: registered for the sub-path, controls the page, its cache holds the shell.
  const scope = await controlled(page);
  expect(new URL(scope).pathname).toBe(`${BASE}/`);
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) urls.push(r.url);
    return urls;
  });
  const origin = new URL(page.url()).origin;
  expect(cached).toContain(`${origin}${BASE}/index.html`);
  expect(cached.some((u) => /\/_expo\/static\/js\/web\/entry-[0-9a-f]+\.js$/.test(u))).toBe(true);
  expect(cached).toContain(`${origin}${BASE}/maplibre-gl-worker.mjs`);

  // Settings › Storage in this browser.
  await page.goto(autostart(`${BASE}/settings`));
  await expect(page.getByTestId('settings-browser-storage')).toBeVisible();
  await expect(page.getByTestId('settings-browser-persisted')).not.toBeEmpty();
  await expect(page.getByTestId('settings-browser-kit')).toBeVisible();
});

test('after one visit, the app opens offline with my places', async ({ page, context }) => {
  // One visit: add a place (saved in IndexedDB on this device).
  await openMap(page, `${BASE}/`);
  await jump(page, 48.8594, 2.3624, 16);
  await page.getByTestId('open-add').click();
  await page.getByTestId(`candidate-${NAME}`).click();
  await expect(page.getByTestId('add-form')).toBeVisible();
  await page.getByTestId('save-place').click();
  await expect(page.getByTestId('place-card')).toBeVisible();
  await page.waitForTimeout(1500); // the database file is written after a short debounce
  await controlled(page);

  await context.setOffline(true);
  const offline = await page.evaluate(() => navigator.onLine);
  expect(offline).toBe(false);

  // The map, a deeper route, then the list with my new place: all from the service worker's cache.
  await openMap(page, `${BASE}/`);
  await page.goto(autostart(`${BASE}/list`));
  await expect(page.getByTestId('place-list')).toBeVisible();
  await expect(page.getByTestId(`row-${NAME}`)).toBeVisible();
  // A route the static host has no file for (a reload of /place/<id>) also opens.
  await page.goto(autostart(`${BASE}/lists/followed/none`));
  await expect(page.locator('#root')).not.toBeEmpty();

  // The service worker cached only the app's own files: no storage, tiles or OSM requests.
  await context.setOffline(false);
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) urls.push(r.url);
    return urls;
  });
  const prefix = `${new URL(page.url()).origin}${BASE}/`;
  expect(cached.length).toBeGreaterThan(5);
  expect(cached.filter((u) => !u.startsWith(prefix))).toEqual([]);
});

test('works under a sub-path: routes, deep links, assets and the map worker', async ({ page, request }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await openMap(page, `${BASE}/`);
  const origin = new URL(page.url()).origin;

  // Every request to this origin stays under the sub-path (bundles, CSS, fonts, icons, worker).
  const own = requests.filter((u) => u.startsWith(origin));
  expect(own.length).toBeGreaterThan(3);
  expect(own.filter((u) => !u.startsWith(`${origin}${BASE}/`))).toEqual([]);
  expect(own.some((u) => u.startsWith(`${origin}${BASE}/maplibre-gl-worker.mjs`))).toBe(true);

  // In-app navigation keeps the sub-path.
  await page.getByTestId('open-list').click();
  await expect(page.getByTestId('place-list')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`${BASE}/list`);

  // The static host serves a copy of the app for every route without a parameter (no fallback page).
  for (const route of ['l', 'i', 'r', 'settings', 'lists/follow']) {
    const res = await request.get(`${BASE}/${route}`);
    expect(res.status(), route).toBe(200);
    expect(await res.text()).toContain(`${BASE}/_expo/static/js/web/entry-`);
  }

  // A route with a parameter has no file: the host's "not found" page is the app (first visit, no service worker yet).
  const missing = await request.get(`${BASE}/place/nowhere`);
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain(`${BASE}/_expo/static/js/web/entry-`);

  // A list link (/l#…): the fragment is taken, removed from the address bar, and offered in "Follow a list".
  const fragment = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA';
  await page.goto(`${autostart(`${BASE}/l`)}#${fragment}`);
  await expect(page.getByTestId('follow-list-screen')).toBeVisible();
  await expect(page.getByTestId('follow-input')).toHaveValue(`https://triangulair.app/l#${fragment}`);
  expect(new URL(page.url()).pathname).toBe(`${BASE}/lists/follow`);
  expect(page.url()).not.toContain(fragment);

  // An invitation link (/i#…) opens the received-invitation screen, under the sub-path too.
  await page.goto(`${autostart(`${BASE}/i`)}#${fragment}`);
  await expect(page.getByTestId('received-screen')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`${BASE}/invite/received`);
  expect(page.url()).not.toContain(fragment);
});

test('a new version offers "Reload", which switches to it', async ({ page, context }) => {
  await openMap(page, `${BASE}/`);
  await controlled(page);
  const version = () =>
    page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => resolve((e.data as { version: string }).version);
          navigator.serviceWorker.controller!.postMessage({ type: 'version' }, [ch.port2]);
        }),
    );
  const before = await version();

  // A new build on the server: the test server (scripts/serve.py) serves the same service worker
  // with another version to this browser.
  const origin = new URL(page.url()).origin;
  await context.addCookies([{ name: 'tl-e2e-sw', value: 'next', url: origin }]);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  const prompt = page.getByTestId('pwa-update');
  await expect(prompt).toBeVisible();
  await expect(page.getByTestId('pwa-update-later')).toBeVisible();

  await page.getByTestId('pwa-update-reload').click();
  await page.waitForEvent('load');
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await controlled(page);
  expect(await version()).toBe(`${before}-next`);
  await expect(prompt).toHaveCount(0);
  // The previous build's cache is gone, the new one is there.
  const names = await page.evaluate(() => caches.keys());
  expect(names.filter((n) => n.startsWith('triangulair-shell'))).toEqual([expect.stringContaining(`${before}-next`)]);
});
