/**
 * The list's "Select" mode (beta feedback: delete or edit many places at once). "Select all" takes
 * the places shown (here: the "Bar" filter); only my saves are changed, friends' places are skipped
 * and the confirmation says so; the trash gets them all, restorable (Undo, or the trash screen).
 */
import type { Page } from '@playwright/test';

import { autostart, expect, test } from './helpers';

// Sample places (src/data/demo.ts) tagged Bar: two of mine, two only my friend's.
const MY_BARS = ['Le Baron Rouge', 'New Morning'];
const THEIR_BAR = 'Le Perchoir';

async function selectBars(page: Page): Promise<number> {
  await page.goto(autostart('/list'));
  await expect(page.getByTestId(`row-${MY_BARS[0]}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('filter-tag-Bar').click();
  await expect(page.getByTestId('filter-count')).toHaveText(/^\d+ of \d+ places$/);
  await page.getByTestId('list-select').click();
  await expect(page.getByTestId('select-count')).toHaveText('0 selected');
  const all = page.getByTestId('select-all');
  const n = Number((await all.textContent())!.match(/\((\d+)\)/)![1]);
  await all.click();
  await expect(page.getByTestId('select-count')).toHaveText(`${n} selected`);
  await expect(all).toHaveText('Clear the selection');
  for (const name of [...MY_BARS, THEIR_BAR]) await expect(page.getByTestId(`row-${name}`)).toHaveAttribute('aria-checked', 'true');
  // Not a bar: shown faded by the filter, not selected.
  await expect(page.getByTestId('row-Musée d’Orsay')).toHaveAttribute('aria-checked', 'false');
  return n;
}

test('select all with a filter, delete my places (friends’ skipped), undo, delete again, restore from the trash', async ({ page }) => {
  const n = await selectBars(page);
  const friends = n - MY_BARS.length;
  expect(friends).toBeGreaterThan(0);

  await page.getByTestId('bulk-delete').click();
  const confirm = page.getByTestId('bulk-delete-confirm');
  await expect(confirm).toContainText('Move 2 places to the trash? You can restore them from the trash for 30 days.');
  await expect(confirm.getByTestId('bulk-skipped')).toContainText(`${friends} selected place`);
  await expect(page.getByTestId('bulk-delete')).toHaveText('Delete (2)');
  await page.getByTestId('bulk-delete-yes').click();

  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
  await expect(page.getByTestId('trash-notice')).toContainText('2 places moved to the trash.');
  for (const name of MY_BARS) await expect(page.getByTestId(`row-${name}`)).toHaveCount(0);
  await expect(page.getByTestId(`row-${THEIR_BAR}`)).toBeVisible();

  // One undo brings both back.
  await page.getByTestId('trash-undo').click();
  for (const name of MY_BARS) await expect(page.getByTestId(`row-${name}`)).toBeVisible();

  // Again, then from the trash screen.
  await page.getByTestId('list-select').click();
  await page.getByTestId('select-all').click();
  await page.getByTestId('bulk-delete').click();
  await page.getByTestId('bulk-delete-yes').click();
  for (const name of MY_BARS) await expect(page.getByTestId(`row-${name}`)).toHaveCount(0);
  await page.waitForTimeout(1500); // the database file is written after a short debounce

  await page.goto(autostart('/trash'));
  await expect(page.getByTestId('trash-screen')).toBeVisible({ timeout: 30_000 });
  const items = page.locator('[data-testid^="trash-item-"]');
  await expect(items).toHaveCount(2);
  for (const name of MY_BARS) await items.filter({ hasText: name }).getByTestId('trash-restore').click();
  await expect(page.getByTestId('trash-empty')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.goto(autostart('/list'));
  for (const name of MY_BARS) await expect(page.getByTestId(`row-${name}`)).toBeVisible({ timeout: 30_000 });
});

test('tick two places, add a tag, remove it, set a status', async ({ page }) => {
  await page.goto(autostart('/list'));
  await expect(page.getByTestId('row-Musée d’Orsay')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('list-select').click();
  await page.getByTestId('row-Musée d’Orsay').click();
  await page.getByTestId('row-Sacré-Cœur steps').click();
  await expect(page.getByTestId('select-count')).toHaveText('2 selected');
  // Ticking does not open the card.
  await expect(page.getByTestId('place-card').filter({ visible: true })).toHaveCount(0);

  await page.getByTestId('bulk-tag').click();
  await page.getByTestId('bulk-tag-Hotel').click();
  await expect(page.getByTestId('bulk-notice')).toHaveText('“Hotel” added to 2 places.');
  await expect(page.getByTestId('row-Musée d’Orsay')).toContainText('Hotel');
  await expect(page.getByTestId('row-Sacré-Cœur steps')).toContainText('Hotel');

  await page.getByTestId('list-select').click();
  await page.getByTestId('row-Musée d’Orsay').click();
  await page.getByTestId('row-Sacré-Cœur steps').click();
  await page.getByTestId('bulk-tag').click();
  await page.getByTestId('bulk-tag-mode').getByText('Remove a tag').click();
  await page.getByTestId('bulk-tag-Hotel').click();
  await expect(page.getByTestId('bulk-notice')).toHaveText('“Hotel” removed from 2 places.');
  await expect(page.getByTestId('row-Sacré-Cœur steps')).not.toContainText('Hotel');

  await page.getByTestId('list-select').click();
  await page.getByTestId('row-Musée d’Orsay').click();
  await page.getByTestId('row-Sacré-Cœur steps').click();
  await page.getByTestId('bulk-status').click();
  await page.getByTestId('bulk-status-tried').click();
  await expect(page.getByTestId('bulk-notice')).toHaveText('2 places updated.');
  await expect(page.getByTestId('row-Musée d’Orsay')).toContainText('Tried');
  await expect(page.getByTestId('row-Sacré-Cœur steps')).toContainText('Tried');

  // Cancel leaves the mode without changing anything.
  await page.getByTestId('list-select').click();
  await expect(page.getByTestId('bulk-bar')).toBeVisible();
  await page.getByTestId('list-select').click();
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
});

test('the list header opens Friends', async ({ page }) => {
  await page.goto(autostart('/list'));
  await page.getByTestId('open-friends').click({ timeout: 30_000 });
  await expect(page.getByTestId('contacts-screen')).toBeVisible();
  await expect(page.getByTestId('contacts-empty-invite')).toBeVisible();
});
