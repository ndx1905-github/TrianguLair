import { collapseFilters, expect, jump, mapPoint, openMap, test } from './helpers';

const NAME = 'Le Comptoir des Archives';

test('a tap on the map: the places around that spot, by distance and category, or a new point', async ({ page }) => {
  await openMap(page);
  await collapseFilters(page);
  await jump(page, 48.8594, 2.3624, 17);
  // A tap on an empty spot (no card open, filters folded) lists the places around it.
  const { x, y } = await mapPoint(page, 48.8597, 2.3618);
  await page.mouse.click(x, y);

  // The list comes first, with "Create a point here" on top; no form yet.
  await expect(page.getByTestId('drop-point')).toHaveText('Create a point here');
  await expect(page.getByTestId('manual-name')).toHaveCount(0);
  const list = page.getByTestId('candidates');
  await expect(list.getByTestId(`candidate-${NAME}`)).toBeVisible();

  // Nearest first.
  const dists = await list.locator('[data-testid^="candidate-"]').evaluateAll((rows) =>
    rows.map((r) => {
      const t = (r.textContent ?? '').match(/(\d+(?:[.,]\d+)?)\s*(k?m)\b/);
      return t ? Number(t[1]!.replace(',', '.')) * (t[2] === 'km' ? 1000 : 1) : NaN;
    }),
  );
  const known = dists.filter((d) => !Number.isNaN(d));
  expect(known.length).toBeGreaterThan(1);
  expect([...known].sort((a, b) => a - b)).toEqual(known);

  // Filter by category: only that category is left; "All" brings everything back.
  const chips = page.getByTestId('nearby-categories').locator('[data-testid^="nearby-category-"]');
  await expect(chips.first()).toBeVisible();
  const total = await list.locator('[data-testid^="candidate-"]').count();
  await chips.nth(1).click();
  const filtered = await list.locator('[data-testid^="candidate-"]').count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(total);
  await page.getByTestId('nearby-category-all').click();
  await expect(list.locator('[data-testid^="candidate-"]')).toHaveCount(total);

  // Picking an existing place opens its form (or its card when already mine); back returns to the list.
  await page.getByTestId('drop-point').click();
  await expect(page.getByTestId('manual-name')).toBeVisible();
  await page.getByTestId('back').first().click();
  await expect(page.getByTestId('drop-point')).toBeVisible();
});
