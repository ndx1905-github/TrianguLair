/**
 * Store rules (gap #6): "Delete all my content" against a real WebDAV storage, and blocking a person, between two
 * browser contexts. Apache mod_dav on 127.0.0.1:8081 (packages/storage/scripts/real-servers.sh, as root), reached
 * through a CORS proxy, friends' read address answered from Apache's anonymous `/pub` (as in invitations.spec.ts).
 * Skipped when Apache is not running; the local-only deletion always runs.
 *
 * `E2E_SHOTS=1` also writes the screenshots of docs/.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { autostart, preparePage } from './helpers';

const DAV = 'http://127.0.0.1:8081';
const AUTH = 'Basic ' + Buffer.from('alice:s3cret').toString('base64');
const FRIENDS = 'https://friends.triangulair.test';
const SHOTS = !!process.env['E2E_SHOTS'];
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `docs/${name}.png`, fullPage: true });
};

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

const folder = () => `e2e-priv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

interface Person {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

async function person(browser: Browser, opts: { dark?: boolean; locale?: string } = {}): Promise<Person> {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: opts.locale ?? 'en-US',
    timezoneId: 'Europe/Paris',
    colorScheme: opts.dark ? 'dark' : 'light',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  const errors = await preparePage(page, !!opts.dark);
  await page.route(`${FRIENDS}/**`, async (route) => {
    const url = route.request().url().replace(FRIENDS, DAV);
    const r = await route.fetch({ url, headers: {} });
    await route.fulfill({ response: r, headers: { ...r.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' } });
  });
  return { ctx, page, errors };
}

async function done(...people: Person[]): Promise<void> {
  for (const p of people) {
    expect(p.errors, 'uncaught errors in the page').toEqual([]);
    await p.ctx.close();
  }
}

/** Every file under `dir` (relative paths), by PROPFIND depth 1 per folder. */
async function davList(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    const r = await fetch(`${DAV}/dav/${dir}/${rel}`, { method: 'PROPFIND', headers: { authorization: AUTH, depth: '1' } });
    if (r.status !== 207) return;
    const xml = await r.text();
    for (const m of xml.matchAll(/<D:href>([^<]+)<\/D:href>/g)) {
      const href = decodeURIComponent(m[1]!);
      const sub = href.slice(href.indexOf(`/dav/${dir}/`) + `/dav/${dir}/`.length);
      if (!sub || sub === rel) continue;
      if (sub.endsWith('/')) await walk(sub);
      else out.push(sub);
    }
  };
  await walk('');
  return out.sort();
}

async function davPut(path: string, body: string): Promise<void> {
  const parts = path.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) await fetch(`${DAV}/dav/${parts.slice(0, i).join('/')}/`, { method: 'MKCOL', headers: { authorization: AUTH } });
  const r = await fetch(`${DAV}/dav/${path}`, { method: 'PUT', headers: { authorization: AUTH }, body });
  expect(r.status).toBeLessThan(300);
}

async function connect(page: Page, name: string, dir: string): Promise<void> {
  await page.goto(autostart(`/storage?name=${name}`));
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
}

async function invite(page: Page, forWhom: string): Promise<string> {
  await page.goto('/invite');
  await page.getByTestId('invite-name').fill(forWhom);
  await page.getByTestId('invite-create').click();
  await expect(page.getByTestId('invite-ready')).toBeVisible({ timeout: 30_000 });
  return (await page.getByTestId('invite-link').textContent())!;
}

