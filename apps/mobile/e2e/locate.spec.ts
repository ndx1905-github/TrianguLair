/** "Center on me" on web (expo-location: the browser's geolocation); Android uses modules/tl-location. */
import { expect, openMap, test } from './helpers';

const LYON = { latitude: 45.76404, longitude: 4.83566 };

async function center(page: import('@playwright/test').Page): Promise<[number, number]> {
  return page.evaluate(() => {
    const c = (window as unknown as { __tlMap: { getCenter(): { lat: number; lng: number } } }).__tlMap.getCenter();
    return [Math.round(c.lat * 1000) / 1000, Math.round(c.lng * 1000) / 1000] as [number, number];
  });
}

test.describe('allowed', () => {
  test.use({ geolocation: LYON, permissions: ['geolocation'] });

  test('center on me moves the map to the position', async ({ page }) => {
    await openMap(page);
    expect(await center(page)).not.toEqual([45.764, 4.836]);
    await page.getByTestId('locate-me').click();
    await expect.poll(() => center(page), { timeout: 20_000 }).toEqual([45.764, 4.836]);
    await expect(page.getByTestId('locate-notice')).toHaveCount(0);
  });
});

test.describe('refused', () => {
  test.use({ permissions: [] });

  test('center on me explains when the position may not be used', async ({ page }) => {
    await openMap(page);
    const before = await center(page);
    await page.getByTestId('locate-me').click();
    await expect(page.getByTestId('locate-notice')).toBeVisible({ timeout: 20_000 });
    expect(await center(page)).toEqual(before);
  });
});
