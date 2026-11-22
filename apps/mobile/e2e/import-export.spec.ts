import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openMap, preparePage, test } from './helpers';

const SMALL = path.join(__dirname, 'fixtures/small.geojson');

async function openImport(page: Page): Promise<void> {
  await page.getByTestId('open-list').click();
  await page.getByTestId('open-import').click();
  await expect(page.getByTestId('import-pick')).toBeVisible();
}

/** From the import "done" step back to the list (import home first). */
async function backToList(page: Page): Promise<void> {
  await page.getByTestId('back').filter({ visible: true }).click();
  await expect(page.getByTestId('import-pick')).toBeVisible();
  await page.getByTestId('back').filter({ visible: true }).click();
  await expect(page.getByTestId('list-search')).toBeVisible();
}

async function pickFile(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-pick').click();
  await (await chooser).setFiles(file);
}

test('import a small GeoJSON file: preview, then import', async ({ page }) => {
  await openMap(page);
  await openImport(page);
  await pickFile(page, SMALL);

  const preview = page.getByTestId('import-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('2 places in small.geojson');
  // One matched to the OSM fixture place, one kept as a manual point.
  await expect(page.getByTestId('preview-groups')).toContainText('Found 1');
  await expect(page.getByTestId('preview-groups')).toContainText('Manual points 1');
  await expect(page.getByTestId('preview-row-Librairie du Haut Marais')).toContainText('Maps and old travel guides');
  // The file's categories become tags.
  await expect(page.getByTestId('tag-row-Books')).toBeVisible();
  await expect(page.getByTestId('tag-row-Workshops')).toBeVisible();

  await page.getByTestId('import-confirm').click();
  const done = page.getByTestId('import-done');
  await expect(done).toBeVisible();
  await expect(done).toContainText('2 places imported');

  // Both are in my places, with the comment from the file.
  await backToList(page);
  await page.getByTestId('list-search').fill('pottery');
  await expect(page.getByTestId('row-Atelier Céramique Test')).toBeVisible();
});

test('export everything and re-import it on a fresh device', async ({ page, browser }) => {
  await openMap(page);
  await openImport(page);
  await pickFile(page, SMALL);
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-done')).toBeVisible();

  // Export: a GeoJSON download in our format, with the imported place and its comment.
  await page.getByText('Import another file').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-all').click();
  const file = await (await download).path();
  const data = JSON.parse(await readFile(file, 'utf8')) as {
    type: string;
    triangulair: { format: string };
    features: { properties: { name: string; comment?: string } }[];
  };
  expect(data.type).toBe('FeatureCollection');
  expect(data.triangulair.format).toBe('triangulair-export');
  const atelier = data.features.find((f) => f.properties.name === 'Atelier Céramique Test');
  expect(atelier?.properties.comment).toBe('Pottery class on Thursdays');

  // A new device (empty storage, demo seed only): import the export.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'Europe/Paris' });
  const other = await ctx.newPage();
  const errors = await preparePage(other);
  await openMap(other);
  const count = other.getByTestId('filter-count').filter({ visible: true });
  const before = Number((await count.innerText()).match(/\d+/)?.[0]);
  await openImport(other);
  await pickFile(other, file);
  const preview = other.getByTestId('import-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(`${data.features.length} places`);
  await other.getByTestId('import-confirm').click();
  await expect(other.getByTestId('import-done')).toBeVisible();
  await backToList(other);
  // The demo places (same ids on both devices) are merged, not duplicated: only the two imported ones are new.
  await expect(count).toHaveText(`${before + 2} places`);
  await other.getByTestId('list-search').fill('pottery');
  const row = other.getByTestId('row-Atelier Céramique Test');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Workshops');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('tags of the file: my tag preselected for the same name, suggested for a synonym, all at once', async ({ page }) => {
  await openMap(page);
  await openImport(page);
  const feature = (name: string, category: string, lon: number) => ({
    type: 'Feature',
    properties: { name, category },
    geometry: { type: 'Point', coordinates: [lon, 48.85] },
  });
  const file = {
    type: 'FeatureCollection',
    features: [feature('Spot one', 'Cafés ☕', 2.30), feature('Spot two', 'Resto', 2.31), feature('Spot three', 'Sushi', 2.32)],
  };
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-pick').click();
  await (await chooser).setFiles({ name: 'tags.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.getByTestId('import-preview')).toBeVisible();

  // Same name once case, accents, emoji and plural are ignored: my "Café", already chosen.
  await expect(page.getByTestId('tag-Cafés ☕-map-Café')).toHaveAttribute('aria-checked', 'true');
  // A synonym: "Suggested: Restaurant" first, not chosen; the file's tag stays new until then.
  const suggested = page.getByTestId('tag-Resto-suggested');
  await expect(suggested).toHaveText(/Suggested: Restaurant/);
  await expect(suggested).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('tag-Resto-new')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('tag-Sushi-suggested')).toHaveCount(0);

  await page.getByTestId('import-tags-same').click();
  await expect(suggested).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('tag-Sushi-new')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('import-tags-same')).toHaveCount(0);
});
