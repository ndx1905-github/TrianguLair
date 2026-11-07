/**
 * Two people share their places (T-210), end to end, against the real Apache WebDAV server of
 * packages/storage/scripts/real-servers.sh (as root; 127.0.0.1:8081, /dav with a password, /pub
 * anonymous). Skipped when it is not running.
 *
 * Two browser contexts, two identities (Anna and Ben), each with their own folder. The write side
 * goes through a small CORS proxy (as in storage.spec.ts); friends' certified read addresses are
 * `https://friends.triangulair.test/pub/<folder>/`, answered by Playwright from Apache's /pub.
 * Adding each other as contacts goes through the fixture-mode hook `window.__tlSync.addContact`
 * (a stand-in for the invitation and return link screens, T-208/T-209).
 *
 * `SHOTS=1` also writes the screenshots of docs/ (sync status, friends' places, What's new).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import { autostart, expect, jump, preparePage, test } from './helpers';

const DAV = 'http://127.0.0.1:8081';
const AUTH = 'Basic ' + Buffer.from('alice:s3cret').toString('base64');
const FRIENDS = 'https://friends.triangulair.test';
const SHOTS = process.env['SHOTS'] === '1';
const SHARED = 'Le Comptoir des Archives';
const PRIVATE = 'Café Pendule';

let proxy: http.Server | null = null;
let proxyUrl = '';

async function davUp(): Promise<boolean> {
  try {
    const r = await fetch(`${DAV}/dav/`, { method: 'PROPFIND', headers: { authorization: AUTH, depth: '0' } });
    return r.status === 207;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  if (!(await davUp())) return;
  proxy = http.createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-methods': 'GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, Depth, If-Match, If-None-Match',
      'access-control-expose-headers': 'ETag, OC-ETag, Content-Length',
      vary: 'Origin',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const up = http.request({ host: '127.0.0.1', port: 8081, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1:8081' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...r.headers, ...cors });
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502, cors);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
});

const folder = (who: string) => `e2e-sync-${who}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface Person {
  ctx: BrowserContext;
  page: Page;
  dir: string;
  location: string;
  errors: string[];
}

async function person(browser: Browser, name: string, viewport = { width: 390, height: 844 }): Promise<Person> {
  const ctx = await browser.newContext({ viewport, locale: 'en-US', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  const errors = await preparePage(page);
  await page.route(`${FRIENDS}/**`, async (route) => {
    const url = route.request().url().replace(FRIENDS, DAV);
    const r = await route.fetch({ url, headers: {} });
    await route.fulfill({ response: r, headers: { ...r.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' } });
  });
  const dir = folder(name.toLowerCase());
  await page.goto(autostart(`/storage?name=${name}`));
  await page.getByTestId('storage-connect').click();
  await page.getByTestId('choice-webdav').click();
  await page.getByTestId('field-davUrl').fill(`${proxyUrl}/dav/${dir}/`);
  await page.getByTestId('field-davUser').fill('alice');
  await page.getByTestId('field-davPassword').fill('s3cret');
  await page.getByTestId('field-readUrl').fill(`${FRIENDS}/pub/${dir}/`);
  await page.getByTestId('setup-test').click();
  await expect(page.getByTestId('test-summary')).toContainText('Everything works', { timeout: 30_000 });
  await page.getByTestId('master-go').click();
  await expect(page.getByTestId('storage-connected-banner')).toBeVisible();
  await waitPublished(page);
  return { ctx, page, dir, location: `${FRIENDS}/pub/${dir}/`, errors };
}

export type Hook = {
  owner(): string | null;
  addContact(i: { location: string; owner?: string; name?: string; follow: boolean; share: boolean }): Promise<string>;
  setPolicy(owner: string, p: { share?: boolean; follow?: boolean }): Promise<void>;
  sync(): Promise<void>;
  snapshot(): { publishes: boolean; status: { lastSuccess: number | null; state: string; pending: number }; unseen: number; friends: { name: string; places: number }[] } | null;
};

async function waitPublished(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => {
      const s = (window as unknown as { __tlSync?: { snapshot(): { publishes: boolean; status: { lastSuccess: number | null } } | null } }).__tlSync?.snapshot();
      return !!s?.publishes && s.status.lastSuccess !== null;
    }), { timeout: 30_000 })
    .toBe(true);
}

const sync = async (p: Person) => {
  await p.page.evaluate(async () => (window as unknown as { __tlSync: { sync(): Promise<void> } }).__tlSync.sync());
  await settle(p.page);
};

async function addPlace(page: Page, name: string, opts: { comment?: string; private?: boolean }): Promise<void> {
  await page.goto(autostart('/'));
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await jump(page, 48.8594, 2.3624, 16);
  await page.getByTestId('open-add').click();
  await page.getByTestId(`candidate-${name}`).click();
  const form = page.getByTestId('add-form');
  await expect(form).toBeVisible();
  if (opts.comment) await form.getByTestId('comment').fill(opts.comment);
  if (opts.private) await form.getByTestId('sharing').getByRole('radio', { name: 'Private' }).click();
  await page.getByTestId('save-place').click();
  await expect(page.getByTestId('place-card')).toBeVisible();
  await page.getByTestId('card-close').click();
  await settle(page);
}

/** The web build saves its database file 400 ms after a write: wait before reloading the page. */
const settle = (page: Page) => page.waitForTimeout(1200);

