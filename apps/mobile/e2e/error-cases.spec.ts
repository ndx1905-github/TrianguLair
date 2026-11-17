/**
 * Spec "Error cases" (T-213), the rows that are a visible flow on their own. The others are covered
 * by sync.spec.ts (offline with changes pending, credentials rejected and reconnecting), by
 * invitations.spec.ts and lists-sharing.spec.ts (links that no longer work), and by the unit tests
 * mapped in docs/error-cases.md.
 */
import { expect, openMap, preparePage, test } from './helpers';

test('key missing from the phone\'s vault (system restore): nothing opens, the recovery kit is asked', async ({ page }) => {
  const errors = await preparePage(page);
  await openMap(page);
  // A restore brings the app's data back without the system vault's keys: the device keys are gone.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('triangulair-secrets', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('secrets', 'readwrite');
          tx.objectStore('secrets').delete('device-keys');
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  // Every screen (here the sync status) sends to the request for the recovery kit.
  await page.goto('/sync');
  const screen = page.getByTestId('welcome-keys-missing');
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await expect(screen).toContainText('Your keys are no longer on this device');
  await expect(screen).toContainText('Nothing is sent or changed until you restore them');
  await expect(page.getByTestId('sync-status')).toHaveCount(0);
  await page.getByTestId('keys-missing-restore').click();
  await expect(page.getByTestId('welcome-device-screen')).toBeVisible();
  // French.
  await page.goto('/?lang=fr');
  await expect(page.getByTestId('welcome-keys-missing')).toContainText('Vos clés ne sont plus sur cet appareil');
  expect(errors).toEqual([]);
});
