/**
 * Shared setup for the end-to-end tests: fixed clock (Friday 23 October 2026, 18:30 in Paris, so
 * "open now" is deterministic), offline base map and photos, and a check that the page logged no
 * uncaught error. Each test gets a new browser context, so a new IndexedDB and the demo seed.
 */
import { expect, test as base, type Page } from '@playwright/test';

export const NOW = new Date('2026-10-23T16:30:00Z');

function style(dark: boolean): string {
  return JSON.stringify({
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': dark ? '#1D232B' : '#ECEBE6' } }],
  });
}

const PHOTO =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#CBD5E1"/></svg>';

/**
 * Offline, deterministic page: fixed clock, placeholder base map and photos. Returns the list of
 * uncaught page errors (filled as they happen).
 */
export async function preparePage(page: Page, dark = false): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') consoleLog(page).push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });
  await page.clock.setSystemTime(NOW);
  await page.route('https://tiles.openfreemap.org/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: style(dark) }),
  );
  await page.route(
    (u) => u.hostname === 'upload.wikimedia.org' || u.hostname.includes('panoramax'),
    (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: PHOTO }),
  );
  return errors;
}

export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page, colorScheme }, use) => {
      const errors = await preparePage(page, colorScheme === 'dark');
      await use(errors);
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Adds `autostart=1` (fixture mode only) so tests skip the first-launch screens. */
export function autostart(path: string): string {
  return path + (path.includes('?') ? '&' : '?') + 'autostart=1';
}

const consoleLogs = new WeakMap<Page, string[]>();
function consoleLog(page: Page): string[] {
  let l = consoleLogs.get(page);
  if (!l) consoleLogs.set(page, (l = []));
  return l;
}

/** What the page shows and logged, printed when an expectation fails (CI only gives the logs). */
export async function diagnose(page: Page, what: string): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => '?');
  const keys = await page.evaluate(() => Object.keys(localStorage).join(', ')).catch(() => '?');
  console.log(`--- ${what} at ${page.url()}\n[text] ${text}\n[localStorage] ${keys}\n[console]\n${consoleLog(page).join('\n')}`);
}

/** Opens the map and waits for the demo pins. */
export async function openMap(page: Page, path = '/'): Promise<void> {
  await page.goto(autostart(path));
  try {
    await expect(page.locator('[data-pin-id]').first()).toBeAttached({ timeout: 30_000 });
  } catch (e) {
    await diagnose(page, 'no pins');
    throw e;
  }
}

/** Moves the web map (MapLibre exposes itself as `window.__tlMap` for tests). */
export async function jump(page: Page, lat: number, lon: number, zoom: number): Promise<void> {
  await page.evaluate(
    ([la, lo, z]) => {
      const m = (window as unknown as { __tlMap: { jumpTo(o: unknown): void } }).__tlMap;
      m.jumpTo({ center: [lo, la], zoom: z });
    },
    [lat, lon, zoom] as const,
  );
  // Let the viewport query and the pins settle.
  await page.waitForTimeout(700);
}

/** Screen position of a coordinate on the map. */
export async function mapPoint(page: Page, lat: number, lon: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([la, lo]) => {
      const m = (window as unknown as {
        __tlMap: { project(c: [number, number]): { x: number; y: number }; getContainer(): HTMLElement };
      }).__tlMap;
      const p = m.project([lo, la]);
      const r = m.getContainer().getBoundingClientRect();
      return { x: p.x + r.left, y: p.y + r.top };
    },
    [lat, lon] as const,
  );
}

/** Taps the map at a coordinate, slower than a double click (which would zoom). */
export async function tapMap(page: Page, lat: number, lon: number): Promise<void> {
  const { x, y } = await mapPoint(page, lat, lon);
  await page.mouse.click(x, y);
  await page.waitForTimeout(600);
}

/** Ids of the pins currently on the map. */
export async function pinIds(page: Page): Promise<string[]> {
  return page.locator('[data-pin-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-pin-id') ?? ''));
}

/** Ids of the pins drawn as matching the filter (not greyed). */
export async function matchingPinIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-pin-id]:not([data-greyed])')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-pin-id') ?? ''));
}

export const demo = (n: number): string => `local:demoplace${String(n).padStart(2, '0')}`;

/** Folds the filter bar (expanded by default) so it does not cover the map. */
export async function collapseFilters(page: Page): Promise<void> {
  const toggle = page.getByTestId('filter-toggle').filter({ visible: true });
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
}

/** Centers the map just above a place and taps its pin (filter bar folded). */
export async function openPin(page: Page, id: string, lat: number, lon: number): Promise<void> {
  await collapseFilters(page);
  await jump(page, lat + 0.0012, lon, 16);
  await page.locator(`[data-pin-id="${id}"]`).click();
  await expect(page.getByTestId('place-card')).toBeVisible();
}
