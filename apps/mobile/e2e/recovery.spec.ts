/**
 * Recovery kit and first launch (T-205), end to end, against the real Apache WebDAV server of
 * packages/storage/scripts/real-servers.sh (as root; 127.0.0.1:8081). Skipped when it is not running.
 * Same setup as devices.spec.ts: a CORS proxy for the write side, the read address
 * `https://friends.triangulair.test/pub/<folder>/` answered from Apache's /pub.
 *
 * Anna saves places (one private, one with a comment) and a photo, connects her storage and saves
 * her recovery kit (the 12 words shown, 3 words checked, the phrase erased). Then the phone is lost:
 * everything the app keeps in the browser is wiped (IndexedDB, localStorage), and the app opens on
 * its first-launch screens. "I already have TrianguLair on another device" › "Recovery phrase", and
 * the app brings everything back: places (the private one included) with their comment, the photo
 * (thumbnail and full image), the storage connection (a new place goes out), and the kit is not
 * asked again.
 *
 * Test 1: the kit entry as it was sent to the password manager is pasted whole; the 12 words and the
 * address are picked out of it. Test 2: the printed page; its QR code is decoded (it holds the read
 * address), the words are typed by hand (case and extra spaces ignored); wrong words and an address
 * where nothing answers are explained first.
 *
 * `SHOTS=1` also writes the screenshots of docs/ (the restore form with a pasted kit, the printed
 * page with its QR code, the restored photo).
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import { autostart, expect, jump, preparePage, test } from './helpers';
// The QR decoder of expo-camera's web barcode scanner (barcode-detector), here in Node.
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const DAV = 'http://127.0.0.1:8081';
const AUTH = 'Basic ' + Buffer.from('alice:s3cret').toString('base64');
const FRIENDS = 'https://friends.triangulair.test';
const SHOTS = process.env['SHOTS'] === '1';
const SHARED = 'Le Comptoir des Archives';
const PRIVATE = 'Café Pendule';
const AFTER = 'Fromagerie Martin';
const COMMENT = 'Best croissant of the street';
const BENS = 'Librairie du Haut Marais';
const PHOTO = path.join(__dirname, 'fixtures', 'photo-gps.jpg');

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

const folder = () => `e2e-kit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

interface Phone {
  ctx: BrowserContext;
  page: Page;
  dir: string;
  location: string;
  errors: string[];
  /** Paths of the media files read from the storage. */
  media: string[];
  /** Texts the app handed to the share sheet (the Web Share API, stubbed). */
  shared: string[];
}

