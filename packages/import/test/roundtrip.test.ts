// SPDX-License-Identifier: MPL-2.0
/**
 * T-115: the full GeoJSON export, re-imported into an empty store, gives back
 * the same data (places, zones, tags with their tree and colors, comments and
 * their visibility, statuses, prices, sharing, dates, photos metadata, trash,
 * lists with filters and manual items, tag mappings). Ids of tags, lists
 * and photos are new; everything is compared through names. With photos the
 * export is a ZIP archive holding the GeoJSON and my photos' images.
 */
import { newLocalPlaceId, type DataStore } from '@triangulair/data';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_DOCUMENT,
  applyImport,
  buildExport,
  buildPlan,
  exportArchive,
  exportFileName,
  exportGeoJson,
  matchPlaces,
  readImportFile,
  undoImport,
  type ApplyOptions,
  type ExportDocument,
  type ParseResult,
} from '../src/index.ts';
import { openStore } from './helpers.ts';

/**
 * The app keeps my photos' images in its photo store (sync package, `Photos`); here, a map per store
 * by photo id. `addPhoto` and `image` are what the app gives the import and the export.
 */
const images = new WeakMap<DataStore, Map<string, { full: Uint8Array; thumb: Uint8Array; mime: string }>>();
const imagesOf = (s: DataStore) => images.get(s) ?? images.set(s, new Map()).get(s)!;
const img = (seed: number, n: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed) & 255);
function addPhotoTo(s: DataStore): NonNullable<ApplyOptions['addPhoto']> {
  return (placeId, p) => {
    const id = s.addMedia(placeId, { file: p.file, thumb: p.thumb ?? null, mime: p.mime ?? null, blurhash: p.blurhash ?? null, width: p.width ?? null, height: p.height ?? null, ...(p.createdAt !== undefined && { createdAt: p.createdAt }) });
    imagesOf(s).set(id, { ...p.images, mime: p.mime ?? 'image/webp' });
    return id;
  };
}
const imageOf = (s: DataStore) => async (id: string, which: 'full' | 'thumb') => {
  const i = imagesOf(s).get(id);
  return i ? { bytes: i[which], mime: i.mime } : null;
};

const noYield = () => Promise.resolve();

function richStore(): DataStore {
  const s = openStore('a');
  const food = s.createTag({ name: 'Food', color: '#EF4444', icon: 'restaurant', osmCategories: ['amenity=restaurant'] });
  const pizza = s.createTag({ name: 'Pizza', parentId: food, color: '#EA580C' });
  const drinks = s.createTag({ name: 'Drinks', color: '#3B82F6' });
  // Same name as another tag, under another parent: ids keep them apart.
  const dPizza = s.createTag({ name: 'Pizza', parentId: drinks });
  const old = s.createTag({ name: 'Old tag' });
  s.deleteTag(old);
  const pt = (lon: number, lat: number) => ({ type: 'Point' as const, coordinates: [lon, lat] });
  s.putSave({
    place: { osm: { type: 'node', id: 9123456702 }, name: 'Trattoria Da Lucia', category: 'amenity=restaurant', geometry: pt(2.3621507, 48.8591004) },
    tagIds: [pizza, food],
    mainTagId: pizza,
    comment: 'Carbonara!\nSecond line',
    commentVisibility: 'public',
    status: 'favorite',
    priceLevel: 2,
    rating: 5,
  });
  const m1 = s.addMedia('osm:node/9123456702', { id: 'm1', file: 'b2b256:full1', thumb: 'b2b256:thumb1', mime: 'image/webp', blurhash: 'LEHV6n', width: 1600, height: 1200 });
  imagesOf(s).set(m1, { full: img(1, 3000), thumb: img(2, 300), mime: 'image/webp' });
  const manual = newLocalPlaceId(() => 'abcdefghijklmnopqrstuvwxyz');
  s.putSave({ place: { id: manual, name: 'Chez Mamie Rose', geometry: pt(2.3555, 48.8648) }, tagIds: [dPizza], sharing: 'private', status: 'to_try' });
  const zone = newLocalPlaceId(() => 'zzzzzzzzzzzzzzzzzzzzzzzzzz');
  s.putSave({
    place: {
      id: zone,
      name: 'My Marais',
      kind: 'zone',
      edge: 'blurred',
      geometry: { type: 'Polygon', coordinates: [[[2.355, 48.853], [2.368, 48.853], [2.368, 48.864], [2.355, 48.864], [2.355, 48.853]]] },
    },
    tagIds: [drinks],
  });
  s.putSave({ place: { osm: { type: 'way', id: 412345678 }, name: 'Musée des Cartes Anciennes', category: 'tourism=museum', geometry: pt(2.3624401, 48.8579912) }, status: 'tried', commentVisibility: 'private', comment: 'secret' });
  s.putSave({ place: { osm: { type: 'node', id: 9123456705 }, name: 'Parking Saint-Gilles', geometry: pt(2.3620411, 48.8589901) } });
  s.deleteSave('osm:node/9123456705');
  s.createList({ name: 'Pizza in my Marais', kind: 'filter', visibility: 'public', filter: { tags: [pizza], statuses: ['favorite'], zones: [{ kind: 'drawn', geometry: { type: 'Polygon', coordinates: [[[2.35, 48.85], [2.37, 48.85], [2.37, 48.87], [2.35, 48.85]]] } }], exclude: [manual] } });
  s.createList({ name: 'For Léa', kind: 'manual', linkKey: 'k3y', description: 'Hand-picked', items: ['osm:node/9123456702', manual] });
  const gone = s.createList({ name: 'Old list', kind: 'manual' });
  s.deleteList(gone);
  s.setTagMapping('ed25519:lea', 'Pizzeria', pizza);
  return s;
}

