import type { Locator } from '@playwright/test';
import { expect, openMap, test } from './helpers';

const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
const DARK_SURFACE = 'rgb(22, 27, 34)'; // colors.ts dark.surface #161B22
const LIGHT_SURFACE = 'rgb(255, 255, 255)';

test('switch to French', async ({ page }) => {
  await openMap(page);
  await expect(page.getByTestId('filter-toggle')).toContainText('Filters');
  // Web forces the language with ?lang= (the device language otherwise).
  await openMap(page, '/?lang=fr');
  await expect(page.getByTestId('filter-toggle')).toContainText('Filtres');
  await expect(page.getByTestId('filter-count')).toHaveText(/\d+ lieux/);
  // The press can be cancelled by a banner moving the map's buttons (closure check): retry it.
  await expect(async () => {
    if (!(await page.getByTestId('candidates').isVisible())) await page.getByTestId('open-add').click();
    await expect(page.getByTestId('candidates')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Ajouter un lieu' })).toBeVisible();
  await expect(page.getByText('Déjà dans mes lieux').first()).toBeVisible();
});

test.describe('dark mode', () => {
  test.use({ colorScheme: 'dark' });

  test('follows the system setting: dark UI and dark base map', async ({ page }) => {
    const styleRequest = page.waitForRequest((r) => r.url().startsWith('https://tiles.openfreemap.org/styles/dark'));
    await openMap(page);
    await styleRequest;
    await expect.poll(() => bg(page.getByTestId('filter-bar'))).toBe(DARK_SURFACE);
    await expect(page.locator('[data-pin-id]').first()).toBeAttached();
  });
});

test('the theme button switches light and dark', async ({ page }) => {
  await openMap(page);
  const bar = page.getByTestId('filter-bar');
  const toggle = page.getByTestId('theme-toggle');
  await expect.poll(() => bg(bar)).toBe(LIGHT_SURFACE);
  await expect(toggle).toContainText('Auto');
  await toggle.click();
  await expect(toggle).toContainText('Light');
  const darkStyle = page.waitForRequest((r) => r.url().startsWith('https://tiles.openfreemap.org/styles/dark'));
  await toggle.click();
  await expect(toggle).toContainText('Dark');
  await expect.poll(() => bg(bar)).toBe(DARK_SURFACE);
  // The base map follows the app theme, not only the system one.
  await darkStyle;
  // The browser's bars (iPhone status bar of a Home Screen app) follow the app theme too.
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => (m as HTMLMetaElement).content)))
    .toEqual(expect.arrayContaining(['#0B0F14']));
  await expect(page.locator('[data-pin-id]').first()).toBeAttached();
});
