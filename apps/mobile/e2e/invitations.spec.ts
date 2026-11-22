/**
 * Invitations and access (T-208, T-209) between browser contexts that exchange links through the
 * page, on the fixture-mode web export.
 *
 * - The pure UI part (no storage) always runs.
 * - The exchanges need a storage that publishes the inviter's index: Apache mod_dav on
 *   127.0.0.1:8081 (packages/storage/scripts/real-servers.sh), reached through a CORS proxy, with
 *   friends' read address `https://friends.triangulair.test/pub/…` answered from Apache's anonymous
 *   `/pub` (same setup as storage.spec.ts). Skipped when Apache is not running.
 *
 * `E2E_SHOTS=1` also writes the screenshots of docs/ (phone, tablet, dark, French).
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
      // Apache's redirects (a folder without its trailing slash) name itself: keep them on the proxy,
      // or the browser leaves it and fails on CORS.
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

const folder = () => `e2e-inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

interface Person {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

/** A new browser context (its own IndexedDB: another person), offline map, friends' address routed. */
async function person(browser: Browser, opts: { dark?: boolean; viewport?: { width: number; height: number }; locale?: string } = {}): Promise<Person> {
  const ctx = await browser.newContext({
    viewport: opts.viewport ?? { width: 390, height: 844 },
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

/** A person without a storage: identity made (fixture autostart), contacts open. */
async function start(page: Page, name: string): Promise<void> {
  await page.goto(autostart(`/contacts?name=${encodeURIComponent(name)}`));
  await expect(page.getByTestId('contacts-screen')).toBeVisible({ timeout: 30_000 });
}

async function done(...people: Person[]): Promise<void> {
  for (const p of people) {
    expect(p.errors, 'uncaught errors in the page').toEqual([]);
    await p.ctx.close();
  }
}

/** Connects a WebDAV storage in `dir` (Apache through the CORS proxy), as storage.spec.ts does. */
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
  for (const step of ['reach', 'write', 'publicRead']) await expect(page.getByTestId(`step-${step}-ok`)).toBeVisible();
  await page.getByTestId('master-go').click();
  await expect(page.getByTestId('storage-connected-banner')).toBeVisible();
}

/** Creates an invitation on the inviter's page and returns the link. */
async function invite(page: Page, forWhom: string): Promise<string> {
  await page.goto('/invite');
  await page.getByTestId('invite-name').fill(forWhom);
  await page.getByTestId('invite-create').click();
  await expect(page.getByTestId('invite-ready')).toBeVisible({ timeout: 30_000 });
  const link = (await page.getByTestId('invite-link').textContent())!;
  expect(link).toMatch(/^https?:\/\/[^/#]+(?:\/[^#]*)?\/i#[A-Za-z0-9_-]+$/);
  expect(link.length).toBeLessThanOrEqual(200);
  // The QR code stays small (version ≤ 10).
  expect(Number(await page.getByTestId('invite-qr').getAttribute('data-qr-version'))).toBeLessThanOrEqual(10);
  return link;
}

/** The invitee pastes the link, names the inviter, answers; returns the return link. */
async function answer(page: Page, link: string, inviter: string): Promise<string> {
  await page.goto('/invite/received');
  await page.getByTestId('received-input').fill(`Hi! ${link}`);
  await page.getByTestId('received-open').click();
  await expect(page.getByTestId('received-verified')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('received-name').fill(inviter);
  await page.getByTestId('received-answer').click();
  // With a storage, answering publishes my index first (the inviter checks it): slower under load.
  await expect(page.getByTestId('received-answered')).toBeVisible({ timeout: 60_000 });
  return (await page.getByTestId('received-return-link').textContent())!;
}

test.describe('without a storage', () => {
  test('inviting asks for a storage; bad links are explained; list links are coming', async ({ browser }) => {
    const a = await person(browser);
    const { page } = a;
    await page.goto(autostart('/invite'));
    await expect(page.getByTestId('storage-needed')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('invite-create')).toHaveCount(0);
    await shot(page, 'phone-invite-storage-needed');

    // A pasted answer that is not a link, then an invitation where an answer goes.
    await page.getByTestId('answer-input').fill('hello');
    await page.getByTestId('answer-open').click();
    await expect(page.getByTestId('answer-problem')).toContainText('not a complete TrianguLair link');
    await page.getByTestId('answer-input').fill('https://example.org/i#SQUAAAAA');
    await page.getByTestId('answer-open').click();
    await expect(page.getByTestId('answer-problem')).toContainText('another kind of link');

    await page.goto('/invite/received');
    await page.getByTestId('received-input').fill('https://example.org/i#SQU');
    await page.getByTestId('received-open').click();
    await expect(page.getByTestId('received-problem')).toContainText('not a complete');
    await expect(page.getByTestId('received-problem')).toContainText('Ask for a new link');

    await page.goto('/contacts');
    await expect(page.getByTestId('contacts-empty')).toBeVisible();
    await page.getByTestId('contacts-follow-list').click();
    await expect(page.getByTestId('follow-list-screen')).toBeVisible();
    // An invitation pasted where a list link goes is refused in plain words (T-212).
    await page.getByTestId('follow-input').fill('https://example.org/i#SQU');
    await page.getByTestId('follow-open').click();
    await expect(page.getByTestId('follow-problem-not-a-list')).toBeVisible();

    await page.goto('/settings');
    await page.getByTestId('settings-contacts').click();
    await expect(page.getByTestId('contacts-screen')).toBeVisible();
    await done(a);
  });

  test('first launch: "I received an invitation link" refuses a broken link', async ({ browser }) => {
    const a = await person(browser);
    await a.page.goto('/welcome/invitation');
    await a.page.getByTestId('welcome-invite-input').fill('https://example.org/i#SQU');
    await a.page.getByTestId('welcome-invite-open').click();
    await expect(a.page.getByTestId('welcome-invite-problem')).toBeVisible();
    await expect(a.page.getByTestId('invite-continue')).toHaveCount(0);
    await done(a);
  });
});

test.describe('between people', () => {
  test.beforeEach(() => {
    test.skip(!proxy, 'Apache WebDAV on 127.0.0.1:8081 is not running (packages/storage/scripts/real-servers.sh)');
  });

  test('invite by link, answer through a deep link, accept, then manage access and remove', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await person(browser);
    const bob = await person(browser);
    await connect(alice.page, 'Alice', folder());
    const link = await invite(alice.page, 'Bob');
    await shot(alice.page, 'phone-invite-link');
    await expect(alice.page.getByTestId('invite-none')).toHaveCount(0);
    await expect(alice.page.locator('[data-testid^="invitation-"][data-testid$="-phase"]').first()).toContainText('Waiting for an answer');

    // Bob opens the link (deep link on the app's /i route: the fragment never reaches a server).
    const fragment = link.split('#')[1]!;
    await bob.page.goto(`${autostart('/i?name=Bob')}#${fragment}`);
    await expect(bob.page.getByTestId('received-verified')).toBeVisible({ timeout: 30_000 });
    expect(new URL(bob.page.url()).hash).toBe(''); // removed from the address bar
    const bobCode = (await bob.page.getByTestId('received-code').getAttribute('aria-label'))!;
    expect(bobCode.split(' ')).toHaveLength(12);
    await bob.page.getByTestId('received-name').fill('Alice');
    await expect(bob.page.getByTestId('received-no-storage')).toBeVisible();
    await shot(bob.page, 'phone-received-verified');
    await bob.page.getByTestId('received-answer').click();
    await expect(bob.page.getByTestId('received-answered')).toBeVisible({ timeout: 30_000 });
    await shot(bob.page, 'phone-received-answer');
    const returnLink = (await bob.page.getByTestId('received-return-link').textContent())!;
    expect(returnLink).toMatch(/^https?:\/\/[^/#]+(?:\/[^#]*)?\/r#/);

    // Alice pastes it: one answer, Bob has no storage so it cannot be checked; same code as Bob's.
    await alice.page.goto('/invite');
    await alice.page.getByTestId('answer-input').fill(`Bob says: ${returnLink}`);
    await alice.page.getByTestId('answer-open').click();
    await expect(alice.page.getByTestId('answers-screen')).toBeVisible();
    const card = alice.page.locator('[data-testid^="answer-"][data-testid$="-accept"]');
    await expect(card).toHaveCount(1);
    await expect(alice.page.locator('[data-testid^="answer-"][data-testid$="-uncheckable"]')).toBeVisible();
    await alice.page.locator('[data-testid^="answer-"][data-testid$="-show-code"]').click();
    expect(await alice.page.locator('[data-testid^="answer-"][data-testid$="-code"]').getAttribute('aria-label')).toBe(bobCode);
    await card.click();
    await expect(alice.page.locator('[data-testid^="answer-"][data-testid$="-name"]')).toHaveValue('Bob');
    await shot(alice.page, 'phone-answer-accept');
    await alice.page.locator('[data-testid^="answer-"][data-testid$="-confirm"]').click();
    await expect(alice.page.getByTestId('answers-contacts')).toBeVisible({ timeout: 30_000 });

    // Contacts: Bob, cannot be checked; compare the safety code by QR (pasted payload).
    await alice.page.getByTestId('answers-contacts').click();
    const row = alice.page.locator('[data-testid^="contact-"]').filter({ hasText: 'Bob' });
    await expect(row).toContainText('Cannot be checked');
    await expect(row).toContainText('they see what you share with friends');
    await shot(alice.page, 'phone-contacts');
    await row.click();
    await expect(alice.page.getByTestId('contact-uncheckable')).toBeVisible();

    await bob.page.goto('/contacts');
    const aliceRow = bob.page.locator('[data-testid^="contact-"]').filter({ hasText: 'Alice' });
    await expect(aliceRow).toContainText('You see their places');
    await expect(aliceRow).toContainText('Not verified');
    await aliceRow.click();
    await bob.page.getByTestId('contact-show-qr').click();
    const bobQr = (await bob.page.getByTestId('contact-qr').getAttribute('data-qr-value'))!;
    expect(bobQr).toMatch(/^tlsafe1:/);

    await alice.page.getByTestId('contact-show-qr').click();
    await alice.page.getByTestId('contact-safety-input').fill('tlsafe1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await alice.page.getByTestId('contact-safety-open').click();
    await expect(alice.page.getByTestId('contact-mismatch')).toBeVisible();
    await alice.page.getByTestId('contact-safety-input').fill(bobQr);
    await alice.page.getByTestId('contact-safety-open').click();
    await expect(alice.page.getByTestId('contact-match')).toBeVisible();
    await expect(alice.page.getByTestId('contact-badge')).toContainText('Verified');
    await expect(alice.page.getByTestId('contact-verified')).toHaveAttribute('aria-checked', 'true');
    // Bob's own mark is his: unchanged.
    await expect(bob.page.getByTestId('contact-badge')).toContainText('Not verified');
    await shot(alice.page, 'phone-contact-verified');

    // "They see my places": only some lists, then nothing (re-encryption published), then removal.
    await alice.page.getByTestId('contact-scope-kind').getByRole('radio', { name: 'Nothing' }).click();
    await expect(alice.page.getByTestId('contact-share')).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
    await expect(alice.page.getByTestId('contact-saved')).toBeVisible({ timeout: 30_000 });
    await alice.page.getByTestId('contact-share').click();
    await expect(alice.page.getByTestId('contact-share')).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    await alice.page.getByTestId('contact-remove').click();
    await shot(alice.page, 'phone-contact-remove');
    await alice.page.getByTestId('contact-remove-go').click();
    await expect(alice.page.getByTestId('contacts-empty').filter({ visible: true })).toBeVisible({ timeout: 30_000 });

    // The pending list no longer shows the accepted invitation.
    await alice.page.goto('/invite');
    await expect(alice.page.getByTestId('invite-none')).toBeVisible();
    await done(alice, bob);
  });

  test('both with a storage; two answers to one link: warning, choose; a forged link is refused', async ({ browser }) => {
    test.setTimeout(240_000);
    const alice = await person(browser);
    const bob = await person(browser);
    const eve = await person(browser);
    await connect(alice.page, 'Alice', folder());
    await connect(bob.page, 'Bob', folder());
    await start(eve.page, 'Eve');
    const link = await invite(alice.page, 'Bob');

    // A link with another expiry is not listed in Alice's index.
    const f = link.split('#')[1]!;
    const bytes = Buffer.from(f, 'base64url');
    bytes[57] = bytes[57]! ^ 1;
    await eve.page.goto('/invite/received');
    await eve.page.getByTestId('received-input').fill(`https://example.org/i#${bytes.toString('base64url')}`);
    await eve.page.getByTestId('received-open').click();
    await expect(eve.page.getByTestId('received-problem')).toContainText('This link no longer works', { timeout: 30_000 });
    await shot(eve.page, 'phone-received-problem');

    const fromBob = await answer(bob.page, link, 'Alice');
    await expect(bob.page.getByTestId('received-qr')).toBeVisible();
    const fromEve = await answer(eve.page, link, 'Alice');
    await alice.page.goto('/invite');
    for (const l of [fromBob, fromEve]) {
      await alice.page.getByTestId('answer-input').fill(l);
      await alice.page.getByTestId('answer-open').click();
      await expect(alice.page.getByTestId('answers-screen')).toBeVisible();
      await alice.page.goto('/invite');
    }
    await expect(alice.page.locator('[data-testid^="invitation-"][data-testid$="-phase"]').first()).toContainText('2 people answered');
    await alice.page.locator('[data-testid^="invitation-"][data-testid$="-answers"]').first().click();
    await expect(alice.page.getByTestId('answer-warning-several')).toBeVisible();
    await expect(alice.page.locator('[data-testid^="answer-"][data-testid$="-accept"]')).toHaveCount(2);
    await shot(alice.page, 'phone-answers-several');

    // Alice compares the code with Bob: the first card whose code matches Bob's.
    await bob.page.goto('/contacts');
    await bob.page.locator('[data-testid^="contact-"]').filter({ hasText: 'Alice' }).click();
    const bobCode = (await bob.page.getByTestId('contact-code').getAttribute('aria-label'))!;
    const cards = alice.page.locator('[data-testid^="answer-"][data-testid$="-code"]');
    await expect(cards).toHaveCount(2);
    let bobCard = '';
    for (let i = 0; i < 2; i++) {
      if ((await cards.nth(i).getAttribute('aria-label')) === bobCode) bobCard = (await cards.nth(i).getAttribute('data-testid'))!.replace(/-code$/, '');
    }
    expect(bobCard).not.toBe('');
    await alice.page.getByTestId(`${bobCard}-accept`).click();
    await alice.page.getByTestId(`${bobCard}-name`).fill('Bob');
    await expect(alice.page.getByTestId(`${bobCard}-follow`)).toHaveAttribute('aria-checked', 'true');
    await expect(alice.page.getByTestId(`${bobCard}-confirm`)).toHaveText('Accept anyway');
    await alice.page.getByTestId(`${bobCard}-verified`).click();
    await alice.page.getByTestId(`${bobCard}-confirm`).click();
    await expect(alice.page.getByTestId('answer-warning-late-after-accept')).toBeVisible({ timeout: 30_000 });
    await expect(alice.page.getByTestId('answers-revoke-first')).toBeVisible();
    await shot(alice.page, 'phone-answers-late');

    await alice.page.getByTestId('answers-contacts').click();
    const row = alice.page.locator('[data-testid^="contact-"]').filter({ hasText: 'Bob' });
    await expect(row).toContainText('Verified');
    await expect(row).toContainText('You see their places');
    await done(alice, bob, eve);
  });

  test('face to face: show the invitation code, the answer comes back as a code, verified on both sides', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await person(browser);
    const bob = await person(browser);
    await connect(alice.page, 'Alice', folder());
    await start(bob.page, 'Bob');
    await alice.page.goto('/invite/face');
    await alice.page.getByTestId('face-create').click();
    await expect(alice.page.getByTestId('face-qr')).toBeVisible({ timeout: 30_000 });
    await shot(alice.page, 'phone-face-show');
    const shown = (await alice.page.getByTestId('face-qr').getAttribute('data-qr-value'))!;

    // Bob "scans" it (the scanner hands the text over like the paste field).
    await bob.page.goto('/invite/face');
    await bob.page.getByTestId('face-mode').getByRole('radio', { name: 'Scan a code' }).click();
    await expect(bob.page.getByTestId('face-scanner-start')).toBeVisible();
    await bob.page.getByTestId('face-paste-input').fill(shown);
    await bob.page.getByTestId('face-paste-open').click();
    await expect(bob.page.getByTestId('received-verified')).toBeVisible({ timeout: 30_000 });
    await expect(bob.page.getByTestId('received-badge')).toContainText('Verified');
    await bob.page.getByTestId('received-name').fill('Alice');
    await bob.page.getByTestId('received-answer').click();
    await expect(bob.page.getByTestId('received-qr')).toBeVisible({ timeout: 30_000 });
    await shot(bob.page, 'phone-face-answer');
    const back = (await bob.page.getByTestId('received-qr').getAttribute('data-qr-value'))!;

    await alice.page.getByTestId('face-scan-answer').click();
    await alice.page.getByTestId('face-paste-input').fill(back);
    await alice.page.getByTestId('face-paste-open').click();
    await expect(alice.page.locator('[data-testid^="answer-"][data-testid$="-face"]')).toBeVisible({ timeout: 30_000 });
    await alice.page.locator('[data-testid^="answer-"][data-testid$="-accept"]').click();
    await alice.page.locator('[data-testid^="answer-"][data-testid$="-name"]').fill('Bob');
    await alice.page.locator('[data-testid^="answer-"][data-testid$="-confirm"]').click();
    await expect(alice.page.getByTestId('answers-contacts')).toBeVisible({ timeout: 30_000 });
    await alice.page.getByTestId('answers-contacts').click();
    await expect(alice.page.locator('[data-testid^="contact-"]').filter({ hasText: 'Bob' })).toContainText('Verified');
    await bob.page.goto('/contacts');
    await expect(bob.page.locator('[data-testid^="contact-"]').filter({ hasText: 'Alice' })).toContainText('Verified');
    await done(alice, bob);
  });

  test('screenshots: tablet, dark mode, French', async ({ browser }) => {
    test.skip(!SHOTS, 'E2E_SHOTS=1 only');
    test.setTimeout(180_000);
    const tablet = await person(browser, { viewport: { width: 834, height: 1112 }, locale: 'fr-FR' });
    await connect(tablet.page, 'Camille', folder());
    await tablet.page.goto('/invite?lang=fr');
    await tablet.page.getByTestId('invite-name').fill('Léa');
    await tablet.page.getByTestId('invite-create').click();
    await expect(tablet.page.getByTestId('invite-ready')).toBeVisible({ timeout: 30_000 });
    await shot(tablet.page, 'tablet-fr-invite-link');
    const link = (await tablet.page.getByTestId('invite-link').textContent())!;

    const dark = await person(browser, { dark: true });
    await start(dark.page, 'Léa');
    await dark.page.goto('/invite/received');
    await dark.page.getByTestId('received-input').fill(link);
    await dark.page.getByTestId('received-open').click();
    await expect(dark.page.getByTestId('received-verified')).toBeVisible({ timeout: 30_000 });
    await dark.page.getByTestId('received-name').fill('Camille');
    await shot(dark.page, 'phone-dark-received-verified');
    await dark.page.getByTestId('received-answer').click();
    await expect(dark.page.getByTestId('received-answered')).toBeVisible({ timeout: 30_000 });
    await dark.page.getByTestId('received-contacts').click();
    await dark.page.locator('[data-testid^="contact-"]').filter({ hasText: 'Camille' }).click();
    await expect(dark.page.getByTestId('contact-code')).toBeVisible();
    await shot(dark.page, 'phone-dark-contact');
    await done(tablet, dark);
  });
});