/** The export with tag and list ids replaced by names, and the volatile parts dropped. */
function canonical(store: DataStore): unknown {
  const doc = buildExport(store, { now: () => 0 });
  const tagById = new Map(doc.triangulair.tags.map((t) => [t.id, t]));
  const path = (id: string | null): string | null => {
    if (!id) return null;
    const t = tagById.get(id);
    return t ? `${path(t.parent_id) ?? ''}/${t.name}` : `?${id}`;
  };
  return {
    features: doc.features.map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        tag_ids: f.properties.tag_ids.map(path).sort(),
        main_tag_id: path(f.properties.main_tag_id),
        // Re-import rewrites these: import time (trash) / photos added after the save.
        updated_at: undefined,
        deleted_at: f.properties.deleted_at ? 'trashed' : null,
        media: f.properties.media?.map((m) => ({ ...m, id: undefined })),
      },
    })),
    tags: doc.triangulair.tags.map((t) => ({ ...t, id: path(t.id), parent_id: path(t.parent_id), deleted_at: !!t.deleted_at })).sort((a, b) => a.id!.localeCompare(b.id!)),
    lists: doc.triangulair.lists
      .map((l) => ({ ...l, id: undefined, created_at: undefined, deleted_at: !!l.deleted_at, filter: { ...l.filter, tags: l.filter.tags?.map(path) } }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    tagMappings: doc.triangulair.tag_mappings.map((m) => ({ ...m, my_tag_id: path(m.my_tag_id) })),
  };
}

async function reimport(file: string | Uint8Array, into: DataStore) {
  const o = readImportFile(typeof file === 'string' ? { name: exportFileName(0), text: file } : { name: exportFileName(0, 'zip'), bytes: file });
  if (o.kind !== 'parsed') throw new Error(JSON.stringify(o));
  const r: ParseResult = o.result;
  expect(r.format).toBe('triangulair');
  // Merging into my existing saves is the user's choice in the preview; a restore asks for it.
  const plan = { ...buildPlan(r, await matchPlaces(r.places, null), into.repo), mergeExisting: true };
  return applyImport(into, plan, { yieldFn: noYield, batchSize: 2, addPhoto: addPhotoTo(into) });
}

