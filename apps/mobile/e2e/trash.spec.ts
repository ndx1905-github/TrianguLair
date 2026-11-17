/**
 * Trash (gap #8, spec "Editing and deleting"): a place moved to the trash is listed in Settings › Trash, restored with
 * its status, deleted forever after a confirmation, and purged at launch 30 days after its deletion.
 */
import type { Page } from '@playwright/test';
import { autostart, expect, NOW, test } from './helpers';

const NAME = 'Du Pain et des Idées';
const OTHER = 'Musée d’Orsay';
const DAY = 24 * 3600 * 1000;

async function trashFromList(page: Page, name: string) {
  const row = page.getByTestId(`row-${name}`);
  await row.click();
  const card = page.getByTestId('place-card').filter({ visible: true });
  await expect(card).toHaveCount(1);
  await card.getByTestId('delete').click();
  await card.getByTestId('confirm-delete').click();
  await expect(page.getByTestId('place-list')).toBeVisible();
  await expect(row).toHaveCount(0);
}

async function openTrash(page: Page) {
  await page.goto(autostart('/settings'));
  await expect(page.getByTestId('settings-my-content')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('settings-trash').click();
  await expect(page.getByTestId('trash-screen')).toBeVisible();
}

test('trash: restore, delete forever, purge after 30 days', async ({ page }) => {
  await page.goto(autostart('/list'));
  await expect(page.getByTestId(`row-${NAME}`)).toBeVisible({ timeout: 30_000 });
  await trashFromList(page, NAME);
  await trashFromList(page, OTHER);
  await page.waitForTimeout(1500); // the database file is written after a short debounce

  await openTrash(page);
  const items = page.locator('[data-testid^="trash-item-"]');
  await expect(items).toHaveCount(2);
  const bakery = items.filter({ hasText: NAME });
  await expect(bakery).toContainText('Place');
  await expect(bakery).toContainText('Deleted for good in 30 days');

  // Restore: back in the list with its status.
  await bakery.getByTestId('trash-restore').click();
  await expect(page.getByTestId('trash-done')).toContainText(`“${NAME}” is back.`);
  await expect(items).toHaveCount(1);
  await page.waitForTimeout(1500);
  await page.goto(autostart('/list'));
  await expect(page.getByTestId(`row-${NAME}`)).toContainText('Favorite');

  // Delete forever, after a confirmation.
  await openTrash(page);
  const museum = items.filter({ hasText: OTHER });
  await museum.getByTestId('trash-delete').click();
  await expect(museum.getByTestId('trash-delete-confirm')).toContainText('cannot be restored');
  await museum.getByTestId('trash-delete-go').click();
  await expect(page.getByTestId('trash-empty')).toBeVisible();
  await page.waitForTimeout(1500);

  // Purge at launch: an item deleted 31 days ago is gone.
  await page.goto(autostart('/list'));
  await trashFromList(page, NAME);
  await page.waitForTimeout(1500);
  await page.clock.setSystemTime(new Date(NOW.getTime() + 31 * DAY));
  await openTrash(page);
  await expect(page.getByTestId('trash-empty')).toBeVisible();
  await page.goto(autostart('/list'));
  await expect(page.locator('[data-testid^="row-"]').first()).toBeVisible();
  await expect(page.getByTestId(`row-${NAME}`)).toHaveCount(0);
});

test('trash: dark mode and French', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(autostart('/list?lang=fr'));
  await expect(page.getByTestId(`row-${NAME}`)).toBeVisible({ timeout: 30_000 });
  await trashFromList(page, NAME);
  await page.waitForTimeout(1500);
  await page.goto(autostart('/trash?lang=fr'));
  await expect(page.getByTestId('trash-screen')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Supprimé définitivement dans 30 jours')).toBeVisible();
  await expect(page.getByTestId('trash-restore')).toHaveText('Restaurer');
});
