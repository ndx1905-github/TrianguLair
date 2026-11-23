import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { autostart, diagnose, expect, openMap, preparePage, test } from './helpers';

const SMALL = path.join(__dirname, 'fixtures/small.geojson');
/** The import package's INVENTED Mapstr export (4 places, macOS junk included). */
const MAPSTR_ZIP = path.join(__dirname, '../../../packages/import/test/fixtures/mapstr/mapstr.zip');
/** The import package's INVENTED Pin Drop export (4 pins, 2 secret, 2 photos, references to tags not in the file). */
const PINDROP = path.join(__dirname, '../../../packages/import/test/fixtures/pindrop/pindrop.json');
const PINDROP_CUT = path.join(__dirname, '../../../packages/import/test/fixtures/pindrop/invalid.json');

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

test('import a Mapstr ZIP: counts, tags matched, status, comment, date; a second import adds nothing', async ({ page }) => {
  await openMap(page);
  await openImport(page);
  await expect(page.getByTestId('import-screen')).toContainText('Mapstr export (the ZIP');
  await pickFile(page, MAPSTR_ZIP);

  const preview = page.getByTestId('import-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Mapstr export · 4 places in mapstr.zip');
  await expect(page.getByTestId('unverified-banner')).toHaveCount(0);
  await expect(page.getByTestId('preview-counts')).toHaveText('New: 4 · Already in my places: 0 · Duplicates in this file: 0');
  // Photos stay on Mapstr unless asked for (no photo store here, so not offered); ratings become my rating.
  await expect(page.getByTestId('preview-warning-remote-photos')).toHaveText('2 photos are on Mapstr’s server: they are imported only if you download them below.');
  await expect(page.getByTestId('preview-ratings')).toHaveText('★ 2 places with a rating');
  await expect(page.getByTestId('preview-warning-unreadable-ratings')).toHaveCount(0);
  // Categorized places OpenStreetMap does not know there: flagged, kept by default.
  await expect(page.getByTestId('preview-closure')).toContainText('3 places may no longer exist according to OpenStreetMap');
  await expect(page.getByTestId('preview-closure-keep')).toHaveAttribute('aria-checked', 'true');
  // Tags: my "Restaurant" and "Bar" for the same names; "À essayer" is the status; criteria explained.
  await expect(page.getByTestId('tag-Restaurant-map-Restaurant')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('tag-Bar-map-Bar')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('tag-À essayer-status')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('tag-Openair-criterion')).toContainText('Terrace');
  await expect(page.getByTestId('tag-Lire commentaire-new')).toHaveAttribute('aria-checked', 'true');
  // The comment with a comma, on its row.
  await page.getByTestId('preview-groups').getByText(/^Manual points/).click();
  await expect(page.getByTestId('preview-row-Crêperie des Lanternes')).toContainText('Buckwheat crêpes, cider, friendly staff');

  await page.getByTestId('import-confirm').click();
  const done = page.getByTestId('import-done');
  await expect(done).toBeVisible();
  await expect(done).toContainText('4 places imported');

  // The original date is kept (local time of the export, Europe/Paris here), the rating is my rating, photos are not written.
  await page.getByText('Import another file').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-all').click();
  const text = await readFile(await (await download).path(), 'utf8');
  const data = JSON.parse(text) as { features: { properties: { name: string; comment?: string; created_at: string; status?: string | null; rating?: number | null } }[] };
  const crepe = data.features.find((f) => f.properties.name === 'Crêperie des Lanternes');
  expect(crepe?.properties.created_at.startsWith('2022-03-05T18:07')).toBe(true);
  expect(crepe?.properties.comment).toBe('Buckwheat crêpes, cider, friendly staff');
  expect(crepe?.properties.status).toBe('to_try');
  expect(text).not.toContain('images.example.invalid');
  expect(crepe?.properties.rating).toBeNull();
  expect(data.features.find((f) => f.properties.name === 'Le Comptoir Inventé')?.properties.rating).toBe(4);
  expect(data.features.find((f) => f.properties.name === 'Le Comptoir Inventé')?.properties.comment).toBe('Natural wines; ask for the "wine of the day"');

  // The same file again: everything is already in my places, nothing is written.
  await pickFile(page, MAPSTR_ZIP);
  await expect(page.getByTestId('preview-counts')).toHaveText('New: 0 · Already in my places: 4 · Duplicates in this file: 0');
  // Their ratings are already set: nothing to fill in either.
  await expect(page.getByTestId('import-confirm')).toBeDisabled();
  // What's new (from the map): the places the first import wrote "maybe closed", in one entry (not repeated).
  await page.getByTestId('back').filter({ visible: true }).click();
  await expect(page.getByTestId('import-pick')).toBeVisible();
  await page.getByTestId('back').filter({ visible: true }).click();
  await expect(page.getByTestId('list-search')).toBeVisible();
  await page.getByTestId('back').filter({ visible: true }).click();
  await page.getByTestId('open-whatsnew').click();
  const news = page.getByTestId('whatsnew-item-closureImport');
  await expect(news).toHaveCount(1).catch(async (e: unknown) => {
    await diagnose(page, 'no grouped import entry in What’s new');
    throw e;
  });
  await expect(news).toContainText('3 imported places may no longer exist according to OpenStreetMap');
  await expect(news.getByTestId('whatsnew-unseen')).toBeVisible();

  // The card shows the imported rating as my stars.
  await page.waitForTimeout(1500); // the database file is written after a short debounce
  await page.goto(autostart('/list'));
  await page.getByTestId('row-Le Comptoir Inventé').click();
  const stars = page.getByTestId('place-card').filter({ visible: true }).getByTestId('rating');
  await expect(stars.getByRole('radio', { name: '4 stars', exact: true })).toBeChecked();
  await expect(stars.getByRole('radio', { name: '5 stars', exact: true })).not.toBeChecked();
});

