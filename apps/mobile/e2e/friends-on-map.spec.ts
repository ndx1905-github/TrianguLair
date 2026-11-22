/**
 * Whose places (spec "Interface" > "Whose places"), on the demo data: my places and those of the
 * demo friend Léa (Le Perchoir, Parc des Buttes-Chaumont… and Le Comptoir du Relais, which we both
 * have). The filter bar's first row picks whose places are shown; Léa's pins carry her coloured dot;
 * the card says whose maps a place is on; her page sets her colour and shows only her places.
 *
 * `SHOTS=1` also writes the screenshots of docs/ (phone-whose-*.png, phone-pin-dots.png…).
 */
import type { Page } from '@playwright/test';

import { autostart, collapseFilters, demo, diagnose, expect, jump, openMap, test } from './helpers';

const SHOTS = process.env['SHOTS'] === '1';
const LEA = 'demo-friend-lea';
/** The example friend's name (main #10: marked as an example). */
const NAME = 'Léa (example)';
/** Mine only: Du Pain et des Idées. */
const MINE = { id: demo(1), lat: 48.8713, lon: 2.3633 };
/** Léa's only: Le Perchoir. */
const HERS = { id: demo(10), lat: 48.8612, lon: 2.3811 };
/** Both of us: Le Comptoir du Relais. */
const BOTH = { id: demo(2), lat: 48.8519, lon: 2.3388 };

async function shot(page: Page, file: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `docs/${file}` });
}

const pin = (page: Page, id: string) => page.locator(`[data-pin-id="${id}"]`);