async function answer(page: Page, link: string, inviter: string): Promise<string> {
  await page.goto('/invite/received');
  await page.getByTestId('received-input').fill(link);
  await page.getByTestId('received-open').click();
  await expect(page.getByTestId('received-verified')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('received-name').fill(inviter);
  await page.getByTestId('received-answer').click();
  await expect(page.getByTestId('received-answered')).toBeVisible({ timeout: 60_000 });
  return (await page.getByTestId('received-return-link').textContent())!;
}

async function accept(page: Page, returnLink: string, name: string): Promise<void> {
  await page.goto('/invite');
  await page.getByTestId('answer-input').fill(returnLink);
  await page.getByTestId('answer-open').click();
  await expect(page.getByTestId('answers-screen')).toBeVisible();
  await page.locator('[data-testid^="answer-"][data-testid$="-accept"]').click();
  await page.locator('[data-testid^="answer-"][data-testid$="-name"]').fill(name);
  await page.locator('[data-testid^="answer-"][data-testid$="-confirm"]').click();
  await expect(page.getByTestId('answers-contacts')).toBeVisible({ timeout: 30_000 });
}

/** How many of `friend`'s places this page shows (friends picker of the map's filter bar); 0 when not listed. */
async function friendPlaces(page: Page, friend: string): Promise<number> {
  await page.goto(autostart('/'));
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  const toggle = page.getByTestId('filter-toggle').filter({ visible: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByTestId('friends-picker-open').click();
  const row = page.getByTestId(`friends-person-${friend}`);
  if ((await row.count()) === 0) return 0;
  const m = /(\d+) places?/.exec((await row.textContent()) ?? '');
  return m ? Number(m[1]) : 0;
}

async function syncNow(page: Page): Promise<void> {
  await page.goto(autostart('/sync'));
  await page.getByTestId('sync-now').click();
  await expect(page.getByTestId('sync-now')).toBeEnabled({ timeout: 60_000 });
}

test('delete all my content, local only: confirmations, summary, a blank app', async ({ browser }) => {
  const a = await person(browser);
  const page = a.page;
  await page.goto(autostart('/settings'));
  await expect(page.getByTestId('settings-my-content')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('settings-delete-all').click();
  await expect(page.getByTestId('delete-all-what')).toContainText('nothing to delete there');
  await page.getByTestId('delete-all-understand').click();
  await page.getByTestId('delete-all-word').fill('delete');
  await page.getByTestId('delete-all-go').click();
  await expect(page.getByTestId('delete-all-summary')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('delete-all-summary')).toContainText(/\d+ places deleted/);
  await expect(page.getByTestId('delete-all-summary')).toContainText('No storage was connected');
  await expect(page.getByTestId('delete-all-kit')).toBeVisible();
  await page.getByTestId('delete-all-restart').click();
  // The identity is gone: the first launch again.
  await expect(page).toHaveURL(/\/welcome/, { timeout: 30_000 });
  await done(a);
});

test.describe('with a storage', () => {
  test.beforeEach(() => {
    test.skip(!proxy, 'Apache WebDAV on 127.0.0.1:8081 is not running (packages/storage/scripts/real-servers.sh)');
  });

  test('delete all my content: files deleted on Apache WebDAV, the signed marker empties a friend\'s cache', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await person(browser);
    const bob = await person(browser);
    const dir = folder();
    await connect(alice.page, 'Alice', dir);
    await bob.page.goto(autostart('/contacts?name=Bob'));
    await expect(bob.page.getByTestId('contacts-screen')).toBeVisible({ timeout: 30_000 });
    await accept(alice.page, await answer(bob.page, await invite(alice.page, 'Bob'), 'Alice'), 'Bob');
    // Bob sees Alice's places.
    await syncNow(bob.page);
    await expect.poll(() => friendPlaces(bob.page, 'Alice'), { timeout: 60_000 }).toBeGreaterThan(0);
    // A photo another device uploaded, and the files the publication wrote: all to be deleted.
    await davPut(`${dir}/media/photo-1.bin`, 'photo');
    const before = await davList(dir);
    expect(before).toContain('vault.bin');
    expect(before.some((p) => p.startsWith('packs/'))).toBe(true);

    const page = alice.page;
    await page.goto(autostart('/delete-all'));
    await expect(page.getByTestId('delete-all-what')).toContainText('Only a small signed note stays');
    await page.getByTestId('delete-all-understand').click();
    await page.getByTestId('delete-all-word').fill('DELETE');
    await shot(page, 'phone-delete-all');
    await page.getByTestId('delete-all-go').click();
    const summary = page.getByTestId('delete-all-summary');
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(summary).toContainText('1 contact removed');
    await expect(page.getByTestId('delete-all-files')).toContainText(/\d+ files deleted on your storage/);
    await expect(page.getByTestId('delete-all-leftovers')).toHaveCount(0);
    await shot(page, 'phone-delete-all-done');

    // Only the signed index and what it lists (my emptied document) remain; no places pack, vault, key or photo.
    const after = await davList(dir);
    expect(after).toContain('index.json');
    expect(after.filter((p) => p.startsWith('packs/') || p.startsWith('keys/') || p === 'vault.bin' || p === 'media/photo-1.bin')).toEqual([]);
    const index = JSON.parse(Buffer.from(await (await fetch(`${DAV}/dav/${dir}/index.json`, { headers: { authorization: AUTH } })).arrayBuffer()).toString('utf8')) as { packs: { file: string }[] };
    expect(after.sort()).toEqual(['index.json', ...index.packs.map((p) => p.file)].sort());

    // Bob's app reads the new index: Alice's places leave his cache.
    await syncNow(bob.page);
    await expect.poll(() => friendPlaces(bob.page, 'Alice'), { timeout: 60_000 }).toBe(0);

    await page.getByTestId('delete-all-restart').click();
    await expect(page).toHaveURL(/\/welcome/, { timeout: 30_000 });
    await done(alice, bob);
  });

  test('block a person: removed, their places gone, their invitations refused; unblock', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await person(browser);
    const bob = await person(browser);
    await connect(alice.page, 'Alice', folder());
    await bob.page.goto(autostart('/contacts?name=Bob'));
    await expect(bob.page.getByTestId('contacts-screen')).toBeVisible({ timeout: 30_000 });
    await accept(alice.page, await answer(bob.page, await invite(alice.page, 'Bob'), 'Alice'), 'Bob');
    await syncNow(bob.page);
    await expect.poll(() => friendPlaces(bob.page, 'Alice'), { timeout: 60_000 }).toBeGreaterThan(0);

    // Bob blocks Alice from her contact screen.
    await bob.page.goto(autostart('/contacts'));
    await bob.page.locator('[data-testid^="contact-"]').filter({ hasText: 'Alice' }).click();
    await bob.page.getByTestId('block').click();
    await expect(bob.page.getByTestId('block-confirm')).toContainText('Block Alice?');
    await shot(bob.page, 'phone-block-confirm');
    await bob.page.getByTestId('block-go').click();
    await expect(bob.page.getByTestId('blocked-screen')).toBeVisible({ timeout: 30_000 });
    await expect(bob.page.getByTestId('blocked-Alice')).toBeVisible();
    await shot(bob.page, 'phone-blocked');
    await bob.page.waitForTimeout(1500); // the database file is written after a short debounce
    expect(await friendPlaces(bob.page, 'Alice')).toBe(0);
    await bob.page.goto(autostart('/contacts'));
    await expect(bob.page.locator('[data-testid^="contact-"]').filter({ hasText: 'Alice' })).toHaveCount(0);

    // A new invitation from Alice is refused.
    const link = await invite(alice.page, 'Bob again');
    await bob.page.goto(autostart('/invite/received'));
    await bob.page.getByTestId('received-input').fill(link);
    await bob.page.getByTestId('received-open').click();
    await expect(bob.page.getByTestId('received-problem')).toContainText('someone you blocked', { timeout: 30_000 });

    // Unblock: no longer refused.
    await bob.page.goto(autostart('/blocked'));
    await bob.page.getByTestId('blocked-unblock').click();
    await expect(bob.page.getByTestId('blocked-done')).toContainText('no longer blocked');
    await expect(bob.page.getByTestId('blocked-empty')).toBeVisible();
    await bob.page.waitForTimeout(1500);
    await bob.page.goto(autostart('/invite/received'));
    await bob.page.getByTestId('received-input').fill(link);
    await bob.page.getByTestId('received-open').click();
    await expect(bob.page.getByTestId('received-verified')).toBeVisible({ timeout: 30_000 });
    await done(alice, bob);
  });
});

test.describe('reporting', () => {
  test.beforeEach(() => {
    test.skip(!proxy, 'Apache WebDAV on 127.0.0.1:8081 is not running (packages/storage/scripts/real-servers.sh)');
  });

  test('report a public list: who can act, the report text, hidden here, not offered again', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await person(browser);
    const bob = await person(browser);
    const dir = folder();
    await connect(alice.page, 'Alice', dir);
    const a = alice.page;
    // A public list of two demo places.
    await a.goto(autostart('/lists'));
    await a.getByTestId('new-list').click();
    await a.getByTestId('list-name').fill('Rude list');
    await a.getByTestId('list-kind').getByText('Selection by hand', { exact: true }).click();
    await a.getByTestId('list-toggle-out').click();
    await a.getByTestId('list-add-Le Comptoir du Relais').click();
    await a.getByTestId('list-add-Du Pain et des Idées').click();
    await a.getByTestId('list-save').click();
    await expect(a.getByTestId('list-summary')).toContainText('2 places');
    await a.getByTestId('share-list').click();
    await a.getByTestId('share-visibility').getByText('Public', { exact: true }).click();
    await a.getByTestId('share-public-warning-confirm').click();
    await expect(a.getByTestId('share-public-ready')).toBeVisible({ timeout: 60_000 });
    await expect(a.getByTestId('share-busy')).toHaveCount(0, { timeout: 60_000 });
    const pubLink = (await a.getByTestId('share-public-link-link').textContent())!;

    const b = bob.page;
    await b.goto(autostart('/lists/follow'));
    await b.getByTestId('follow-input').fill(pubLink);
    await b.getByTestId('follow-open').click();
    await b.getByTestId('follow-confirm').click({ timeout: 60_000 });
    await expect(b.getByTestId('followed-list')).toBeVisible({ timeout: 60_000 });
    await b.getByTestId('followed-report').click();
    await expect(b.getByTestId('report-screen')).toBeVisible();
    await expect(b.getByTestId('report-host')).toContainText('friends.triangulair.test');
    await b.getByTestId('report-reason').fill('Hateful comments');
    await expect(b.getByTestId('report-text-link')).toHaveText(
      `I am reporting the public list “Rude list”, published at ${FRIENDS}/pub/${dir}/public/lists.geojson. Reason: Hateful comments`,
    );
    await shot(b, 'phone-report-list');
    await b.getByTestId('report-hide').click();
    await expect(b.getByTestId('followed-screen')).toBeVisible({ timeout: 30_000 });
    await expect(b.getByTestId('followed-Rude list')).toHaveCount(0);
    // Not offered again on this device.
    await b.waitForTimeout(1500);
    await b.goto(autostart('/lists/follow'));
    await b.getByTestId('follow-input').fill(pubLink);
    await b.getByTestId('follow-open').click();
    await expect(b.getByTestId('follow-problem-reported')).toBeVisible({ timeout: 60_000 });
    await done(alice, bob);
  });
});

test('blocked people and delete-all screens: French and dark mode', async ({ browser }) => {
  const a = await person(browser, { dark: true, locale: 'fr-FR' });
  await a.page.goto(autostart('/blocked?lang=fr'));
  await expect(a.page.getByTestId('blocked-empty')).toHaveText('Vous n’avez bloqué personne.', { timeout: 30_000 });
  await a.page.goto(autostart('/delete-all?lang=fr'));
  await a.page.getByTestId('delete-all-understand').click();
  await expect(a.page.getByText('Tapez SUPPRIMER pour confirmer')).toBeVisible();
  await shot(a.page, 'phone-dark-fr-delete-all');
  await done(a);
});