async function phone(browser: Browser): Promise<Phone> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  const errors = await preparePage(page);
  const media: string[] = [];
  const shared: string[] = [];
  await page.route(`${FRIENDS}/**`, async (route) => {
    const url = route.request().url().replace(FRIENDS, DAV);
    const r = await route.fetch({ url, headers: {} });
    await route.fulfill({ response: r, headers: { ...r.headers(), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag' } });
  });
  // Photo files read back (my own are read through the storage's write side).
  page.on('request', (r) => {
    if (r.method() === 'GET' && /\/media\/b2b256-/.test(r.url())) media.push(new URL(r.url()).pathname);
  });
  // The share sheet: keep what is sent to the "password manager".
  await page.exposeFunction('__tlShared', (text: string) => void shared.push(text));
  await page.addInitScript(() => {
    const nav = navigator as Navigator & { share?: (d: { text?: string; title?: string }) => Promise<void> };
    nav.share = async (d) => (window as unknown as { __tlShared(t: string): Promise<void> }).__tlShared(d?.text ?? '');
  });
  const dir = folder();
  return { ctx, page, dir, location: `${FRIENDS}/pub/${dir}/`, errors, media, shared };
}

async function connectStorage(p: Phone, name = 'Anna'): Promise<void> {
  const page = p.page;
  await page.goto(autostart(`/storage?name=${name}`));
  await page.getByTestId('storage-connect').click();
  await page.getByTestId('choice-webdav').click();
  await page.getByTestId('field-davUrl').fill(`${proxyUrl}/dav/${p.dir}/`);
  await page.getByTestId('field-davUser').fill('alice');
  await page.getByTestId('field-davPassword').fill('s3cret');
  await page.getByTestId('field-readUrl').fill(p.location);
  await page.getByTestId('setup-test').click();
  await expect(page.getByTestId('test-summary')).toContainText('Everything works', { timeout: 30_000 });
  await page.getByTestId('master-go').click();
  await expect(page.getByTestId('storage-connected-banner')).toBeVisible();
}

/** The web build saves its database file 400 ms after a write: wait before leaving the page. */
const settle = (page: Page) => page.waitForTimeout(1200);

async function sync(page: Page, at = autostart('/sync')): Promise<void> {
  await page.goto(at);
  const now = page.getByTestId('sync-now');
  await expect(now).toBeVisible({ timeout: 30_000 });
  await expect(now).toBeEnabled({ timeout: 60_000 });
  await now.click();
  await expect(now).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('sync-state')).toHaveText('Up to date', { timeout: 30_000 });
  await settle(page);
}

async function addPlace(page: Page, name: string, opts: { private?: boolean; comment?: string; at?: string } = {}): Promise<void> {
  await page.goto(opts.at ?? autostart('/'));
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  await jump(page, 48.8594, 2.3624, 16);
  await page.getByTestId('open-add').click();
  await page.getByTestId(`candidate-${name}`).click();
  const form = page.getByTestId('add-form');
  await expect(form).toBeVisible();
  if (opts.private) await form.getByTestId('sharing').getByRole('radio', { name: 'Private' }).click();
  if (opts.comment) await form.getByTestId('comment').fill(opts.comment);
  await page.getByTestId('save-place').click();
  await expect(page.getByTestId('place-card')).toBeVisible();
  await page.getByTestId('card-close').click();
  await settle(page);
}

/** Anna invites Ben; Ben answers (sharing his places back), Anna accepts and follows him. */
async function befriend(anna: Page, ben: Page): Promise<void> {
  await anna.goto(autostart('/invite'));
  await anna.getByTestId('invite-name').fill('Ben');
  await anna.getByTestId('invite-create').click();
  await expect(anna.getByTestId('invite-ready')).toBeVisible({ timeout: 60_000 });
  await settle(anna);
  const link = (await anna.getByTestId('invite-link').textContent())!;
  await ben.goto(`${autostart('/i')}#${link.split('#')[1]!}`);
  await expect(ben.getByTestId('received-verified')).toBeVisible({ timeout: 30_000 });
  await ben.getByTestId('received-name').fill('Anna');
  await expect(ben.getByTestId('received-share-back')).toHaveAttribute('aria-checked', 'true');
  await ben.getByTestId('received-answer').click();
  await expect(ben.getByTestId('received-answered')).toBeVisible({ timeout: 60_000 });
  await settle(ben);
  const back = (await ben.getByTestId('received-return-link').textContent())!;
  await anna.goto(autostart('/invite'));
  await anna.getByTestId('answer-input').fill(back);
  await anna.getByTestId('answer-open').click();
  await expect(anna.getByTestId('answers-screen')).toBeVisible({ timeout: 30_000 });
  await anna.locator('[data-testid^="answer-"][data-testid$="-accept"]').click();
  await expect(anna.locator('[data-testid^="answer-"][data-testid$="-follow"]')).toHaveAttribute('aria-checked', 'true');
  await anna.locator('[data-testid^="answer-"][data-testid$="-confirm"]').click();
  await expect(anna.getByTestId('answers-contacts')).toBeVisible({ timeout: 60_000 });
  await settle(anna);
}

/** Whether my list shows a place (search by name). */
async function listed(page: Page, name: string, at = autostart('/list')): Promise<void> {
  await page.goto(at);
  await page.getByTestId('list-search').fill(name);
  await expect(page.getByTestId(`row-${name}`)).toBeVisible({ timeout: 30_000 });
}

/** The card of `name`, opened from the list. */
async function openCard(page: Page, name: string, at = autostart('/list')) {
  await page.goto(at);
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

/** Draws an SVG QR code in the browser (as printed) and decodes the pixels with ZXing. */
async function decodeQr(page: Page, svg: string): Promise<string[]> {
  const { width, data } = await page.evaluate(async (markup) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    await img.decode();
    const size = 400;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, size, size);
    g.drawImage(img, 0, 0, size, size);
    return { width: size, data: Array.from(g.getImageData(0, 0, size, size).data) };
  }, svg);
  const wasm = fs.readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
  prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer }, fireImmediately: true });
  const found = await readBarcodes({ data: Uint8ClampedArray.from(data), width, height: width, colorSpace: 'srgb' }, { formats: ['QRCode'] });
  return found.map((r) => r.text);
}

async function shot(page: Page, file: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `docs/${file}` });
}

interface Kit {
  words: string[];
  /** The printable page (the web print view's HTML). */
  printed: string;
}

/**
 * The kit screen: shows the 12 words, sends the entry to the share sheet and opens the print view,
 * then types the 3 words asked. The phrase is erased from the device once they match.
 */
