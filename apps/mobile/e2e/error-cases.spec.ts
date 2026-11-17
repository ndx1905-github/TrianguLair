/**
 * Spec "Error cases" (T-213), the rows that are a visible flow on their own. The others are covered
 * by sync.spec.ts (offline with changes pending, credentials rejected and reconnecting), by
 * invitations.spec.ts and lists-sharing.spec.ts (links that no longer work), and by the unit tests
 * mapped in docs/error-cases.md.
 */
import type { Page } from '@playwright/test';
import { expect, openMap, preparePage, test } from './helpers';

// Fixture build: the configured style is OpenFreeMap's, the fallback address one that never
// resolves (config.ts), answered here.
const PRIMARY = 'https://tiles.openfreemap.org/';
const FALLBACK = 'https://tiles.fallback.invalid/';
const FALLBACK_BG = '#D7E3D0';

function fallbackStyle(): string {
  return JSON.stringify({
    version: 8,
    name: 'fallback',
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': FALLBACK_BG } }],
  });
}

/** The current web map: its style's name and background, and whether the zones source is there. */
function mapState(page: Page) {
  return page.evaluate(() => {
    const m = (window as unknown as {
      __tlMap?: { getStyle(): { name?: string; layers: { type: string; paint?: Record<string, unknown> }[] }; getSource(id: string): unknown };
    }).__tlMap;
    if (!m) return null;
    const style = m.getStyle();
    const bg = style.layers.find((l) => l.type === 'background');
    return { name: style.name ?? null, bg: bg?.paint?.['background-color'] ?? null, shapes: !!m.getSource('tl-shapes') };
  });
}

test('key missing from the phone\'s vault (system restore): nothing opens, the recovery kit is asked', async ({ page }) => {
  const errors = await preparePage(page);
  await openMap(page);
  // A restore brings the app's data back without the system vault's keys: the device keys are gone.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('triangulair-secrets', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('secrets', 'readwrite');
          tx.objectStore('secrets').delete('device-keys');
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  // Every screen (here the sync status) sends to the request for the recovery kit.
  await page.goto('/sync');
  const screen = page.getByTestId('welcome-keys-missing');
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await expect(screen).toContainText('Your keys are no longer on this device');
  await expect(screen).toContainText('Nothing is sent or changed until you restore them');
  await expect(page.getByTestId('sync-status')).toHaveCount(0);
  await page.getByTestId('keys-missing-restore').click();
  await expect(page.getByTestId('welcome-device-screen')).toBeVisible();
  // French.
  await page.goto('/?lang=fr');
  await expect(page.getByTestId('welcome-keys-missing')).toContainText('Vos clés ne sont plus sur cet appareil');
  expect(errors).toEqual([]);
});

test.describe('map tiles unavailable: cache, then the fallback address', () => {
  test('the style address fails: the fallback address is used, "Map possibly less detailed"', async ({ page }) => {
    const primaryTried = page.waitForRequest((r) => r.url().startsWith(`${PRIMARY}styles/positron`));
    const fallbackTried = page.waitForRequest((r) => r.url().startsWith(`${FALLBACK}styles/positron`));
    await page.route(`${PRIMARY}**`, (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }));
    await page.route(`${FALLBACK}**`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fallbackStyle() }));
    await openMap(page);
    await primaryTried;
    await fallbackTried;
    await expect(page.getByTestId('map')).toHaveAttribute('data-base-map', 'fallback');
    await expect.poll(() => mapState(page)).toEqual({ name: 'fallback', bg: FALLBACK_BG, shapes: true });
    await expect(page.getByTestId('basemap-note')).toHaveText('Map possibly less detailed');
    // The map stays usable: pins are shown.
    await expect(page.locator('[data-pin-id]').first()).toBeVisible();
    // French.
    await openMap(page, '/?lang=fr');
    await expect(page.getByTestId('basemap-note')).toHaveText('Carte peut-être moins détaillée');
  });

  test('the tiles fail with nothing in the cache: the fallback address is used', async ({ page }) => {
    // The style loads, but its tile host does not answer.
    await page.route(`${PRIMARY}**`, (r) => {
      if (!r.request().url().includes('/styles/')) return r.abort('connectionfailed');
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 8,
          name: 'primary',
          sources: { openmaptiles: { type: 'vector', tiles: [`${PRIMARY}planet/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
          layers: [
            { id: 'bg', type: 'background', paint: { 'background-color': '#ECEBE6' } },
            { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': '#AAD3DF' } },
          ],
        }),
      });
    });
    await page.route(`${FALLBACK}**`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fallbackStyle() }));
    const tileTried = page.waitForRequest((r) => r.url().startsWith(`${PRIMARY}planet/`));
    await openMap(page);
    await tileTried;
    await expect(page.getByTestId('map')).toHaveAttribute('data-base-map', 'fallback');
    await expect.poll(() => mapState(page)).toEqual({ name: 'fallback', bg: FALLBACK_BG, shapes: true });
    await expect(page.getByTestId('basemap-note')).toHaveText('Map possibly less detailed');
  });

  test('no address answers: a plain background, the places still shown', async ({ page }) => {
    await page.route(`${PRIMARY}**`, (r) => r.abort('connectionfailed'));
    await page.route(`${FALLBACK}**`, (r) => r.fulfill({ status: 503, contentType: 'text/plain', body: 'Unavailable' }));
    await openMap(page);
    await expect(page.getByTestId('map')).toHaveAttribute('data-base-map', 'unavailable');
    await expect.poll(() => mapState(page)).toMatchObject({ name: 'triangulair-blank', shapes: true });
    await expect(page.getByTestId('basemap-note')).toHaveText('Map background unavailable for now: your places are still shown');
    await expect(page.locator('[data-pin-id]').first()).toBeVisible();
  });

  test('the configured address answers: no message', async ({ page }) => {
    await openMap(page);
    await expect(page.getByTestId('map')).toHaveAttribute('data-base-map', 'primary');
    await expect(page.getByTestId('basemap-note')).toHaveCount(0);
  });
});
