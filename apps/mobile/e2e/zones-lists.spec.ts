import type { Page } from '@playwright/test';
import { demo, expect, jump, mapPoint, openMap, openPin, tapMap, test } from './helpers';

/** Map features drawn from the zone shapes source at a coordinate. */
async function shapesAt(page: Page, lat: number, lon: number): Promise<string[]> {
  const { x, y } = await mapPoint(page, lat, lon);
  return page.evaluate(
    ([px, py]) => {
      const m = (window as unknown as {
        __tlMap: {
          getContainer(): HTMLElement;
          queryRenderedFeatures(p: [number, number]): { source: string; properties: { id?: string } }[];
        };
      }).__tlMap;
      const r = m.getContainer().getBoundingClientRect();
      return m
        .queryRenderedFeatures([px - r.left, py - r.top])
        .filter((f) => f.source === 'tl-shapes')
        .map((f) => String(f.properties.id));
    },
    [x, y] as const,
  );
}

test('draw a zone by points and see it on the map', async ({ page }) => {
  await openMap(page);
  await jump(page, 48.8642, 2.363, 15.2);
  expect(await shapesAt(page, 48.8642, 2.363)).toEqual([]);
  await expect(page.locator('[data-pin-id][data-badge="1"]')).toHaveCount(0);
  await page.getByTestId('open-new-zone').click();
  await expect(page.getByTestId('zone-panel')).toBeVisible();
  await page.getByTestId('zone-mode').getByText('Draw', { exact: true }).click();
  // The panel covers the lower half of a phone: draw in the upper half.
  await jump(page, 48.863, 2.363, 15.4);
  const corners: [number, number][] = [
    [48.8657, 2.3606],
    [48.8658, 2.3648],
    [48.8645, 2.3655],
    [48.8624, 2.3646],
    [48.8625, 2.3606],
  ];
  for (const [lat, lon] of [...corners, corners[0]!]) await tapMap(page, lat, lon);
  await page.getByTestId('zone-next').click();
  await expect(page.getByTestId('zone-form')).toBeVisible();
  await page.getByTestId('zone-name').fill('Haut-Marais walk');
  await page.getByTestId('tag-option-Shop').click();
  await page.getByTestId('zone-save').click();

  const card = page.getByTestId('zone-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Haut-Marais walk');
  await page.getByTestId('card-close').click();
  await expect(card).toBeHidden();

  // Back on the map: the zone's outline and fill are drawn, with its badge.
  await jump(page, 48.8642, 2.363, 15.2);
  await expect.poll(() => shapesAt(page, 48.8642, 2.363)).not.toHaveLength(0);
  await expect(page.locator('[data-pin-id][data-badge="1"]')).toHaveCount(1);
});

test('a filter list never includes a private place', async ({ page }) => {
  await openMap(page);
  // Make the Marché des Enfants Rouges (tagged Restaurant) private.
  await openPin(page, demo(12), 48.8628, 2.3618);
  const card = page.getByTestId('place-card');
  await expect(card).toBeVisible();
  await card.getByTestId('sharing').getByRole('radio', { name: 'Private' }).click();
  await expect(card.getByTestId('sharing').getByRole('radio', { name: 'Private' })).toBeChecked();
  await page.getByTestId('card-close').click();

  await page.getByTestId('open-lists').click();
  await page.getByTestId('new-list').click();
  const editor = page.getByTestId('list-editor');
  await expect(editor).toBeVisible();
  await page.getByTestId('list-name').fill('Restaurants');
  await page.getByTestId('list-tag-Restaurant').click();

  // Preview: Le Comptoir du Relais is in; the private market is out, with the reason.
  await page.getByTestId('list-toggle-out').click();
  const market = page.getByTestId('list-row-Marché des Enfants Rouges');
  await expect(market).toContainText('Private');
  await expect(page.getByTestId('list-row-Le Comptoir du Relais')).toBeVisible();

  await page.getByTestId('list-save').click();
  await expect(page.getByTestId('list-summary')).toBeVisible();
  await page.getByTestId('list-view-mode').getByText('List', { exact: true }).click();
  await expect(page.getByTestId('member-Le Comptoir du Relais')).toBeVisible();
  await expect(page.getByTestId('member-Marché des Enfants Rouges')).toHaveCount(0);
});