async function expandFilters(page: Page): Promise<void> {
  const toggle = page.getByTestId('filter-toggle').filter({ visible: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId('whose-row')).toBeVisible();
}

/** Is the pin of this place drawn, after centering the map on it (zoom 16: no clusters)? */
async function shown(page: Page, p: { id: string; lat: number; lon: number }): Promise<boolean> {
  await jump(page, p.lat, p.lon, 16);
  return (await pin(page, p.id).count()) > 0;
}

async function longPress(page: Page, testId: string): Promise<void> {
  const box = (await page.getByTestId(testId).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test('whose places: me, a friend, everyone; dots on the pins; remembered', async ({ page }) => {
  await openMap(page);
  await expandFilters(page);
  await expect(page.getByTestId('whose-label')).toHaveText('Everyone');
  await expect(page.getByTestId('whose-me')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId(`whose-friend-${NAME}`)).toHaveAttribute('aria-checked', 'true');
  // The old "Friends' places" visibility pill is gone: whose places are chosen here.
  await expect(page.getByTestId('filter-visibility-friendsOnly')).toHaveCount(0);
  await shot(page, 'phone-whose-row.png');

  // Her place: one dot, her name in its label; mine only: no dot; ours: her dot too.
  expect(await shown(page, HERS)).toBe(true);
  await expect(pin(page, HERS.id)).toHaveAttribute('data-dots', '1');
  await expect(pin(page, HERS.id)).toHaveAttribute('aria-label', `Le Perchoir, on ${NAME}’s map`);
  expect(await shown(page, MINE)).toBe(true);
  await expect(pin(page, MINE.id)).not.toHaveAttribute('data-dots');
  expect(await shown(page, BOTH)).toBe(true);
  await expect(pin(page, BOTH.id)).toHaveAttribute('data-dots', '1');
  await expect(pin(page, BOTH.id).locator('.tl-dots circle')).toHaveCount(1);

  // "Me" off: my own places leave the map, ours stays (it is on Léa's map).
  await page.getByTestId('whose-me').click();
  await expect(page.getByTestId('whose-label')).toHaveText(`Only ${NAME}`);
  expect(await shown(page, MINE)).toBe(false);
  expect(await shown(page, HERS)).toBe(true);
  expect(await shown(page, BOTH)).toBe(true);
  // The last one shown cannot be unticked: never an empty map.
  await page.getByTestId(`whose-friend-${NAME}`).click();
  await expect(page.getByTestId(`whose-friend-${NAME}`)).toHaveAttribute('aria-checked', 'true');

  // Long press on "Me": only mine.
  await longPress(page, 'whose-me');
  await expect(page.getByTestId('whose-label')).toHaveText('Only mine');
  expect(await shown(page, HERS)).toBe(false);
  expect(await shown(page, MINE)).toBe(true);
  // Ours is mine: drawn, without her dot (her places are not shown).
  expect(await shown(page, BOTH)).toBe(true);
  await expect(pin(page, BOTH.id)).not.toHaveAttribute('data-dots');

  // The panel: shortcuts, "Only" on each row.
  await page.getByTestId('friends-picker-open').click();
  await expect(page.getByTestId('friends-picker')).toBeVisible();
  await expect(page.getByTestId('whose-only-mine')).toHaveAttribute('aria-checked', 'true');
  await shot(page, 'phone-whose-panel.png');
  await page.getByTestId('whose-everyone').click();
  await expect(page.getByTestId('friends-picker')).toHaveCount(0);
  await expect(page.getByTestId('whose-label')).toHaveText('Everyone');
  await page.getByTestId('friends-picker-open').click();
  await page.getByTestId(`friends-person-${NAME}-only`).click();
  await expect(page.getByTestId('whose-label')).toHaveText(`Only ${NAME}`);

  // Folded: one pill says it, and it is remembered on this device.
  await collapseFilters(page);
  await expect(page.getByTestId('filter-pill-friends-shown')).toContainText(`Only ${NAME}`);
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId('filter-pill-friends-shown')).toContainText(`Only ${NAME}`);
  expect(await shown(page, MINE)).toBe(false);
  await jump(page, 48.866, 2.356, 12);
  await shot(page, 'phone-whose-only-friend.png');
  // Its cross: everyone again.
  await page.getByTestId('filter-pill-friends-shown').getByRole('button').click();
  await expect(page.getByTestId('filter-pill-friends-shown')).toHaveCount(0);
  expect(await shown(page, MINE)).toBe(true);
});

test('the card says whose maps a place is on; a name shows only theirs', async ({ page }) => {
  await openMap(page);
  await collapseFilters(page);
  if (SHOTS) {
    // Saint-Germain: mine (no dot), Léa's (her dot) and ours (mine, with her dot).
    const later = page.getByTestId('closure-notice-later');
    if (await later.waitFor({ timeout: 5000 }).then(() => true, () => false)) await later.click();
    await jump(page, 48.8545, 2.3398, 13.5);
    await shot(page, 'phone-pin-dots.png');
  }
  await jump(page, BOTH.lat + 0.0012, BOTH.lon, 16);
  await pin(page, BOTH.id).click();
  const card = page.getByTestId('place-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('card-on-maps')).toContainText('On the maps of:');
  await expect(card.getByTestId(`card-on-map-${NAME}`)).toHaveAccessibleName(`Show only ${NAME}’s places`);
  if (SHOTS) {
    await card.getByTestId('card-friends-toggle').click();
    await card.getByTestId('card-on-maps').scrollIntoViewIfNeeded();
    await shot(page, 'phone-card-on-maps.png');
  }
  await card.getByTestId(`card-on-map-${NAME}`).click();
  await page.getByTestId('card-close').click();
  await expect(page.getByTestId('filter-pill-friends-shown')).toContainText(`Only ${NAME}`);
  expect(await shown(page, MINE)).toBe(false);
  expect(await shown(page, HERS)).toBe(true);
});

test('a friend\'s page: their colour on the dots, "See their places on the map"', async ({ page }) => {
  await openMap(page);
  if (process.env['CI']) {
    // Diagnostics (CI only): is the database file saved before the next page loads?
    const size = () =>
      page.evaluate(
        () =>
          new Promise<string>((resolve) => {
            const r = indexedDB.open('triangulair', 1);
            r.onsuccess = () => {
              const g = r.result.transaction('files').objectStore('files').get('main.sqlite');
              g.onsuccess = () => resolve(String((g.result as Uint8Array | undefined)?.byteLength ?? 'none'));
              g.onerror = () => resolve('error');
            };
            r.onerror = () => resolve('open-error');
          }),
      );
    console.log(`[idb] at pins: ${await size()}`);
    await page.waitForTimeout(1500);
    console.log(`[idb] 1.5 s later: ${await size()}; pins ${await page.locator('[data-pin-id]').count()}; ${await page.getByTestId('filter-count').textContent()}`);
  }
  await page.goto(autostart(`/contacts/${LEA}`));
  const section = page.getByTestId('friend-on-map');
  await expect(section).toBeVisible({ timeout: 30_000 }).catch(async (e: unknown) => {
    await diagnose(page, 'no friend section');
    throw e;
  });
  await section.getByTestId('friend-color-green').click();
  await expect(section.getByTestId('friend-color-green')).toHaveAttribute('aria-checked', 'true');
  await expect(section.getByTestId('friend-color-reset')).toBeVisible();
  await shot(page, 'phone-friend-colour.png');
  await section.getByTestId('friend-see-on-map').click();
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  expect(await shown(page, HERS)).toBe(true);
  await expect(pin(page, HERS.id).locator('.tl-dots circle')).toHaveAttribute('fill', '#16A34A');
  expect(await shown(page, MINE)).toBe(false);
  await expandFilters(page);
  await expect(page.getByTestId('whose-label')).toHaveText(`Only ${NAME}`);
});

test('an older device: the "Friends\' places" filter becomes "Only Léa"; French labels', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('tl-e2e-seeded')) return;
    sessionStorage.setItem('tl-e2e-seeded', '1');
    localStorage.setItem('triangulair:filter-state', JSON.stringify({ v: 1, tagIds: [], criteria: [], visibility: ['friendsOnly'] }));
    localStorage.setItem('triangulair:friends-shown', JSON.stringify({ v: 1, mode: 'all' }));
  });
  await openMap(page, '/?lang=fr');
  await expandFilters(page);
  await expect(page.getByTestId('whose-row')).toContainText('Lieux de qui');
  await expect(page.getByTestId('whose-label')).toHaveText('Seulement Léa (exemple)');
  await expect(page.getByTestId('filter-visibility-friendsOnly')).toHaveCount(0);
  expect(await shown(page, MINE)).toBe(false);
  expect(await shown(page, HERS)).toBe(true);
  await expect(pin(page, HERS.id)).toHaveAttribute('aria-label', 'Le Perchoir, sur la carte de Léa (exemple)');
});
