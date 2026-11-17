/**
 * Adding a device and declaring it lost (T-206, T-207), end to end, against the real Apache WebDAV
 * server of packages/storage/scripts/real-servers.sh (as root; 127.0.0.1:8081). Skipped when it is
 * not running. Same setup as sync.spec.ts: a CORS proxy for the write side, the friends' read
 * addresses `https://friends.triangulair.test/pub/<folder>/` answered from Apache's /pub.
 *
 * Anna and Ben are friends (invitation, answer, acceptance). Anna adds a second device by link +
 * 6-word code: a fresh browser context goes through "I already have TrianguLair on another device",
 * opens the link with the code and gives a request link back; the first device opens it, and
 * approves once the last 4 digits of the number the new device shows are typed (wrong digits
 * first: refused); only then are the keys sent; both see the same places, an
 * edit on either reaches the other. Then Anna declares the second device lost from the first: the
 * lost one is wiped at its next sync, Ben keeps reading Anna with her new key and sees the notice.
 *
 * `SHOTS=1` also writes the screenshots of docs/ (devices, link + code, confirmation, the new
 * device, the declaration with the storage guide, the changes screen, What's new; dark mode,
 * French tablet).
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
const FROM_TABLET = 'Fromagerie Martin';

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
      const location = typeof r.headers.location === 'string' ? r.headers.location.replace(DAV, proxyUrl) : undefined;
      res.writeHead(r.statusCode ?? 502, { ...r.headers, ...cors, ...(location && { location }) });
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

const folder = (who: string) => `e2e-dev-${who}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface Person {
  ctx: BrowserContext;
  page: Page;
  dir: string;
  location: string;
  errors: string[];
}

async function context(browser: Browser, opts: { viewport?: { width: number; height: number }; locale?: string; dark?: boolean } = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 390, height: 844 }, locale: opts.locale ?? 'en-US', timezoneId: 'Europe/Paris', ...(opts.dark && { colorScheme: 'dark' as const }) });
  const page = await ctx.newPage();
  const errors = await preparePage(page, opts.dark);
  await page.route(`${FRIENDS}/**`, async (route) => {
    const url = route.request().url().replace(FRIENDS, DAV);
    const r = await route.fetch({ url, headers: {} });
    await route.fulfill({ response: r, headers: { ...r.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' } });
  });
  return { ctx, page, errors };
}

async function person(browser: Browser, name: string, opts: { viewport?: { width: number; height: number }; lang?: string } = {}): Promise<Person> {
  const { ctx, page, errors } = await context(browser, opts);
  const dir = folder(name.toLowerCase());
  const lang = opts.lang ? `&lang=${opts.lang}` : '';
  await page.goto(autostart(`/storage?name=${name}${lang}`));
  await page.getByTestId('storage-connect').click();
  await page.getByTestId('choice-webdav').click();
  await page.getByTestId('field-davUrl').fill(`${proxyUrl}/dav/${dir}/`);
  await page.getByTestId('field-davUser').fill('alice');
  await page.getByTestId('field-davPassword').fill('s3cret');
  await page.getByTestId('field-readUrl').fill(`${FRIENDS}/pub/${dir}/`);
  await page.getByTestId('setup-test').click();
  await expect(page.getByTestId('test-summary')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('master-go').click();
  await expect(page.getByTestId('storage-connected-banner')).toBeVisible();
  const p = { ctx, page, dir, location: `${FRIENDS}/pub/${dir}/`, errors };
  await sync(p, lang);
  return p;
}

async function syncNow(page: Page): Promise<void> {
  const now = page.getByTestId('sync-now');
  await expect(now).toBeVisible({ timeout: 30_000 });
  await expect(now).toBeEnabled({ timeout: 60_000 });
  await now.click();
  await expect(now).toBeEnabled({ timeout: 60_000 });
}

/** The web build saves its database file 400 ms after a write: wait before reloading the page. */
const settle = (page: Page) => page.waitForTimeout(1200);

async function sync(p: { page: Page }, lang = ''): Promise<void> {
  await p.page.goto(autostart(`/sync${lang ? `?${lang.slice(1)}` : ''}`));
  await syncNow(p.page);
  if (!lang) await expect(p.page.getByTestId('sync-state')).toHaveText('Up to date', { timeout: 30_000 });
  await settle(p.page);
}