async function saveKit(p: Phone): Promise<Kit> {
  const page = p.page;
  await page.goto(autostart('/kit'));
  await page.getByTestId('kit-reveal').click();
  const cells = page.getByTestId('kit-words').locator('[aria-label^="Word "]');
  await expect(cells).toHaveCount(12);
  const words = (await cells.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))).map((l) => l.replace(/^Word \d+: /, ''));
  await page.getByTestId('kit-share').click();
  await expect.poll(() => p.shared.length).toBe(1);
  // The web print view is a hidden frame holding the printable page (removed a second later): keep
  // a copy of what it holds.
  await page.evaluate(() => {
    const w = window as unknown as { __tlPrinted?: string };
    new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.addedNodes)
          if (n instanceof HTMLIFrameElement) setTimeout(() => (w.__tlPrinted = n.contentDocument?.documentElement.outerHTML ?? ''), 10);
    }).observe(document.body, { childList: true });
  });
  await page.getByTestId('kit-print').click();
  const readPrinted = () => page.evaluate(() => (window as unknown as { __tlPrinted?: string }).__tlPrinted ?? '');
  await expect.poll(readPrinted, { timeout: 15_000 }).not.toBe('');
  const printed = await readPrinted();
  await page.getByTestId('kit-next').click();
  await expect(page.getByTestId('kit-check')).toBeVisible();
  const inputs = page.locator('[data-testid^="kit-word-"]');
  for (let n = 0; n < 3; n++) {
    const label = (await inputs.nth(n).getAttribute('aria-label'))!;
    await inputs.nth(n).fill(words[Number(label.replace('Word ', '')) - 1]!);
  }
  await page.getByTestId('kit-confirm').click();
  await expect(page.getByTestId('kit-done')).toBeVisible();
  await settle(page);
  return { words, printed };
}

/** Losing the phone: everything the app keeps in this browser is wiped. */
async function wipe(page: Page): Promise<void> {
  // A static file of the same origin: the app does not run there, so nothing writes back.
  await page.goto('/metadata.json');
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((resolve, reject) => {
            const r = indexedDB.deleteDatabase(d.name!);
            r.onsuccess = () => resolve();
            r.onerror = () => reject(r.error);
            r.onblocked = () => reject(new Error(`blocked: ${d.name}`));
          }),
      ),
    );
  });
  expect(await page.evaluate(async () => (await indexedDB.databases()).length + localStorage.length)).toBe(0);
}

/** Anna's phone before the loss: places, a photo, her storage and her kit. */
async function beforeLoss(p: Phone, opts: { connected?: boolean } = {}): Promise<Kit> {
  if (!opts.connected) await connectStorage(p);
  await addPlace(p.page, SHARED, { comment: COMMENT });
  await addPlace(p.page, PRIVATE, { private: true });
  await openCard(p.page, SHARED);
  await addPhoto(p.page, PHOTO);
  await settle(p.page);
  const kit = await saveKit(p);
  await sync(p.page);
  // On the storage: the vault and, one device only, a single file in keys/: the phrase-protected
  // copy of the sharing key.
  const list = async (sub: string) => (await fetch(`${DAV}/dav/${p.dir}/${sub}`, { method: 'PROPFIND', headers: { authorization: AUTH, depth: '1' } })).text();
  expect(await list('')).toContain('vault.bin');
  expect([...(await list('keys/')).matchAll(/keys\/([A-Za-z0-9_-]{43})\.bin/g)]).toHaveLength(1);
  return kit;
}

/** On the fresh launch: "I already have TrianguLair on another device" › "Recovery phrase". */
async function openRestore(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('welcome')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('welcome-device').click();
  await page.getByTestId('device-phrase').click();
  await expect(page.getByTestId('device-phrase-form')).toBeVisible();
}

/** After the restore: the map, my places and the photo are back, and the storage still works. */
async function checkRestored(p: Phone): Promise<void> {
  const page = p.page;
  await expect(page.getByTestId('filter-toggle').filter({ visible: true })).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await sync(page, '/sync');
  await page.goto('/');
  await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 60_000 });
  await page.goto('/list');
  await page.getByTestId('list-search').fill('Pendule');
  await expect(page.getByTestId(`row-${PRIVATE}`)).toBeVisible({ timeout: 30_000 });
  const card = await openCard(page, SHARED, '/list');
  await expect(card).toContainText(COMMENT);
  const mine = card.getByTestId('photos-mine');
  await expect(mine.getByTestId('photo-thumb-image')).toHaveCount(1, { timeout: 30_000 });
  await expect(mine.getByTestId('photo-waiting')).toHaveCount(0);
  await mine.locator('[data-testid^="photo-thumb-"]').first().click();
  await expect(page.getByTestId('photo-viewer').getByTestId('photo-full')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'phone-restored-photo.png');
  await page.getByTestId('photo-viewer-close').click();
  // The storage access came back from the vault: a new place goes out.
  await addPlace(page, AFTER, { at: '/' });
  await sync(page, '/sync');
  // The kit is saved already: Settings says so and does not offer it again.
  await page.goto('/settings');
  await expect(page.getByTestId('settings-kit-saved')).toBeVisible();
  await expect(page.getByTestId('settings-kit')).toHaveCount(0);
  expect(p.errors).toEqual([]);
}