test('import a Pin Drop export: verified, statuses, secret places private, missing tags counted, photos not fetched', async ({ page }) => {
  const photoRequests: string[] = [];
  await page.route('https://pins.example.org/**', async (route) => {
    photoRequests.push(route.request().url());
    await route.abort();
  });
  await openMap(page);
  await openImport(page);
  await expect(page.getByTestId('import-screen')).toContainText('Pin Drop export (.json)');

  // A file cut short: a clear error, nothing imported.
  await pickFile(page, PINDROP_CUT);
  await expect(page.getByTestId('import-message')).toHaveText('This Pin Drop export is not valid JSON: it may be incomplete or have been edited by hand. Export it again from Pin Drop.');

  await pickFile(page, PINDROP);
  const preview = page.getByTestId('import-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Pin Drop export · 4 places in pindrop.json');
  await expect(page.getByTestId('unverified-banner')).toHaveCount(0);
  await expect(page.getByTestId('preview-counts')).toHaveText('New: 4 · Already in my places: 0 · Duplicates in this file: 0');
  await expect(page.getByTestId('preview-warning-missing-tags')).toHaveText('3 places refer to tags that are not in this file (an edited export?): those tags are left out.');
  await expect(page.getByTestId('preview-warning-secret-places')).toHaveText('2 places were secret in Pin Drop: they are imported private (not shared with friends, comments private).');
  await expect(page.getByTestId('preview-warning-remote-photos')).toHaveText('2 photos are on Pin Drop’s server: they are imported only if you download them below.');
  // Tags: "À essayer" is the status; criteria explained; "Lire commentaire" is a tag like any other.
  await expect(page.getByTestId('tag-À essayer-status')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('tag-Openair-criterion')).toContainText('Terrace');
  await expect(page.getByTestId('tag-Lire commentaire-new')).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('import-confirm').click();
  const done = page.getByTestId('import-done');
  await expect(done).toBeVisible();
  await expect(done).toContainText('4 places imported');
  await expect(page.getByTestId('import-done-remotePhotos')).toHaveCount(0);

  // Statuses, privacy, dates and comments as mapped; no photo URL written, none requested.
  await page.getByText('Import another file').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-all').click();
  const text = await readFile(await (await download).path(), 'utf8');
  type Props = { name: string; comment?: string; created_at: string; status?: string | null; sharing: string; comment_visibility: string };
  const data = JSON.parse(text) as { features: { properties: Props }[] };
  const of = (name: string) => data.features.find((f) => f.properties.name === name)?.properties;
  expect(of('Café Pendule')).toMatchObject({ status: 'favorite', sharing: 'friends', comment: 'Quiet in the morning\nGood filter coffee' });
  expect(of('Café Pendule')?.created_at.startsWith('2024-11-05T09:12:31')).toBe(true);
  expect(of('Boulangerie des Remparts Fictifs')).toMatchObject({ status: 'to_try', sharing: 'private', comment_visibility: 'private' });
  expect(of('Le Bar Imaginaire')).toMatchObject({ status: 'to_try' });
  expect(of('Kiosque Sans Nom')).toMatchObject({ status: 'favorite', sharing: 'private' });
  expect(text).not.toContain('pins.example.org');
  expect(text).not.toContain('1c9e1534');
  expect(photoRequests).toEqual([]);

  // The same file again: nothing new.
  await pickFile(page, PINDROP);
  await expect(page.getByTestId('preview-counts')).toHaveText('New: 0 · Already in my places: 4 · Duplicates in this file: 0');
});