async function invite(page: Page, forWhom: string): Promise<string> {
  await page.goto(autostart('/invite'));
  await page.getByTestId('invite-name').fill(forWhom);
  await page.getByTestId('invite-create').click();
  await expect(page.getByTestId('invite-ready')).toBeVisible({ timeout: 60_000 });
  await settle(page);
  return (await page.getByTestId('invite-link').textContent())!;
}

async function answer(page: Page, link: string, inviter: string): Promise<string> {
  await page.goto(`${autostart('/i')}#${link.split('#')[1]!}`);
  await expect(page.getByTestId('received-verified')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('received-name').fill(inviter);
  const back = page.getByTestId('received-share-back');
  if ((await back.getAttribute('aria-checked')) === 'true') await back.click();
  await page.getByTestId('received-answer').click();
  await expect(page.getByTestId('received-answered')).toBeVisible({ timeout: 60_000 });
  await settle(page);
  return (await page.getByTestId('received-return-link').textContent())!;
}

async function accept(page: Page, returnLink: string): Promise<void> {
  await page.goto(autostart('/invite'));
  await page.getByTestId('answer-input').fill(returnLink);
  await page.getByTestId('answer-open').click();
  await expect(page.getByTestId('answers-screen')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid^="answer-"][data-testid$="-accept"]').click();
  const follow = page.locator('[data-testid^="answer-"][data-testid$="-follow"]');
  if ((await follow.getAttribute('aria-checked')) === 'true') await follow.click();
  await page.locator('[data-testid^="answer-"][data-testid$="-confirm"]').click();
  await expect(page.getByTestId('answers-contacts')).toBeVisible({ timeout: 60_000 });
  await settle(page);
}

async function addPlace(page: Page, name: string, opts: { private?: boolean } = {}): Promise<void> {
  await page.goto(autostart('/'));
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await jump(page, 48.8594, 2.3624, 16);
  await page.getByTestId('open-add').click();
  await page.getByTestId(`candidate-${name}`).click();
  const form = page.getByTestId('add-form');
  await expect(form).toBeVisible();
  if (opts.private) await form.getByTestId('sharing').getByRole('radio', { name: 'Private' }).click();
  await page.getByTestId('save-place').click();
  await expect(page.getByTestId('place-card')).toBeVisible();
  await page.getByTestId('card-close').click();
  await settle(page);
}

/** Whether my list shows a place (search by name). */
async function listed(page: Page, name: string): Promise<void> {
  await page.goto(autostart('/list'));
  await page.getByTestId('list-search').fill(name);
  await expect(page.getByTestId(`row-${name}`)).toBeVisible({ timeout: 30_000 });
}

async function shot(page: Page, file: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `docs/${file}` });
}

