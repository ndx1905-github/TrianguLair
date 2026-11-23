// SPDX-License-Identifier: MPL-2.0
/**
 * My rating of a place (1 to 5 stars): stored in the save entry of the Yjs
 * document as `rating` (absent: none), projected to `saves.rating`. Older
 * versions ignore the key and keep it (unknown fields); this version reads a
 * document without it (no rating) and ignores a value it cannot read.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocTx, createDataDoc, mergeDataDocs, readRating, saveEntry } from '../src/crdt/doc.ts';
import { readSave } from '../src/crdt/project.ts';
import { NodeSqliteDriver } from '../src/driver/node.ts';
import { DataStore, PROJECTION_VERSION } from '../src/store.ts';
import { SCHEMA_VERSION } from '../src/sqlite/schema.ts';
import { normalizeSnapshot } from '../src/place.ts';
import { FRIEND, ME, hexActor, osmPoint, seqIds } from './helpers.ts';
import { openStore } from './stores.ts';

const P1 = 'osm:node/1';

describe('rating of a save', () => {
  it('round-trips through the document and the projection, and can be cleared', () => {
    const s = openStore();
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), rating: 4 });
    expect(s.repo.getSave(s.saveId(P1))!.rating).toBe(4);
    expect(readSave(s.doc, P1, ME)!.save.rating).toBe(4);
    expect(s.repo.queryPlaces({ source: 'mine' })[0]!.mine!.rating).toBe(4);
    s.updateSave(P1, { rating: 2 });
    expect(s.repo.getSave(s.saveId(P1))!.rating).toBe(2);
    s.updateSave(P1, { rating: null });
    expect(s.repo.getSave(s.saveId(P1))!.rating).toBeNull();
    expect(saveEntry(s.doc, P1)!.has('rating')).toBe(false);
    // Other edits leave it alone.
    s.updateSave(P1, { rating: 5 });
    s.updateSave(P1, { status: 'tried', comment: 'Good' });
    expect(s.repo.getSave(s.saveId(P1))!.rating).toBe(5);
    // Full and incremental projections agree.
    const dump = s.repo.dumpOwnData();
    expect(dump).toContain('"rating":5');
    s.reproject();
    expect(s.repo.dumpOwnData()).toBe(dump);
  });

  it('refuses a value outside 1 to 5 stars and writes nothing', () => {
    const s = openStore();
    for (const bad of [0, 6, 2.5, -1]) {
      expect(() => s.putSave({ place: osmPoint(9, 'X', 1, 1), rating: bad as 1 })).toThrow(/rating/);
    }
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), rating: 3 });
    expect(() => s.updateSave(P1, { rating: 7 as 1, comment: 'changed' })).toThrow(/rating/);
    expect(s.repo.getSave(s.saveId(P1))).toMatchObject({ rating: 3, comment: '' });
  });

  it('reads a document written before ratings (no key) and ignores a value it cannot read', () => {
    const doc = createDataDoc(hexActor(1));
    doc.transact(() => new DocTx(doc).putSave({ place: osmPoint(1, 'Old', 1, 1), status: 'tried' }));
    expect(readSave(doc, P1, ME)!.save.rating).toBeNull();
    // A newer version could store something else there: not a rating for this one.
    for (const v of [7, 3.5, '4', { stars: 4 }]) {
      saveEntry(doc, P1)!.set('rating', v);
      expect(readRating(saveEntry(doc, P1)!)).toBeNull();
      expect(readSave(doc, P1, ME)!.save.rating).toBeNull();
    }
  });

  it('merges like the other fields: concurrent edits of other fields keep it; folded entries keep it', () => {
    const a = openStore({ actor: hexActor(1), newId: seqIds('a-') });
    const b = openStore({ actor: hexActor(2), newId: seqIds('b-') });
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    b.merge(a.doc);
    a.updateSave(P1, { rating: 4 });
    b.updateSave(P1, { comment: 'Good pizza' });
    a.merge(b.doc);
    b.merge(a.doc);
    expect(a.repo.getSave(a.saveId(P1))).toMatchObject({ rating: 4, comment: 'Good pizza' });
    expect(b.repo.dumpOwnData()).toBe(a.repo.dumpOwnData());
    // Two devices saving the same place offline: the rating of either survives the fold.
    const c = openStore({ actor: hexActor(3), newId: seqIds('c-') });
    const d = openStore({ actor: hexActor(4), newId: seqIds('d-') });
    c.putSave({ place: osmPoint(2, 'Sushi', 48.86, 2.36) });
    d.putSave({ place: osmPoint(2, 'Sushi', 48.86, 2.36), rating: 5 });
    c.merge(d.doc);
    d.merge(c.doc);
    expect(c.repo.getSave(c.saveId('osm:node/2'))!.rating).toBe(5);
    expect(d.repo.getSave(d.saveId('osm:node/2'))!.rating).toBe(5);
  });

  it('a version that does not know the key keeps it (unknown field) through its own edits', () => {
    // An older version edits other keys only; Yjs merges per key, so the rating stays.
    const newer = createDataDoc(hexActor(1));
    newer.transact(() => new DocTx(newer).putSave({ place: osmPoint(1, 'Napoli', 1, 1), rating: 4 }));
    const older = createDataDoc(hexActor(2));
    mergeDataDocs(older, newer);
    older.transact(() => {
      const e = saveEntry(older, P1)!;
      e.set('status', 'tried');
      e.set('updatedAt', 2);
    });
    mergeDataDocs(newer, older);
    expect(readSave(newer, P1, ME)!.save).toMatchObject({ rating: 4, status: 'tried' });
    expect(Y.encodeStateVector(newer)).toEqual(Y.encodeStateVector(older));
  });

  it('a relink to another place carries it over, without overwriting the target one', () => {
    const s = openStore();
    s.putSave({ place: { id: 'local:m0000001', name: 'Spot', geometry: { type: 'Point', coordinates: [1, 1] } }, rating: 3 });
    s.relinkSave('local:m0000001', osmPoint(5, 'Spot', 1, 1));
    expect(s.repo.getSave(s.saveId('osm:node/5'))!.rating).toBe(3);
    s.putSave({ place: { id: 'local:m0000002', name: 'Spot 2', geometry: { type: 'Point', coordinates: [2, 2] } }, rating: 1 });
    s.relinkSave('local:m0000002', osmPoint(5, 'Spot', 1, 1));
    expect(s.repo.getSave(s.saveId('osm:node/5'))!.rating).toBe(3);
  });

  it("stores a friend's rating, and none for a value it cannot read", () => {
    const s = openStore();
    const place = normalizeSnapshot(osmPoint(1, 'Napoli', 48.85, 2.35));
    s.repo.upsertForeignSave({ id: `${FRIEND}:1`, ownerId: FRIEND, place, rating: 5, createdAt: 1, updatedAt: 1 });
    expect(s.repo.getSave(`${FRIEND}:1`)!.rating).toBe(5);
    s.repo.upsertForeignSave({ id: `${FRIEND}:1`, ownerId: FRIEND, place, rating: 9 as 5, createdAt: 1, updatedAt: 2 });
    expect(s.repo.getSave(`${FRIEND}:1`)!.rating).toBeNull();
  });
});

describe('migration to schema 4 (rating)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triangulair-rating-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('adds the column and projects ratings already in the document (written by a newer device)', () => {
    expect(SCHEMA_VERSION).toBe(4);
    expect(PROJECTION_VERSION).toBe(4);
    const file = join(dir, 'v3.db');
    const s = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(7) });
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), status: 'tried', rating: 4 });
    s.putSave({ place: osmPoint(2, 'Sushi', 48.86, 2.36) });
    s.repo.upsertForeignSave({
      id: `${FRIEND}:3`, ownerId: FRIEND, place: normalizeSnapshot(osmPoint(3, 'Tacos', 48.87, 2.37)), createdAt: 1, updatedAt: 1,
    });
    // Back to what a version-3 app left: no column, an older projection.
    s.repo.db.exec(`ALTER TABLE saves DROP COLUMN rating; PRAGMA user_version = 3`);
    s.repo.db.run(`UPDATE meta SET value = '3' WHERE key = 'projection_version'`);
    s.close();
    const r = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(7) });
    expect(r.repo.db.get<{ user_version: number }>('PRAGMA user_version')!.user_version).toBe(4);
    expect(r.repo.getSave(r.saveId(P1))).toMatchObject({ status: 'tried', rating: 4 });
    expect(r.repo.getSave(r.saveId('osm:node/2'))!.rating).toBeNull();
    expect(r.repo.getSave(`${FRIEND}:3`)!.rating).toBeNull();
    expect(() => r.repo.db.run(`UPDATE saves SET rating = 6`)).toThrow(/CHECK/);
    r.close();
  });
});
