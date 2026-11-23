/**
 * Personal photos (T-111b), end to end, against the real Apache WebDAV server of
 * packages/storage/scripts/real-servers.sh (as root; 127.0.0.1:8081). Skipped when it is not running.
 *
 * Two browser contexts: Anna adds a photo (a JPEG with GPS and camera EXIF, through the card's file
 * input; the web build re-encodes it on a canvas) to a place she shares; it waits on her device,
 * then goes out with "Sync now". Ben, who follows her, gets the thumbnail with her places and
 * downloads the full photo only when he opens it (counted on the network). A second photo shows in
 * his What's new; Anna removes the first, and it leaves his card. Settings › Photos.
 *
 * `SHOTS=1` also writes the screenshots of docs/ (card gallery, viewer, What's new, settings).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import { autostart, expect, jump, preparePage, test } from './helpers';

const DAV = 'http://127.0.0.1:8081';
const AUTH = 'Basic ' + Buffer.from('alice:s3cret').toString('base64');
const FRIENDS = 'https://friends.triangulair.test';
const SHOTS = process.env['SHOTS'] === '1';
const SHARED = 'Le Comptoir des Archives';
const PHOTO = path.join(__dirname, 'fixtures', 'photo-gps.jpg');
const PHOTO2 = path.join(__dirname, 'fixtures', 'photo-2.jpg');

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

const folder = (who: string) => `e2e-photos-${who}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface Person {
  ctx: BrowserContext;
  page: Page;
  dir: string;
  errors: string[];
  /** Paths of media files fetched from friends' read addresses. */
  media: string[];
}

async function person(browser: Browser, name: string): Promise<Person> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  const errors = await preparePage(page);
  const media: string[] = [];
  await page.route(`${FRIENDS}/**`, async (route) => {
    const url = route.request().url().replace(FRIENDS, DAV);
    if (/\/media\/b2b256-/.test(url) && route.request().method() === 'GET') media.push(new URL(url).pathname);
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
  const p = { ctx, page, dir, errors, media };
  await sync(p);
  return p;
}

async function syncNow(page: Page): Promise<void> {
  const now = page.getByTestId('sync-now');
  await expect(now).toBeVisible({ timeout: 30_000 });
  await expect(now).toBeEnabled({ timeout: 60_000 });
  await now.click();
  await expect(now).toBeEnabled({ timeout: 60_000 });
}

const settle = (page: Page) => page.waitForTimeout(1200);

const sync = async (p: Person) => {
  await p.page.goto(autostart('/sync'));
  await syncNow(p.page);
  await expect(p.page.getByTestId('sync-state')).toHaveText('Up to date', { timeout: 30_000 });
  await settle(p.page);
};

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

async function addPlace(page: Page, name: string): Promise<void> {
  await page.goto(autostart('/'));
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await jump(page, 48.8594, 2.3624, 16);
  await page.getByTestId('open-add').click();
  await page.getByTestId(`candidate-${name}`).click();
  await expect(page.getByTestId('add-form')).toBeVisible();
  await page.getByTestId('save-place').click();
  await expect(page.getByTestId('place-card')).toBeVisible();
  await page.getByTestId('card-close').click();
  await settle(page);
}

/** The card of `name`, opened from the list. */
async function openCard(page: Page, name: string) {
  await page.goto(autostart('/list'));
  await page.getByTestId('list-search').fill(name.split(' ').slice(-2).join(' '));
  await page.getByTestId(`row-${name}`).click();
  return page.getByTestId('place-card').filter({ visible: true });
}

async function addPhoto(page: Page, file: string): Promise<void> {
  const card = page.getByTestId('place-card').filter({ visible: true });
  const chooser = page.waitForEvent('filechooser');
  await card.getByTestId('photo-add').click();
  await (await chooser).setFiles(file);
  await expect(card.getByTestId('photo-busy')).toHaveCount(0, { timeout: 30_000 });
  await expect(card.getByTestId('photo-error')).toHaveCount(0);
}

async function shot(page: Page, file: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `docs/${file}` });
}