test('a second device by link + code, then declared lost: wiped at its next sync, Ben follows the new key', async ({ browser }) => {
  test.skip(!proxy, 'Apache WebDAV of packages/storage/scripts/real-servers.sh is not running');
  test.setTimeout(720_000);
  const anna = await person(browser, 'Anna');
  const ben = await person(browser, 'Ben');
  const a = anna.page;

  // Friends: Anna invites Ben, Ben answers, Anna accepts (he sees what she shares with friends).
  const link = await invite(a, 'Ben');
  const back = await answer(ben.page, link, 'Anna');
  await accept(a, back);
  await addPlace(a, SHARED);
  await addPlace(a, PRIVATE, { private: true });
  await sync(anna);
  await sync(ben);
  await listed(ben.page, SHARED);

  // Settings › Devices: this device only, primary.
  await a.goto(autostart('/devices'));
  await expect(a.getByTestId('device-me')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('device-badge-primary')).toBeVisible();

  // Anna creates the link and the code on her first device.
  await a.goto(autostart('/devices/add'));
  await a.getByTestId('add-way').getByText('Link + code').click();
  await a.getByTestId('add-link-start').click();
  await expect(a.getByTestId('add-link-link')).toBeVisible({ timeout: 60_000 });
  const deviceLink = (await a.getByTestId('add-link-link').textContent())!;
  const code = (await a.getByTestId('add-code-text').textContent())!;
  expect(code.split(' ')).toHaveLength(6);
  await shot(a, 'phone-add-link.png');

  // The new device: first launch, "I already have TrianguLair on another device", link + code.
  const tablet = await context(browser);
  const t2 = tablet.page;
  await t2.goto('/welcome');
  await t2.getByTestId('welcome-device').click();
  await expect(t2.getByTestId('welcome-device-screen')).toBeVisible();
  await shot(t2, 'phone-welcome-device.png');
  await t2.getByTestId('device-link').click();
  await t2.getByTestId('device-name').fill('Anna’s tablet');
  await t2.getByTestId('device-link-input').fill(`Here is my link: ${deviceLink}`);
  // A wrong code first: nothing is used up.
  await t2.getByTestId('device-code').fill('abandon ability able about above absent');
  await t2.getByTestId('device-link-open').click();
  await expect(t2.getByTestId('device-link-error')).toContainText('does not match', { timeout: 60_000 });
  await t2.getByTestId('device-code').fill(code);
  await t2.getByTestId('device-link-open').click();
  await expect(t2.getByTestId('device-fingerprint')).toBeVisible({ timeout: 60_000 });
  const fingerprint = (await t2.getByTestId('device-fingerprint').textContent())!.trim();
  const requestLink = (await t2.getByTestId('device-request-link').textContent())!;
  await shot(t2, 'phone-device-waiting.png');

  // The request link comes back to the first device: the name and the number's first 8 digits.
  await a.getByTestId('add-link-reply').fill(`From my tablet: ${requestLink}`);
  await a.getByTestId('add-link-reply-open').click();
  await expect(a.getByTestId('add-confirm')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('add-confirm-name')).toHaveText('Add “Anna’s tablet”?');
  await expect(a.getByTestId('add-fingerprint')).toHaveText(`${fingerprint.slice(0, 9)} ····`);
  // Wrong last digits: nothing is certified.
  const last = fingerprint.replace(/\D/g, '').slice(-4);
  await a.getByTestId('add-digits').fill(last === '0000' ? '0001' : '0000');
  await a.getByTestId('master-go').click();
  await expect(a.getByTestId('add-digits-error')).toBeVisible();
  await a.getByTestId('add-digits').fill(last);
  await shot(a, 'phone-add-confirm.png');
  await a.getByTestId('master-go').click();
  // Done once the new device has picked its keys up.
  await expect(a.getByTestId('add-done')).toBeVisible({ timeout: 60_000 });

  // The new device opens the app and syncs: the same places.
  await expect(t2.getByTestId('filter-toggle').filter({ visible: true })).toBeVisible({ timeout: 60_000 });
  await settle(t2);
  await sync({ page: t2 });
  await t2.goto('/');
  await expect(t2.locator('[data-pin-id]').first()).toBeAttached({ timeout: 60_000 });
  await listed(t2, SHARED);
  await listed(t2, PRIVATE);
  // An edit on the new device reaches the first one.
  await addPlace(t2, FROM_TABLET);
  await sync({ page: t2 });
  await sync(anna);
  await listed(a, FROM_TABLET);

  // Both list the two devices.
  await a.goto(autostart('/devices'));
  await expect(a.getByTestId('device-other')).toContainText('Anna’s tablet', { timeout: 30_000 });
  await shot(a, 'phone-devices.png');
  await t2.goto('/devices');
  await expect(t2.getByTestId('device-me')).toContainText('Anna’s tablet', { timeout: 30_000 });
  await expect(t2.getByTestId('device-other')).toBeVisible();

  // The tablet is stolen: Anna declares it lost from her first device (primary: one tap).
  await a.goto(autostart('/devices'));
  await a.getByTestId('device-declare').click();
  await expect(a.getByTestId('lost-screen')).toBeVisible();
  if (SHOTS) {
    await a.emulateMedia({ colorScheme: 'dark' });
    await shot(a, 'phone-dark-lost-confirm.png');
    await a.emulateMedia({ colorScheme: 'light' });
  }
  await a.getByTestId('master-go').click();
  await expect(a.getByTestId('lost-done')).toContainText('Anna’s tablet', { timeout: 120_000 });
  await expect(a.getByTestId('guide-current')).toBeVisible();
  await shot(a, 'phone-lost-done.png');
  await a.getByTestId('lost-changes').click();
  await expect(a.getByTestId('changes-screen')).toBeVisible();
  // The place added on the tablet came through this device's sync: listed, revertible.
  await expect(a.getByTestId('change-row').first()).toContainText(FROM_TABLET, { timeout: 30_000 });
  await shot(a, 'phone-changes.png');
  await settle(a);

  // The lost device erases itself at its next sync.
  // (Its launch pass may already have wiped it: then there is no "Sync now" button to press.)
  await t2.goto('/sync');
  const removed = t2.getByTestId('device-removed');
  await t2.getByTestId('sync-now').click({ timeout: 30_000 }).catch(() => {});
  await expect(removed).toBeVisible({ timeout: 60_000 });
  await shot(t2, 'phone-device-removed.png');

  // Ben keeps reading Anna with her new key, and sees the notice.
  await addPlace(a, 'Librairie du Haut Marais');
  await sync(anna);
  await sync(ben);
  await listed(ben.page, 'Librairie du Haut Marais');
  await ben.page.goto(autostart('/whatsnew'));
  await expect(ben.page.getByTestId('whatsnew-item-key')).toContainText('Anna changed their key', { timeout: 30_000 });
  await shot(ben.page, 'phone-whatsnew-key.png');

  expect(anna.errors).toEqual([]);
  expect(ben.errors).toEqual([]);
  expect(tablet.errors).toEqual([]);
  await anna.ctx.close();
  await ben.ctx.close();
  await tablet.ctx.close();
});