test('lost phone: the kit entry from the password manager pasted on a fresh launch brings the places and photos back', async ({ browser }) => {
  test.skip(!proxy, 'Apache WebDAV of packages/storage/scripts/real-servers.sh is not running');
  test.setTimeout(900_000);
  const p = await phone(browser);
  // Ben is a friend: he follows Anna and shares his places with her.
  const ben = await phone(browser);
  await connectStorage(ben, 'Ben');
  await sync(ben.page);
  await connectStorage(p);
  await befriend(p.page, ben.page);
  await addPlace(ben.page, BENS);
  await sync(ben.page);
  await beforeLoss(p, { connected: true });
  await listed(p.page, BENS);
  const contacts = (page: Page) => page.getByTestId('contacts-screen').locator('[data-testid^="contact-"]');
  await p.page.goto(autostart('/contacts'));
  await expect(contacts(p.page)).toContainText(['Ben'], { timeout: 30_000 });
  await sync(ben.page);
  await listed(ben.page, SHARED);
  const entry = p.shared[0]!;
  expect(entry).toContain(p.location);

  await wipe(p.page);
  p.media.length = 0;
  const page = p.page;
  await openRestore(page);
  await page.getByTestId('device-name').fill('Anna’s new phone');
  // The whole entry, pasted: the words and the address are picked out of it.
  await page.getByTestId('device-phrase-words').fill(entry);
  await expect(page.getByTestId('device-phrase-address')).toHaveValue(p.location);
  await expect(page.getByTestId('device-kit-found')).toBeVisible();
  await shot(page, 'phone-restore-kit.png');
  await page.getByTestId('device-phrase-go').click();
  await checkRestored(p);
  // The photo came back from the storage (the wipe left no copy).
  expect(p.media.length).toBeGreaterThanOrEqual(1);
  await page.goto('/devices');
  await expect(page.getByTestId('device-me')).toContainText('Anna’s new phone', { timeout: 30_000 });
  // Friends came back with the vault: Ben's place is on the restored phone, and Ben still reads
  // Anna (same identity, nothing to re-invite): the place added after the restore reaches him.
  await listed(page, BENS, '/list');
  // The name Anna gave him came back too (vault value), not just his key.
  await page.goto('/contacts');
  await expect(contacts(page)).toContainText(['Ben'], { timeout: 30_000 });
  await sync(ben.page);
  await listed(ben.page, AFTER);
  expect(ben.errors).toEqual([]);
  await p.ctx.close();
  await ben.ctx.close();
});

test('lost phone: the printed kit, its QR code for the address and the words typed; mistakes explained first', async ({ browser }) => {
  test.skip(!proxy, 'Apache WebDAV of packages/storage/scripts/real-servers.sh is not running');
  test.setTimeout(600_000);
  const p = await phone(browser);
  const kit = await beforeLoss(p);
  // The printed page: the 12 numbered words, and a QR code that reads as the read address.
  for (const w of kit.words) expect(kit.printed).toContain(`>${w}<`);
  const svg = /<svg[^>]*data-kit-qr=[\s\S]*?<\/svg>/.exec(kit.printed)![0];
  const [qr] = await decodeQr(p.page, svg);
  expect(qr).toBe(p.location);
  if (SHOTS) {
    const printPage = await p.ctx.newPage();
    await printPage.setViewportSize({ width: 794, height: 1123 });
    await printPage.setContent(kit.printed);
    await printPage.screenshot({ path: 'docs/web-kit-print-qr.png' });
    await printPage.close();
  }

  await wipe(p.page);
  const page = p.page;
  await openRestore(page);
  const go = page.getByTestId('device-phrase-go');
  // Not 12 valid words (the last one changed, so the checksum fails): explained, nothing restored.
  const wrong = [...kit.words];
  wrong[11] = wrong[11] === 'zoo' ? 'zone' : 'zoo';
  await page.getByTestId('device-phrase-words').fill(wrong.join(' '));
  await page.getByTestId('device-phrase-address').fill(qr);
  await go.click();
  await expect(page.getByTestId('device-phrase-error')).toHaveText('These are not 12 valid words.', { timeout: 30_000 });
  // The right words, typed loosely, with an address where nothing of mine is.
  await page.getByTestId('device-phrase-words').fill(`  ${kit.words.join('   ').toUpperCase()} `);
  await page.getByTestId('device-phrase-address').fill(`${FRIENDS}/pub/nothing-here-${Date.now()}/`);
  await go.click();
  await expect(page.getByTestId('device-phrase-error')).toContainText(/Nothing answers|No copy of your key/, { timeout: 30_000 });
  // Then the address of the QR code.
  await page.getByTestId('device-phrase-address').fill(qr);
  await go.click();
  await checkRestored(p);
  await p.ctx.close();
});