/** The archive export of a store (with its photos' images). */
const archive = async (s: DataStore) => (await exportArchive(s, { image: imageOf(s), now: () => Date.UTC(2026, 10, 21) })).bytes;

describe('full GeoJSON export and lossless re-import (T-115)', () => {
  it('is valid GeoJSON, readable by other tools (names, plain tags, OSM links)', () => {
    const doc = buildExport(richStore(), { now: () => Date.UTC(2026, 10, 2), app: 'TrianguLair test' });
    expect(doc.type).toBe('FeatureCollection');
    expect(doc.triangulair).toMatchObject({ format: 'triangulair-export', version: 1, minor: 2, exported_at: '2026-11-02T00:00:00.000Z' });
    const t = doc.features.find((f) => f.id === 'osm:node/9123456702')!;
    expect(t.geometry).toEqual({ type: 'Point', coordinates: [2.3621507, 48.8591004] });
    expect(t.properties).toMatchObject({ name: 'Trattoria Da Lucia', osm: 'node/9123456702', osm_url: 'https://www.openstreetmap.org/node/9123456702', tags: ['Pizza', 'Food'], status: 'favorite', price_level: 2, rating: 5 });
    expect(doc.features).toHaveLength(5);
    expect(exportFileName(Date.UTC(2026, 10, 2))).toBe('triangulair-2026-11-02.geojson');
  });

  it('round trip into an empty store gives the same data, photos included', async () => {
    const a = richStore();
    const zip = await archive(a);
    const b = openStore('b');
    const report = await reimport(zip, b);
    expect(report.counts).toMatchObject({ created: 5, merged: 0, skipped: 0, photos: 1, photosSkipped: 0 });
    expect(canonical(b)).toEqual(canonical(a));
    // The images came back, decrypted, on the same place, with their date and author.
    const [m] = b.repo.mediaForPlace('osm:node/9123456702');
    expect(m).toMatchObject({ mine: true, file: 'b2b256:full1', thumb: 'b2b256:thumb1', mime: 'image/webp', width: 1600, height: 1200, createdAt: a.repo.mediaById('m1')!.createdAt });
    expect(imagesOf(b).get(m!.id)).toEqual(imagesOf(a).get('m1'));
    // And a second generation is still the same.
    const c = openStore('c');
    await reimport(await archive(b), c);
    expect(canonical(c)).toEqual(canonical(a));
  });

  it('with photos the export is a ZIP: the GeoJSON document and each photo\'s full image and thumbnail', async () => {
    const a = richStore();
    const out = await exportArchive(a, { image: imageOf(a), now: () => Date.UTC(2026, 10, 21) });
    expect(out).toMatchObject({ name: 'triangulair-2026-11-21.zip', mime: 'application/zip', photos: 1, missing: 0 });
    const files = unzipSync(out.bytes);
    expect(Object.keys(files).sort()).toEqual(['photos/0001-thumb.webp', 'photos/0001.webp', ARCHIVE_DOCUMENT]);
    expect(files['photos/0001.webp']).toEqual(imagesOf(a).get('m1')!.full);
    const doc = JSON.parse(new TextDecoder().decode(files[ARCHIVE_DOCUMENT])) as ExportDocument;
    const media = doc.features.find((f) => f.id === 'osm:node/9123456702')!.properties.media;
    expect(media).toEqual([
      {
        id: 'm1', file: 'b2b256:full1', thumb: 'b2b256:thumb1', mime: 'image/webp', blurhash: 'LEHV6n', width: 1600, height: 1200,
        created_at: new Date(a.repo.mediaById('m1')!.createdAt).toISOString(), author: a.repo.meId, image: 'photos/0001.webp', thumb_image: 'photos/0001-thumb.webp',
      },
    ]);
    // Without photos: the plain GeoJSON file, as before.
    const plain = openStore('p');
    plain.putSave({ place: { osm: { type: 'node', id: 1 }, name: 'X', geometry: { type: 'Point', coordinates: [2.35, 48.85] } } });
    expect(await exportArchive(plain, { image: imageOf(plain), now: () => 0 })).toMatchObject({ name: 'triangulair-1970-01-01.geojson', mime: 'application/geo+json', photos: 0 });
  });

  it('only my photos are exported, never a friend\'s', async () => {
    const a = richStore();
    a.repo.upsertForeignSave({ id: 'f1', ownerId: 'ed25519:lea', place: { id: 'osm:node/9123456702', osmType: 'node', osmId: 9123456702, name: 'Trattoria Da Lucia', category: null, kind: 'place', edge: 'sharp', geometry: { type: 'Point', coordinates: [2.3621507, 48.8591004] } }, createdAt: 1, updatedAt: 1 });
    a.repo.setForeignMedia('f1', [{ id: 'theirs', file: 'b2b256:ef', thumb: 'b2b256:et', mime: 'image/webp', bytes: 10, upload: { key: 'k', full: 'b2b256:ef', thumb: 'b2b256:et' }, blurhash: null, width: 4, height: 3, createdAt: 5 }]);
    const asked: string[] = [];
    const out = await exportArchive(a, { image: async (id, w) => (asked.push(id), imageOf(a)(id, w)) });
    expect(out.photos).toBe(1);
    expect([...new Set(asked)]).toEqual(['m1']);
    const doc = buildExport(a);
    expect(doc.features.flatMap((f) => f.properties.media ?? []).map((m) => m.author)).toEqual([a.repo.meId]);
  });

  it('a plain GeoJSON export carries the photos\' metadata only: they are not imported (no image), and said so', async () => {
    const a = richStore();
    const o = readImportFile({ name: 'x.geojson', text: exportGeoJson(a) });
    expect(o.kind === 'parsed' && o.result.warnings).toContainEqual({ code: 'photos-not-included', detail: '1' });
    const b = openStore('b');
    const report = await reimport(exportGeoJson(a), b);
    expect(report.counts).toMatchObject({ created: 5, photos: 0, photosSkipped: 1 });
    expect(b.repo.mediaForPlace('osm:node/9123456702')).toEqual([]);
  });

  it('photos merged into an existing save are not added twice, and an undo removes them', async () => {
    const a = richStore();
    const zip = await archive(a);
    const b = openStore('b');
    b.putSave({ place: { osm: { type: 'node', id: 9123456702 }, name: 'Trattoria Da Lucia', geometry: { type: 'Point', coordinates: [2.3621507, 48.8591004] } } });
    const report = await reimport(zip, b);
    expect(report.counts).toMatchObject({ merged: 1, photos: 1 });
    expect(b.repo.mediaForPlace('osm:node/9123456702')).toHaveLength(1);
    expect((await reimport(zip, b)).counts).toMatchObject({ photos: 0 });
    expect(b.repo.mediaForPlace('osm:node/9123456702')).toHaveLength(1);
    await undoImport(b, report, { yieldFn: noYield });
    expect(b.repo.mediaForPlace('osm:node/9123456702')).toEqual([]);
  });

  it('re-importing my own export into the same store changes nothing', async () => {
    const a = richStore();
    const before = canonical(a);
    const report = await reimport(await archive(a), a);
    expect(report.counts).toMatchObject({ created: 0, merged: 5, photos: 0 });
    expect(report.createdListIds).toHaveLength(0);
    expect(canonical(a)).toEqual(before);
  });

  it('a newer minor version is read (unknown fields ignored), a newer major refused', () => {
    const doc = buildExport(richStore());
    const newer = { ...doc, triangulair: { ...doc.triangulair, minor: 7, future: { x: 1 } } };
    const o = readImportFile({ name: 'x.geojson', text: JSON.stringify(newer) });
    expect(o.kind === 'parsed' && o.result.warnings).toContainEqual({ code: 'newer-version', detail: '1.7' });
    const major = { ...doc, triangulair: { ...doc.triangulair, version: 2 } };
    expect(readImportFile({ name: 'x.geojson', text: JSON.stringify(major) })).toMatchObject({ kind: 'error', code: 'too-new' });
  });
});