test('French tablet: QR code on both sides, dark welcome', async ({ browser }) => {
  test.skip(!proxy, 'Apache WebDAV of packages/storage/scripts/real-servers.sh is not running');
  test.skip(!SHOTS, 'screenshots only');
  test.setTimeout(420_000);
  const tab = { width: 834, height: 1112 };
  const anna = await person(browser, 'Anna', { viewport: tab, lang: 'fr' });
  // The new device shows its code; the old one reads it (pasted here: no camera in the test).
  const fresh = await context(browser, { viewport: tab, locale: 'fr-FR' });
  await fresh.page.goto('/welcome/device?way=qr&lang=fr');
  await expect(fresh.page.getByTestId('device-qr-code')).toBeVisible({ timeout: 30_000 });
  const offer = await fresh.page.getByTestId('device-qr-code').getAttribute('data-qr-value');
  await shot(fresh.page, 'tablet-fr-device-qr.png');
  await anna.page.goto(autostart('/devices/add?lang=fr'));
  await anna.page.getByTestId('add-qr-input').fill(offer!);
  await anna.page.getByTestId('add-qr-open').click();
  await expect(anna.page.getByTestId('add-confirm')).toBeVisible();
  const fp = (await fresh.page.getByTestId('device-fingerprint').textContent())!;
  await anna.page.getByTestId('add-digits').fill(fp.replace(/\D/g, '').slice(-4));
  await anna.page.getByTestId('master-go').click();
  await expect(anna.page.getByTestId('add-qr-reply')).toBeVisible({ timeout: 60_000 });
  await shot(anna.page, 'tablet-fr-add-qr.png');
  const reply = await anna.page.getByTestId('add-qr-reply').getAttribute('data-qr-value');
  await fresh.page.getByTestId('device-qr-answer').fill(reply!);
  await fresh.page.getByTestId('device-qr-open').click();
  await expect(fresh.page.getByTestId('filter-toggle').filter({ visible: true })).toBeVisible({ timeout: 60_000 });
  await sync({ page: fresh.page }, '&lang=fr');
  await fresh.page.goto('/?lang=fr');
  await expect(fresh.page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 60_000 });
  await expect(anna.page.getByTestId('add-done')).toBeVisible({ timeout: 30_000 });

  const dark = await context(browser, { dark: true });
  await dark.page.goto('/welcome/device');
  await expect(dark.page.getByTestId('device-link')).toBeVisible();
  await shot(dark.page, 'phone-dark-welcome-device.png');
  await anna.ctx.close();
  await fresh.ctx.close();
  await dark.ctx.close();
});
