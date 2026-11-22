/**
 * Beta feedback (0.9.0-beta.1): the example places and the friends screen.
 *
 * The fixture build seeds the former demo data (my saves of sample places and the example friend
 * Léa), like a phone that installed the beta: it must get "Delete the example places". With
 * `?demoSeed=0` it is a real user's first launch instead: nothing seeded, and "Show me with
 * examples" on the last step adds the examples, local only (unit tests in src/data/data.test.ts).
 */
import type { Page } from '@playwright/test';

import { autostart, collapseFilters, expect, jump, pinIds, test } from './helpers';

/** A real user's first launch, up to the import step. */
async function firstLaunch(page: Page): Promise<void> {
  await page.goto('/?demoSeed=0');
  await page.getByTestId('welcome-start').click({ timeout: 30_000 });
  await page.getByTestId('profile-name').fill('Sam');
  await page.getByTestId('profile-continue').click();
  await page.getByTestId('lock-skip').click();
  await page.getByTestId('location-skip').click();
  await expect(page.getByTestId('welcome-import')).toBeVisible();
}

test('a real first launch: no example place unless asked', async ({ page }) => {
  await firstLaunch(page);
  await expect(page.getByTestId('import-examples')).toHaveText('Show me with examples');
  await page.getByTestId('import-later').click();
  await expect(page.getByTestId('open-add')).toBeVisible();
  await expect(page.getByTestId('examples-banner')).toHaveCount(0);
  await expect(page.locator('[data-pin-id]')).toHaveCount(0);

  // The list: empty, no banner; its header opens Friends, which explains how to invite.
  await page.getByTestId('open-list').click();
  await expect(page.getByTestId('place-list')).toContainText('No places yet');
  await expect(page.getByTestId('examples-banner')).toHaveCount(0);
  await page.getByTestId('open-friends').click();
  await expect(page.getByTestId('contacts-screen')).toBeVisible();
  await expect(page.getByTestId('contacts-empty')).toContainText('To see a friend’s places, invite them');
  await expect(page.getByTestId('contact-example')).toHaveCount(0);
  await page.getByTestId('contacts-empty-invite').click();
  await expect(page).toHaveURL(/\/invite/);
});

test('"Show me with examples": the example friend’s places, local only, deleted in one tap', async ({ page }) => {
  await firstLaunch(page);
  await page.getByTestId('import-examples').click();
  const banner = page.getByTestId('examples-banner');
  await expect(banner).toContainText('These are example places: they stay on this phone and are never shared.');
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });

  // They are the example friend's places, not mine: nothing to publish.
  await page.getByTestId('open-list').click();
  await expect(page.getByTestId('row-Le Baron Rouge')).toContainText('Friends’ place');
  await expect(page.getByTestId('examples-banner')).toBeVisible();
  await page.getByTestId('open-friends').click();
  await expect(page.getByTestId('contact-example')).toContainText('Léa (example)');
  await page.getByTestId('back').click();

  await page.getByTestId('examples-delete').click();
  await expect(page.getByTestId('examples-deleted')).toHaveText(/15 example places deleted/);
  await expect(page.getByTestId('row-Le Baron Rouge')).toHaveCount(0);
  await expect(page.getByTestId('place-list')).toContainText('No places yet');
  await page.getByTestId('open-friends').click();
  await expect(page.getByTestId('contact-example')).toHaveCount(0);
  await expect(page.getByTestId('contacts-empty')).toBeVisible();
});

test('the beta’s seed: marked as examples, deleted in one tap from the map, the example friend too', async ({ page }) => {
  await page.goto(autostart('/?examplesBanner=1'));
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  const banner = page.getByTestId('examples-banner');
  await expect(banner).toContainText('These are example places');
  await collapseFilters(page);
  await jump(page, 48.865, 2.355, 12);
  expect((await pinIds(page)).filter((id) => id.startsWith('local:demoplace')).length).toBeGreaterThan(5);

  await page.getByTestId('examples-delete').click();
  await expect(page.getByTestId('examples-deleted')).toHaveText(/example places deleted/);
  await expect(banner).toHaveCount(0);
  await jump(page, 48.865, 2.355, 12);
  expect((await pinIds(page)).filter((id) => id.startsWith('local:demoplace'))).toEqual([]);
  await page.waitForTimeout(1200);

  // The example friend is gone from the friends screen; nothing left to delete in Settings.
  await page.goto(autostart('/contacts'));
  await expect(page.getByTestId('contacts-screen')).toBeVisible();
  await expect(page.getByTestId('contact-example')).toHaveCount(0);
  await page.goto(autostart('/settings'));
  await expect(page.getByTestId('settings')).toBeVisible();
  await expect(page.getByTestId('settings-examples')).toHaveCount(0);
});

test('Settings › My content › Example places: the same delete, in French too', async ({ page }) => {
  await page.goto(autostart('/settings?lang=fr'));
  await expect(page.getByTestId('settings-my-content').getByTestId('settings-examples')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('settings-examples-delete').click();
  await expect(page.getByTestId('settings-examples-deleted')).toHaveText(/lieux d’exemple supprimés/);
  // Let the browser database save it (as the other specs' `settle`) before the page reloads.
  await page.waitForTimeout(1200);
  await page.goto(autostart('/list?lang=fr'));
  await expect(page.getByTestId('place-list')).toBeVisible();
  await expect(page.getByTestId('row-Le Baron Rouge')).toHaveCount(0);
  await expect(page.getByTestId('examples-banner')).toHaveCount(0);
});
