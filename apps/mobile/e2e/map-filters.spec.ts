import type { Page } from '@playwright/test';
import { demo, expect, jump, openMap, test } from './helpers';

/** The pin of a demo place, after centering the map on it (zoom 16: no clusters). */
async function pinAt(page: Page, n: number, lat: number, lon: number) {
  await jump(page, lat, lon, 16);
  const pin = page.locator(`[data-pin-id="${demo(n)}"]`);
  await expect(pin).toBeAttached();
  return pin;
}

test('first launch shows the demo map', async ({ page }) => {
  await openMap(page);
  await expect(page.getByTestId('map')).toBeVisible();
  // The 15 demo places (plus the fixture-mode saves) are counted by the filter bar.
  await expect(page.getByTestId('filter-count')).toHaveText(/\b1[5-9] places\b/);
  // Zoomed in on the Marais: the demo pin of the Marché des Enfants Rouges is drawn.
  await expect(await pinAt(page, 12, 48.8628, 2.3618)).toBeVisible();
  await expect(page.getByText('© OpenStreetMap contributors', { exact: false })).toBeVisible();
});

test('filter by tag', async ({ page }) => {
  await openMap(page);
  await page.getByTestId('filter-tag-Bar').click();
  await expect(page.getByTestId('filter-count')).toHaveText(/^\d+ of \d+ places$/);
  // Le Baron Rouge is a bar; Du Pain et des Idées is not.
  await expect(await pinAt(page, 6, 48.8496, 2.3782)).not.toHaveAttribute('data-greyed', '1');
  await expect(await pinAt(page, 1, 48.8713, 2.3633)).toHaveAttribute('data-greyed', '1');
  await page.getByTestId('filter-clear').click();
  await expect(page.getByTestId('filter-count')).toHaveText(/^\d+ places?$/);
  await expect(page.locator(`[data-pin-id="${demo(1)}"]`)).not.toHaveAttribute('data-greyed', '1');
});

test('filter by "open now"', async ({ page }) => {
  await openMap(page);
  await page.getByTestId('filter-criterion-openNow').click();
  await expect(page.getByTestId('filter-count')).toHaveText(/^\d+ of \d+ places$/);
  // Friday 18:30: New Morning opens at 19:30, Du Pain et des Idées closes at 19:30.
  await expect(await pinAt(page, 8, 48.8723, 2.3532)).toHaveAttribute('data-greyed', '1');
  await expect(await pinAt(page, 1, 48.8713, 2.3633)).not.toHaveAttribute('data-greyed', '1');
});