test('photos: add with EXIF removed, friend gets the thumbnail, full photo on opening, What\'s new, removal', async ({ browser }) => {
  test.skip(!proxy, 'Apache WebDAV on 127.0.0.1:8081 is not running (packages/storage/scripts/real-servers.sh)');
  test.setTimeout(300_000);
  const anna = await person(browser, 'Anna');
  const ben = await person(browser, 'Ben');
  await addPlace(anna.page, SHARED);
  await sync(anna);
  const link = await invite(anna.page, 'Ben');
  const returnLink = await answer(ben.page, link, 'Anna');
  await accept(anna.page, returnLink);
  await sync(anna);
  await sync(ben);

  // Anna adds a photo: it shows at once, waiting to be uploaded.
  const a = anna.page;
  let card = await openCard(a, SHARED);
  await expect(card.getByTestId('personal-photos')).toBeVisible();
  await addPhoto(a, PHOTO);
  const mine = card.getByTestId('photos-mine');
  await expect(mine.getByTestId('photo-thumb-image')).toHaveCount(1, { timeout: 15_000 });
  await expect(mine.getByTestId('photo-waiting')).toContainText('Not uploaded yet');
  await settle(a);
  await sync(anna);
  card = await openCard(a, SHARED);
  await expect(card.getByTestId('photos-mine').getByTestId('photo-waiting')).toHaveCount(0);
  await card.getByTestId('personal-photos').scrollIntoViewIfNeeded();
  await shot(a, 'phone-card-photos.png');

  // On her storage: two media files more, none holding the image or its EXIF in clear.
  const listing = await (await fetch(`${DAV}/dav/${anna.dir}/media/`, { method: 'PROPFIND', headers: { authorization: AUTH, depth: '1' } })).text();
  const files = [...listing.matchAll(/media\/(b2b256-[A-Za-z0-9_-]{43}\.bin)/g)].map((m) => m[1]!);
  expect(new Set(files).size).toBeGreaterThanOrEqual(3); // document, manifest, photo, thumbnail
  for (const f of new Set(files)) {
    const bytes = Buffer.from(await (await fetch(`${DAV}/pub/${anna.dir}/media/${f}`)).arrayBuffer());
    expect(bytes.includes('iPhone')).toBe(false);
    expect(bytes.includes('Exif')).toBe(false);
    expect(bytes.includes('WEBP')).toBe(false);
  }

  // Ben: the thumbnail came with her places; the full photo is fetched only when he opens it.
  await sync(ben);
  const afterSync = ben.media.length;
  expect(afterSync).toBe(1); // the thumbnail
  const b = ben.page;
  const bCard = await openCard(b, SHARED);
  const theirs = bCard.getByTestId('photos-friend');
  await expect(theirs).toContainText('By Anna');
  await expect(theirs.getByTestId('photo-thumb-image')).toHaveCount(1, { timeout: 15_000 });
  expect(ben.media.length).toBe(afterSync);
  await theirs.locator('[data-testid^="photo-thumb-"]').first().click();
  const viewer = b.getByTestId('photo-viewer');
  await expect(viewer.getByTestId('photo-full')).toBeVisible({ timeout: 30_000 });
  await expect(viewer.getByTestId('photo-viewer-author')).toHaveText('By Anna');
  await expect(viewer.getByTestId('photo-remove')).toHaveCount(0); // not mine
  expect(ben.media.length).toBe(afterSync + 1);
  await shot(b, 'phone-photo-viewer.png');
  await viewer.getByTestId('photo-viewer-close').click();
  await expect(viewer).toHaveCount(0);
  // Opened again: from the cache.
  await theirs.locator('[data-testid^="photo-thumb-"]').first().click();
  await expect(b.getByTestId('photo-full')).toBeVisible();
  expect(ben.media.length).toBe(afterSync + 1);
  await b.getByTestId('photo-viewer-close').click();

  // A second photo: "new photo" in Ben's What's new.
  card = await openCard(a, SHARED);
  await addPhoto(a, PHOTO2);
  await expect(card.getByTestId('photos-mine').getByTestId('photo-thumb-image')).toHaveCount(2, { timeout: 15_000 });
  await settle(a);
  await sync(anna);
  await sync(ben);
  await b.goto(autostart('/whatsnew'));
  // Both photos came to a place he already had: two "new photo" items.
  await expect(b.getByTestId('whatsnew-item-photo')).toHaveCount(2);
  const item = b.getByTestId('whatsnew-item-photo').first();
  await expect(item).toContainText('Anna added a photo of Le Comptoir des Archives');
  await expect(item.getByTestId('whatsnew-photos')).toBeVisible();
  await b.getByTestId('whatsnew-type-photos').click();
  await expect(b.getByTestId('whatsnew-item-photo')).toHaveCount(2);
  await expect(b.getByTestId('whatsnew-item-followed')).toHaveCount(0);
  await shot(b, 'phone-whatsnew-photo.png');

  // Anna removes the first photo from the viewer; it leaves Ben's card.
  card = await openCard(a, SHARED);
  await card.getByTestId('photos-mine').locator('[data-testid^="photo-thumb-"]').first().click();
  await a.getByTestId('photo-remove').click();
  await a.getByTestId('photo-remove-confirm').click();
  await expect(a.getByTestId('photo-viewer')).toHaveCount(0);
  await expect(card.getByTestId('photos-mine').getByTestId('photo-thumb-image')).toHaveCount(1);
  await settle(a);
  await sync(anna);
  await sync(ben);
  const bCard2 = await openCard(b, SHARED);
  await expect(bCard2.getByTestId('photos-friend').getByTestId('photo-thumb-image')).toHaveCount(1, { timeout: 15_000 });

  // Settings › Photos: quality, the friends' cache size, the room taken here.
  await b.goto(autostart('/settings'));
  const s = b.getByTestId('settings-photos');
  await s.scrollIntoViewIfNeeded();
  await expect(s.getByTestId('settings-photo-usage')).toContainText('friends’ photos');
  await s.getByTestId('settings-photo-quality').getByRole('radio', { name: 'Smaller (1,200 px)' }).click();
  await expect(s.getByTestId('settings-photo-quality').getByRole('radio', { name: 'Smaller (1,200 px)' })).toHaveAttribute('aria-checked', 'true');
  await shot(b, 'phone-settings-photos.png');

  // Space used on Anna's storage counts the photos.
  await a.goto(autostart('/sync'));
  await expect(a.getByTestId('sync-space-photos')).toContainText('Photos', { timeout: 30_000 });

  expect(anna.errors).toEqual([]);
  expect(ben.errors).toEqual([]);
  await anna.ctx.close();
  await ben.ctx.close();
});

