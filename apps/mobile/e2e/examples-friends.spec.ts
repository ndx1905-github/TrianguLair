/**
 * Beta feedback (0.9.0-beta.1): the example places and the friends screen.
 *
 * The fixture build seeds the former demo data (my saves of sample places and the example friend
 * Léa), like a phone that installed the beta: it must get "Delete the example places". Real builds
 * seed no example (unit tests in src/data/data.test.ts; the Android smoke test checks that the
 * banner is not shown after a first launch).
 */
import { autostart, collapseFilters, demo, expect, jump, matchingPinIds, pinIds, test } from './helpers';

/** The sample places the example friend saved (src/data/demo.ts: not mine, or also hers). */
const LEA = [2, 9, 10, 11, 13, 14].map(demo);

test('the example places: marked, deleted in one tap from the map, the example friend too', async ({ page }) => {
  await page.goto(autostart('/?examplesBanner=1'));
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  const banner = page.getByTestId('examples-banner');
  await expect(banner).toContainText('These are example places: they stay on this phone and are never shared.');
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
  await page.getByTestId('open-friends').click();
  await expect(page.getByTestId('contacts-screen')).toBeVisible();
  await expect(page.getByTestId('contact-example')).toHaveCount(0);
  await page.goto(autostart('/settings'));
  await expect(page.getByTestId('settings')).toBeVisible();
  await expect(page.getByTestId('settings-examples')).toHaveCount(0);
});

test('Settings › Example places: the same delete, in French too', async ({ page }) => {
  await page.goto(autostart('/settings?lang=fr'));
  await expect(page.getByTestId('settings-examples')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('settings-examples-delete').click();
  await expect(page.getByTestId('settings-examples-deleted')).toHaveText(/lieux d’exemple supprimés/);
  // Let the browser database save it (as the other specs' `settle`) before the page reloads.
  await page.waitForTimeout(1200);
  await page.goto(autostart('/list?lang=fr'));
  await expect(page.getByTestId('place-list')).toBeVisible();
  await expect(page.getByTestId('row-Le Baron Rouge')).toHaveCount(0);
  await expect(page.getByTestId('examples-banner')).toHaveCount(0);
});

test('Friends from the map: how to invite with nobody yet, and the example friend’s places', async ({ page }) => {
  await page.goto(autostart('/'));
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await page.getByTestId('open-friends').click();
  await expect(page.getByTestId('contacts-screen')).toBeVisible();
  await expect(page.getByTestId('contacts-empty')).toContainText('To see a friend’s places, invite them');
  await expect(page.getByTestId('contacts-empty-invite')).toBeVisible();
  await expect(page.getByTestId('contact-example')).toContainText('Léa (example)');

  await page.getByTestId('contact-example-see-places').click();
  await expect(page.getByTestId('open-add')).toBeVisible();
  // Only her places among my friends', with "Also at my friends'": hers in color, mine faded.
  await expect(page.getByTestId('filter-pill-friends-shown')).toBeVisible();
  await collapseFilters(page);
  await jump(page, 48.865, 2.355, 12);
  const matching = await matchingPinIds(page);
  expect(matching.length).toBeGreaterThan(0);
  expect(matching.every((id) => LEA.includes(id))).toBe(true);
  expect((await pinIds(page)).some((id) => !LEA.includes(id))).toBe(true);

  // The pill gives every friend back.
  await page.getByTestId('filter-pill-friends-shown').getByRole('button').click();
  await expect(page.getByTestId('filter-pill-friends-shown')).toHaveCount(0);
});

test('the invitation step: "Invite a friend" from the empty friends list', async ({ page }) => {
  await page.goto(autostart('/contacts'));
  await page.getByTestId('contacts-empty-invite').click();
  await expect(page).toHaveURL(/\/invite/);
});