async function shot(page: Page, file: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `docs/${file}` });
}

test('two people: publish, follow, shared places only, edits in What\'s new, revocation, errors', async ({ browser }) => {
  test.skip(!proxy, 'Apache WebDAV on 127.0.0.1:8081 is not running (packages/storage/scripts/real-servers.sh)');
  test.setTimeout(240_000);
  const anna = await person(browser, 'Anna');
  const ben = await person(browser, 'Ben');

  // Anna saves one place shared with friends (with a comment) and one private place.
  await addPlace(anna.page, SHARED, { comment: 'Ask for the cider on the terrace.' });
  await addPlace(anna.page, PRIVATE, { private: true });
  await sync(anna);

  // They become contacts (the invitation flow's result): Ben follows Anna, Anna shares with Ben.
  const annaId = await anna.page.evaluate(() => (window as unknown as { __tlSync: { owner(): string } }).__tlSync.owner());
  await ben.page.evaluate(([location, owner]) => (window as unknown as { __tlSync: Hook }).__tlSync.addContact({ location: location!, owner: owner!, name: 'Anna', follow: true, share: false }), [anna.location, annaId] as const);
  const benId = await anna.page.evaluate((location) => (window as unknown as { __tlSync: Hook }).__tlSync.addContact({ location, name: 'Ben', follow: false, share: true }), ben.location);
  await sync(anna);
  await sync(ben);

  // Ben sees Anna's shared place, not her private one.
  const b = ben.page;
  await b.goto(autostart('/list'));
  const row = b.getByTestId(`row-${SHARED}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('1 friend');
  await expect(row).toContainText('Friends’ place');
  await b.getByTestId('list-search').fill('Pendule');
  await expect(b.getByTestId(`row-${PRIVATE}`)).toHaveCount(0);
  await b.getByTestId('list-search').fill('');

  // The card: "1 friend", which opens who saved it and her comment.
  await row.click();
  const card = b.getByTestId('place-card').filter({ visible: true });
  await expect(card.getByTestId('card-friends-count')).toHaveText('1 friend');
  await card.getByTestId('card-friends-toggle').click();
  await expect(card.getByTestId('card-friend-Anna')).toContainText('Ask for the cider on the terrace.');
  await shot(b, 'phone-card-friends.png');

  // Ben's sync status: Anna, read just now.
  await b.goto(autostart('/sync'));
  await expect(b.getByTestId('sync-person-Anna')).toContainText('Updated');
  await expect(b.getByTestId('sync-state')).toHaveText('Up to date');
  await shot(b, 'phone-sync-status.png');

  // Ben visits What's new once (her first places: one grouped item), then Anna edits.
  await b.goto(autostart('/whatsnew'));
  await expect(b.getByTestId('whatsnew-item-followed')).toContainText('Anna shares');
  await b.getByTestId('back').click();

  const a = anna.page;
  await a.goto(autostart('/list'));
  await a.getByTestId('list-search').fill('Comptoir des Archives');
  await a.getByTestId(`row-${SHARED}`).click();
  const aCard = a.getByTestId('place-card').filter({ visible: true });
  await aCard.getByTestId('comment').fill('Best cider in the Marais, ask for Paul.');
  await aCard.getByTestId('comment').press('Tab');
  await settle(a);
  await aCard.getByTestId('status').getByRole('radio', { name: 'Favorite' }).click();
  await settle(a);
  await sync(anna);
  await sync(ben);

  await b.goto(autostart('/'));
  await expect(b.getByTestId('whatsnew-badge')).toHaveText('2', { timeout: 30_000 });
  await expect(b.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await jump(b, 48.8594, 2.3624, 16);
  if (SHOTS) {
    // "Also at my friends'": friends' places in color, the bar folded.
    const t = b.getByTestId('filter-toggle').filter({ visible: true });
    if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
    await b.getByTestId('filter-criterion-friends').click();
    await t.click();
    await shot(b, 'phone-friends-map.png');
    await t.click();
    await b.getByTestId('filter-criterion-friends').click();
    await t.click();
    await settle(b);
  }
  await b.getByTestId('open-whatsnew').click();
  const item = b.getByTestId('whatsnew-item-comment');
  await expect(item).toContainText('Anna commented on Le Comptoir des Archives');
  await expect(item).toContainText('Best cider in the Marais');
  await expect(item.getByTestId('whatsnew-unseen')).toBeVisible();
  await shot(b, 'phone-whatsnew.png');
  // Comments only, then "See on the map": her place in color, the others faded.
  await b.getByTestId('whatsnew-type-comments').click();
  await expect(b.getByTestId('whatsnew-item-followed')).toHaveCount(0);
  await b.getByTestId('whatsnew-map').click();
  await expect(b.getByTestId('whatsnew-highlight')).toBeVisible();
  await expect(b.locator('[data-pin-id][data-greyed]').first()).toBeAttached({ timeout: 15_000 });
  expect(await b.locator('[data-pin-id]:not([data-greyed])').count()).toBeLessThanOrEqual(2);

  // The friends panel: show nobody's places, then all again.
  await b.getByTestId('whatsnew-highlight').getByRole('button').click();
  const toggle = b.getByTestId('filter-toggle').filter({ visible: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await b.getByTestId('friends-picker-open').click();
  await expect(b.getByTestId('friends-person-Anna')).toContainText('place');
  await shot(b, 'phone-friends-picker.png');
  await b.getByTestId('friends-person-Anna').click();
  await b.getByTestId('friends-done').click();
  await settle(b);
  await b.goto(autostart('/list'));
  await expect(b.getByTestId(`row-${SHARED}`)).toHaveCount(0);
  await b.goto(autostart('/'));
  const bar = b.getByTestId('filter-toggle').filter({ visible: true });
  if ((await bar.getAttribute('aria-expanded')) === 'true') await bar.click();
  await expect(b.getByTestId('filter-pill-friends-shown')).toContainText('Friends: 1');
  await b.getByTestId('filter-pill-friends-shown').getByRole('button').click();
  await settle(b);
  await b.goto(autostart('/list'));
  await expect(b.getByTestId(`row-${SHARED}`)).toBeVisible();

  if (SHOTS) {
    // French, dark and tablet variants of the same screens.
    await b.goto(autostart('/whatsnew?lang=fr'));
    await expect(b.getByTestId('whatsnew-item-comment')).toContainText('a commenté');
    await shot(b, 'phone-fr-whatsnew.png');
    await b.emulateMedia({ colorScheme: 'dark' });
    await b.goto(autostart('/sync'));
    await expect(b.getByTestId('sync-person-Anna')).toBeVisible();
    await shot(b, 'phone-dark-sync-status.png');
    await b.emulateMedia({ colorScheme: 'light' });
    await b.setViewportSize({ width: 834, height: 1112 });
    await b.goto(autostart('/list?lang=fr'));
    await b.getByTestId(`row-${SHARED}`).click();
    await b.getByTestId('card-friends-toggle').filter({ visible: true }).click();
    await shot(b, 'tablet-fr-card-friends.png');
    await b.setViewportSize({ width: 390, height: 844 });
  }

  // Errors on Anna's side: offline with a change waiting, then credentials rejected.
  await a.goto(autostart('/'));
  await expect(a.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await anna.ctx.setOffline(true);
  await a.evaluate(() => window.dispatchEvent(new Event('offline')));
  await a.getByTestId('open-list').click();
  await a.getByTestId('list-search').fill('Comptoir des Archives');
  await a.getByTestId(`row-${SHARED}`).click();
  await a.getByTestId('place-card').filter({ visible: true }).getByTestId('status').getByRole('radio', { name: 'Tried' }).click();
  await a.getByTestId('back').filter({ visible: true }).click();
  await a.getByTestId('back').filter({ visible: true }).click();
  await expect(a.getByTestId('sync-note-offline-pending')).toContainText('Offline · 1 change pending');
  const fold = a.getByTestId('filter-toggle').filter({ visible: true });
  if ((await fold.getAttribute('aria-expanded')) === 'true') await fold.click();
  await shot(a, 'phone-sync-offline.png');
  await anna.ctx.setOffline(false);
  await a.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(a.getByTestId('sync-note-offline-pending')).toHaveCount(0, { timeout: 30_000 });

  await a.route(`${proxyUrl}/**`, (r) => r.fulfill({ status: 401, headers: { 'access-control-allow-origin': '*', 'www-authenticate': 'Basic' } }));
  await sync(anna);
  await expect(a.getByTestId('sync-note-reconnect')).toContainText('Reconnect your storage', { timeout: 30_000 });
  const fold2 = a.getByTestId('filter-toggle').filter({ visible: true });
  if ((await fold2.getAttribute('aria-expanded')) === 'true') await fold2.click();
  await shot(a, 'phone-sync-reconnect.png');
  await a.getByTestId('sync-note-reconnect').click();
  await expect(a.getByTestId('storage-read-address')).toBeVisible();
  await a.goto(autostart('/sync'));
  await expect(a.getByTestId('sync-problem-reconnect')).toBeVisible();
  await shot(a, 'phone-sync-reconnect-status.png');
  await a.unroute(`${proxyUrl}/**`);
  await a.getByTestId('sync-now').click();
  await expect(a.getByTestId('sync-problem-reconnect')).toHaveCount(0, { timeout: 30_000 });

  // Anna stops sharing with Ben: his cache drops her places.
  await a.evaluate((owner) => (window as unknown as { __tlSync: Hook }).__tlSync.setPolicy(owner, { share: false }), benId);
  await sync(anna);
  await sync(ben);
  await b.goto(autostart('/list'));
  await expect(b.getByTestId('place-list')).toBeVisible();
  await expect(b.getByTestId(`row-${SHARED}`)).toHaveCount(0);
  const snap = await b.evaluate(() => (window as unknown as { __tlSync: Hook }).__tlSync.snapshot());
  expect(snap?.friends).toMatchObject([{ name: 'Anna', places: 0 }]);

  expect(anna.errors).toEqual([]);
  expect(ben.errors).toEqual([]);
  await anna.ctx.close();
  await ben.ctx.close();
});