/** The import package's INVENTED Pin Drop export: 2 photos on its (invented) image host, mocked below. */
const PINDROP = path.join(__dirname, '../../../packages/import/test/fixtures/pindrop/pindrop.json');

async function importPinDrop(p: Person, download: boolean): Promise<void> {
  await p.page.goto(autostart('/import'));
  const chooser = p.page.waitForEvent('filechooser');
  await p.page.getByTestId('import-pick').click();
  await (await chooser).setFiles(PINDROP);
  await expect(p.page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 });
  const toggle = p.page.getByTestId('preview-download-photos');
  await expect(toggle).toHaveText('Download the 2 photos from Pin Drop');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(p.page.getByTestId('import-preview')).toContainText('This contacts Pin Drop’s server.');
  if (download) await toggle.click();
  await p.page.getByTestId('import-confirm').click();
  await expect(p.page.getByTestId('import-done')).toBeVisible({ timeout: 60_000 });
  await expect(p.page.getByTestId('import-done')).toContainText('4 places imported');
}

test('import: Pin Drop photos downloaded on request (shrunk, stored like mine); a browser that blocks them says so', async ({ browser }) => {
  test.skip(!proxy, 'Apache WebDAV on 127.0.0.1:8081 is not running (packages/storage/scripts/real-servers.sh)');
  // The image host answers with CORS: the photos come in.
  const anna = await person(browser, 'Anna');
  const asked: string[] = [];
  await anna.page.route('https://pins.example.org/**', async (route) => {
    asked.push(new URL(route.request().url()).searchParams.get('mode') ?? '');
    await route.fulfill({ path: PHOTO2, contentType: 'image/jpeg', headers: { 'access-control-allow-origin': '*' } });
  });
  await importPinDrop(anna, true);
  await expect(anna.page.getByTestId('import-done-remotePhotos')).toHaveText('2 photos downloaded');
  await expect(anna.page.getByTestId('import-photos-blocked')).toHaveCount(0);
  expect(asked).toEqual(['full', 'full']);
  // On the café's card, like a photo I added.
  await anna.page.goto(autostart('/list'));
  await anna.page.getByTestId('list-search').fill('Pendule');
  await anna.page.getByTestId('row-Café Pendule').click();
  const card = anna.page.getByTestId('place-card').filter({ visible: true });
  await expect(card.getByTestId('photos-mine').locator('img')).toHaveCount(1, { timeout: 30_000 });

  // An image host without CORS (as most are): the browser refuses the request before any answer, a
  // TypeError for the page (a request Playwright fulfills skips the CORS check, so it is aborted
  // here, which the page sees the same way). The import is still done.
  const ben = await person(browser, 'Ben');
  let tries = 0;
  await ben.page.route('https://pins.example.org/**', async (route) => {
    tries++;
    await route.abort('accessdenied');
  });
  await importPinDrop(ben, true);
  await expect(ben.page.getByTestId('import-photos-blocked')).toContainText('this browser cannot download the photos from Pin Drop');
  await expect(ben.page.getByTestId('import-done-remotePhotos')).toHaveCount(0);
  await expect(ben.page.getByTestId('import-done-remotePhotosFailed')).toHaveCount(0);
  // Stopped at the first refusal (3 downloads may have started at once).
  expect(tries).toBeLessThanOrEqual(3);
  expect([...anna.errors, ...ben.errors]).toEqual([]);
  await anna.ctx.close();
  await ben.ctx.close();
});
