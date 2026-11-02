// SPDX-License-Identifier: MPL-2.0
/**
 * T-115: the full GeoJSON export, re-imported into an empty store, gives back
 * the same data (places, zones, tags with their tree and colors, comments and
 * their visibility, statuses, prices, sharing, dates, photos metadata, trash,
 * lists with filters and manual items, tag mappings). Ids of tags and lists
 * are new; everything is compared through names.
 */
import { newLocalPlaceId, type DataStore } from '@triangulair/data';
import { describe, expect, it } from 'vitest';

import { applyImport, buildExport, buildPlan, exportFileName, exportGeoJson, matchPlaces, readImportFile, type ParseResult } from '../src/index.ts';
import { openStore } from './helpers.ts';

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
  });
  s.addMedia('osm:node/9123456702', { id: 'm1', file: 'media/abc.webp', blurhash: 'LEHV6n', width: 1600, height: 1200 });
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
      },
    })),
    tags: doc.triangulair.tags.map((t) => ({ ...t, id: path(t.id), parent_id: path(t.parent_id), deleted_at: !!t.deleted_at })).sort((a, b) => a.id!.localeCompare(b.id!)),
    lists: doc.triangulair.lists
      .map((l) => ({ ...l, id: undefined, created_at: undefined, deleted_at: !!l.deleted_at, filter: { ...l.filter, tags: l.filter.tags?.map(path) } }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    tagMappings: doc.triangulair.tag_mappings.map((m) => ({ ...m, my_tag_id: path(m.my_tag_id) })),
  };
}

async function reimport(json: string, into: DataStore) {
  const o = readImportFile({ name: exportFileName(0), text: json });
  if (o.kind !== 'parsed') throw new Error(JSON.stringify(o));
  const r: ParseResult = o.result;
  expect(r.format).toBe('triangulair');
  const plan = buildPlan(r, await matchPlaces(r.places, null), into.repo);
  return applyImport(into, plan, { yieldFn: noYield, batchSize: 2 });
}

describe('full GeoJSON export and lossless re-import (T-115)', () => {
  it('is valid GeoJSON, readable by other tools (names, plain tags, OSM links)', () => {
    const doc = buildExport(richStore(), { now: () => Date.UTC(2026, 10, 2), app: 'TrianguLair test' });
    expect(doc.type).toBe('FeatureCollection');
    expect(doc.triangulair).toMatchObject({ format: 'triangulair-export', version: 1, minor: 0, exported_at: '2026-11-02T00:00:00.000Z' });
    const t = doc.features.find((f) => f.id === 'osm:node/9123456702')!;
    expect(t.geometry).toEqual({ type: 'Point', coordinates: [2.3621507, 48.8591004] });
    expect(t.properties).toMatchObject({ name: 'Trattoria Da Lucia', osm: 'node/9123456702', osm_url: 'https://www.openstreetmap.org/node/9123456702', tags: ['Pizza', 'Food'], status: 'favorite', price_level: 2 });
    expect(doc.features).toHaveLength(5);
    expect(exportFileName(Date.UTC(2026, 10, 2))).toBe('triangulair-2026-11-02.geojson');
  });

  it('round trip into an empty store gives the same data', async () => {
    const a = richStore();
    const json = exportGeoJson(a);
    const b = openStore('b');
    const report = await reimport(json, b);
    expect(report.counts).toMatchObject({ created: 5, merged: 0, skipped: 0 });
    expect(canonical(b)).toEqual(canonical(a));
    // And a second generation is still the same.
    const c = openStore('c');
    await reimport(exportGeoJson(b), c);
    expect(canonical(c)).toEqual(canonical(a));
  });

  it('re-importing my own export into the same store changes nothing', async () => {
    const a = richStore();
    const before = canonical(a);
    const report = await reimport(exportGeoJson(a), a);
    expect(report.counts).toMatchObject({ created: 0, merged: 5 });
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
