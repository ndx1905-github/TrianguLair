import { autostart, expect, jump, openMap, test } from './helpers';

const NAME = 'Le Comptoir des Archives';

test('add a place from the nearby list, find it in the list, edit, trash and undo', async ({ page }) => {
  await openMap(page);
  await jump(page, 48.8594, 2.3624, 16);

  // Add screen: nearby OSM places (fixtures) around the map center.
  await page.getByTestId('open-add').click();
  await expect(page.getByTestId('badge-mine').first()).toBeVisible();
  await page.getByTestId(`candidate-${NAME}`).click();
  const form = page.getByTestId('add-form');
  await expect(form).toBeVisible();
  // Tags: Bar (main) and Restaurant, whatever was suggested.
  for (const sel of await form.locator('[data-testid^="tag-selected-"]').all()) await sel.click();
  await expect(form.locator('[data-testid^="tag-selected-"]')).toHaveCount(0);
  await form.getByTestId('tag-option-Bar').click();
  await form.getByTestId('tag-option-Restaurant').click();
  await expect(form.getByTestId('tag-selected-Bar')).toBeVisible();
  await expect(form.getByTestId('tag-selected-Restaurant')).toBeVisible();
  await form.getByTestId('status').getByRole('radio', { name: 'To try' }).click();
  await form.getByTestId('comment').fill('Terrace in the courtyard, ask for the cider.');
  await page.getByTestId('save-place').click();

  // Back on the map with the new place's card.
  const card = page.getByTestId('place-card');
  await expect(card).toBeVisible();
  await expect(card.getByText(NAME, { exact: true }).first()).toBeVisible();
  await page.getByTestId('card-close').click();

  // List view: the place is there with its tags and status; the comment is searchable.
  await page.getByTestId('open-list').click();
  await expect(page.getByTestId('place-list')).toBeVisible();
  const row = page.getByTestId(`row-${NAME}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Bar, Restaurant');
  await expect(row).toContainText('To try');
  await page.getByTestId('list-search').fill('cider');
  await expect(page.locator('[data-testid^="row-"]')).toHaveCount(1);
  await expect(row).toBeVisible();

  // Edit the status from its card (saved immediately).
  await row.click();
  const page2 = page.getByTestId('place-card').filter({ visible: true });
  await expect(page2).toBeVisible();
  await page2.getByTestId('status').getByRole('radio', { name: 'Favorite' }).click();
  await expect(page2.getByTestId('status').getByRole('radio', { name: 'Favorite' })).toBeChecked();
  await page.getByTestId('back').filter({ visible: true }).click();
  await expect(row).toContainText('Favorite');
  // The card's screen is gone (its closing transition can still be mounted under load).
  await expect(page.getByTestId('place-card')).toHaveCount(0);

  // Move to trash, then undo.
  await row.click();
  const card2 = page.getByTestId('place-card').filter({ visible: true });
  await expect(card2).toHaveCount(1);
  await card2.getByTestId('delete').click();
  await card2.getByTestId('confirm-delete').click();
  await expect(page.getByTestId('place-list')).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('trash-notice').filter({ visible: true })).toContainText(NAME);
  await page.getByTestId('trash-undo').filter({ visible: true }).click();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Favorite');

  // Saved on this device (IndexedDB): still there after a reload.
  await page.waitForTimeout(1500); // the database file is written after a short debounce
  await page.goto(autostart('/list'));
  await expect(page.getByTestId(`row-${NAME}`)).toContainText('Favorite');
});
