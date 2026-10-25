import * as A from '@automerge/automerge';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDataDoc, DocTx, TOMBSTONE_RETENTION_MS, TRASH_RETENTION_MS } from '../src/crdt/doc.ts';
import { readTags } from '../src/crdt/project.ts';
import { NodeSqliteDriver } from '../src/driver/node.ts';
import { saveIdFor } from '../src/ids.ts';
import { DataStore } from '../src/store.ts';
import { fakeClock, hexActor, localPoint, ME, osmPoint, rect, seqIds } from './helpers.ts';
import { openStore } from './stores.ts';

/** Two devices of the same person. */
function twoDevices() {
  const a = openStore({ actor: hexActor(1), newId: seqIds('a-') });
  const b = openStore({ actor: hexActor(2), newId: seqIds('b-') });
  return { a, b };
}

/** Full exchange until both hold the same document. */
function sync(...stores: DataStore[]): void {
  for (let round = 0; round < 3; round++) {
    for (const x of stores) for (const y of stores) if (x !== y) x.merge(y.doc);
  }
}

const P1 = 'osm:node/1';

describe('Automerge document', () => {
  it('two devices that never met share the root maps (deterministic base change)', () => {
    const d1 = A.change(createDataDoc(hexActor(1)), (d) => new DocTx(d).putSave({ place: osmPoint(1, 'A', 1, 1) }));
    const d2 = A.change(createDataDoc(hexActor(2)), (d) => new DocTx(d).putSave({ place: osmPoint(2, 'B', 2, 2) }));
    const m = A.merge(d1, d2);
    expect(Object.keys(m.saves).sort()).toEqual(['osm:node/1', 'osm:node/2']);
    expect(A.getConflicts(m, 'saves')).toBeUndefined();
  });

  it('edits on two devices converge to the same projection', () => {
    const { a, b } = twoDevices();
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), comment: 'Good pizza' });
    sync(a, b);
    a.updateSave(P1, { comment: 'Very good pizza' });
    b.updateSave(P1, { comment: 'Good pizza, nice terrace' });
    b.updateSave(P1, { status: 'tried' });
    sync(a, b);
    const s = a.repo.getSave(a.saveId(P1))!;
    expect(s.comment).toBe('Very good pizza, nice terrace'); // character-level merge
    expect(s.status).toBe('tried');
    expect(a.repo.dumpOwnData()).toBe(b.repo.dumpOwnData());
    expect(A.getHeads(a.doc).sort()).toEqual(A.getHeads(b.doc).sort());
  });

  it('the same OSM place saved offline on both devices: one save, both contributions kept', () => {
    const { a, b } = twoDevices();
    const ta = a.createTag({ name: 'Pizza' });
    const tb = b.createTag({ name: 'Date night' });
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), tagIds: [ta], status: 'favorite' });
    b.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), tagIds: [tb], comment: 'Ask for the terrace', priceLevel: 2 });
    sync(a, b);
    const s = a.repo.getSave(a.saveId(P1))!;
    expect(new Set(s.tagIds)).toEqual(new Set([ta, tb]));
    expect(s.comment).toBe('Ask for the terrace');
    expect(s.status).toBe('favorite');
    expect(s.priceLevel).toBe(2);
    expect(a.repo.queryPlaces({ bbox: [2, 48, 3, 49] })).toHaveLength(1);
    expect(a.repo.dumpOwnData()).toBe(b.repo.dumpOwnData());
    // The healed-in tag can be removed for good: it does not come back on the next merge.
    a.removeSaveTag(P1, tb);
    sync(a, b);
    expect(b.repo.getSave(b.saveId(P1))!.tagIds).toEqual([ta]);
  });

  it('delete while the other device edits: deletion wins, the edit is kept in the trash', () => {
    const { a, b } = twoDevices();
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), comment: 'ok' });
    sync(a, b);
    a.deleteSave(P1);
    b.updateSave(P1, { comment: 'ok, closed on Mondays' });
    sync(a, b);
    for (const s of [a, b]) {
      const save = s.repo.getSave(s.saveId(P1))!;
      expect(save.deletedAt).not.toBeNull();
      expect(save.comment).toBe('ok, closed on Mondays');
      expect(s.repo.queryPlaces({})).toHaveLength(0);
      expect(s.repo.trash().map((x) => x.placeId)).toEqual([P1]);
    }
    b.restoreSave(P1);
    sync(a, b);
    expect(a.repo.queryPlaces({}).map((h) => h.id)).toEqual([P1]);
  });

  it('delete while the other device restores: deletion wins', () => {
    const { a, b } = twoDevices();
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    a.deleteSave(P1);
    sync(a, b);
    a.restoreSave(P1);
    a.deleteSave(P1); // deleted again on A…
    b.restoreSave(P1); // …while B restores
    sync(a, b);
    expect(a.repo.getSave(a.saveId(P1))!.deletedAt).not.toBeNull();
    expect(b.repo.getSave(b.saveId(P1))!.deletedAt).not.toBeNull();
  });

  it('private on one device while the other shares: privacy wins', () => {
    const { a, b } = twoDevices();
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    const list = a.createList({ name: 'All', kind: 'filter' });
    sync(a, b);
    a.updateSave(P1, { sharing: 'private' });
    b.updateSave(P1, { sharing: 'friends' });
    sync(a, b);
    for (const s of [a, b]) {
      expect(s.repo.getSave(s.saveId(P1))!.sharing).toBe('private');
      expect(s.repo.listItems(list)).toEqual([]);
    }
    b.updateSave(P1, { sharing: 'friends' }); // a later, informed choice
    sync(a, b);
    expect(a.repo.listItems(list)).toEqual([a.saveId(P1)]);
  });

  it('a save made private leaves materialized lists at once', () => {
    const s = openStore();
    const list = s.createList({ name: 'All', kind: 'filter' });
    expect(s.repo.listItems(list)).toEqual([]);
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    expect(s.repo.listItems(list)).toEqual([s.saveId(P1)]);
    s.updateSave(P1, { sharing: 'private' });
    expect(s.repo.listItems(list)).toEqual([]);
    s.updateSave(P1, { sharing: 'friends' });
    s.deleteSave(P1);
    expect(s.repo.listItems(list)).toEqual([]);
  });

  it('concurrent re-parenting cycle is broken deterministically', () => {
    const { a, b } = twoDevices();
    const t1 = a.createTag({ name: 'Food' });
    const t2 = a.createTag({ name: 'Pizza' });
    sync(a, b);
    a.updateTag(t1, { parentId: t2 });
    b.updateTag(t2, { parentId: t1 });
    sync(a, b);
    const tags = a.repo.tags();
    expect(tags.find((t) => t.id === [t1, t2].sort()[0])!.parentId).toBeNull();
    expect(a.repo.dumpOwnData()).toBe(b.repo.dumpOwnData());
    expect(() => a.updateTag(tags.find((t) => t.parentId === null)!.id, { parentId: tags.find((t) => t.parentId !== null)!.id })).toThrow(/cycle/);
  });

  it('deleting a tag deactivates its sub-tags in lists; restoring brings them back', () => {
    const s = openStore();
    const food = s.createTag({ name: 'Food' });
    const pizza = s.createTag({ name: 'Pizza', parentId: food });
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), tagIds: [pizza] });
    const list = s.createList({ name: 'Food', kind: 'filter', filter: { tags: [food] } });
    expect(s.repo.listItems(list)).toEqual([s.saveId(P1)]);
    s.deleteTag(food);
    expect(s.repo.listItems(list)).toEqual([]);
    expect(s.repo.tags().find((t) => t.id === pizza)!.active).toBe(false);
    s.restoreTag(food);
    expect(s.repo.listItems(list)).toEqual([s.saveId(P1)]);
  });

  it('trash is purged after 30 days, tombstones after six months', () => {
    const clock = fakeClock();
    const s = openStore({ now: clock.now });
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    s.putSave({ place: osmPoint(2, 'Flore', 48.85, 2.33) });
    s.deleteSave(P1);
    expect(s.purgeTrash()).toBe(0);
    clock.set(clock.now() + TRASH_RETENTION_MS);
    expect(s.purgeTrash()).toBe(1);
    expect(s.repo.getSave(s.saveId(P1))).toBeNull();
    expect(s.repo.trash()).toEqual([]);
    expect(Object.keys(s.doc.tombstones)).toEqual([`save:${P1}`]);
    clock.set(clock.now() + TOMBSTONE_RETENTION_MS);
    s.purgeTrash();
    expect(Object.keys(s.doc.tombstones)).toEqual([]);
    expect(s.repo.queryPlaces({}).map((h) => h.id)).toEqual(['osm:node/2']);
  });

  it('lists: manual selection, exceptions, deletion keeps the places', () => {
    const s = openStore();
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), status: 'favorite' });
    s.putSave({ place: osmPoint(2, 'Flore', 48.85, 2.33), status: 'to_try' });
    s.putSave({ place: osmPoint(3, 'Secret', 48.85, 2.34), status: 'favorite', sharing: 'private' });
    const fav = s.createList({ name: 'Favorites', kind: 'filter', filter: { statuses: ['favorite'] }, visibility: 'public' });
    const pick = s.createList({ name: 'Pick', kind: 'manual', items: ['osm:node/2', 'osm:node/3'] });
    expect(s.repo.listItems(fav)).toEqual([s.saveId('osm:node/1')]);
    expect(s.repo.listItems(pick)).toEqual([s.saveId('osm:node/2')]);
    s.addToList(fav, 'osm:node/2');
    s.addToList(fav, 'osm:node/3'); // private: ignored
    s.removeFromList(fav, 'osm:node/1');
    expect(s.repo.listItems(fav)).toEqual([s.saveId('osm:node/2')]);
    s.setListFilter(fav, { statuses: ['favorite', 'to_try'], zones: [{ kind: 'drawn', geometry: rect(2.34, 48.8, 2.4, 48.9) }] });
    expect(s.repo.listItems(fav)).toEqual([s.saveId('osm:node/1')]);
    s.updateList(fav, { name: 'Best', description: 'My favorites' });
    expect(s.repo.getList(fav)).toMatchObject({ name: 'Best', description: 'My favorites', visibility: 'public' });
    s.deleteList(fav);
    expect(s.repo.lists().map((l) => l.id)).toEqual([pick]);
    expect(s.repo.queryPlaces({ source: 'mine' })).toHaveLength(3);
  });

  it('merging a manual point into an OSM place re-points lists and unites tags', () => {
    const s = openStore();
    const t = s.createTag({ name: 'Bakery' });
    s.putSave({ place: localPoint('manual01', 'Boulangerie Paul', 48.85, 2.35), tagIds: [t], comment: 'Croissants' });
    s.putSave({ place: osmPoint(9, 'Paul', 48.85005, 2.35), status: 'tried' });
    const list = s.createList({ name: 'Pick', kind: 'manual', items: ['local:manual01'] });
    const dup = s.repo.findDuplicateSuggestions({ id: 'local:manual01', name: 'Boulangerie Paul', lat: 48.85, lon: 2.35 });
    expect(dup.map((d) => d.id)).toEqual(['osm:node/9']);
    s.relinkSave('local:manual01', osmPoint(9, 'Paul', 48.85005, 2.35));
    const save = s.repo.getSave(s.saveId('osm:node/9'))!;
    expect(save.tagIds).toEqual([t]);
    expect(save.comment).toBe('Croissants');
    expect(save.status).toBe('tried');
    expect(s.repo.getSave(s.saveId('local:manual01'))).toBeNull();
    expect(s.repo.listItems(list)).toEqual([s.saveId('osm:node/9')]);
  });

  it('media metadata and tag mappings are projected', () => {
    const s = openStore();
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    const m = s.addMedia(P1, { file: 'photos/abc.webp', blurhash: 'LEHV6n', width: 1600, height: 1200 });
    expect(s.repo.getMedia(s.saveId(P1))).toMatchObject([{ id: m, file: 'photos/abc.webp', width: 1600 }]);
    s.removeMedia(P1, m);
    expect(s.repo.getMedia(s.saveId(P1))).toEqual([]);
    const t = s.createTag({ name: 'Pizza' });
    s.setTagMapping('ed25519:friend', 'pizzas', t);
    expect(s.repo.tagMappings()).toEqual([{ personId: 'ed25519:friend', theirTag: 'pizzas', myTagId: t }]);
    s.setTagMapping('ed25519:friend', 'pizzas', null);
    expect(s.repo.tagMappings()).toEqual([]);
  });

  it('validates edits', () => {
    const s = openStore();
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    expect(() => s.updateSave(P1, { status: 'great' as never })).toThrow(/status/);
    expect(() => s.updateSave(P1, { priceLevel: 5 as never })).toThrow(/price/);
    expect(() => s.updateSave(P1, { name: 'Renamed' })).toThrow(/OSM/);
    expect(() => s.updateSave('osm:node/404', { status: 'tried' })).toThrow(/no save/);
    expect(() => s.putSave({ place: { name: 'x', geometry: { type: 'Point', coordinates: [0, 0] } } })).toThrow(/local:/);
    // A failed edit changes nothing.
    expect(s.repo.getSave(s.saveId(P1))!.status).toBeNull();
    s.putSave({ place: localPoint('m0000001', 'Spot', 1, 1) });
    s.updateSave('local:m0000001', { name: 'Better spot', geometry: { type: 'Point', coordinates: [1.001, 1] } });
    expect(s.repo.getPlace('local:m0000001')).toMatchObject({ name: 'Better spot', lon: 1.001 });
  });
});

describe('persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triangulair-data-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reopens from SQLite with the same document and projection; compacts', () => {
    const file = join(dir, 'a.db');
    const s = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(7), compactEvery: 5 });
    const t = s.createTag({ name: 'Pizza' });
    for (let i = 1; i <= 8; i++) s.putSave({ place: osmPoint(i, `Place ${i}`, 48 + i / 100, 2), tagIds: [t] });
    const heads = A.getHeads(s.doc);
    const dump = s.repo.dumpOwnData();
    s.close();
    const r = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(7) });
    expect(r.docLoaded).toBe(false); // the projection is current: reads need no document
    expect(r.repo.queryPlaces({ source: 'mine' })).toHaveLength(8);
    expect(A.getHeads(r.doc).sort()).toEqual([...heads].sort());
    expect(r.repo.dumpOwnData()).toBe(dump);
    expect(r.repo.db.get<{ n: number }>(`SELECT count(*) AS n FROM doc_chunks`)!.n).toBeLessThan(6);
    r.close();
  });

  it('catches up a stale projection on open', () => {
    const file = join(dir, 'b.db');
    const s = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(8) });
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    const dump = s.repo.dumpOwnData();
    // Simulate a projection lost or corrupted after the document was stored.
    s.repo.db.run(`DELETE FROM saves`);
    s.repo.db.run(`DELETE FROM meta WHERE key = 'projected_heads'`);
    s.close();
    const r = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(8) });
    expect(r.repo.dumpOwnData()).toBe(dump);
    r.close();
  });

  it('incremental exchange between devices (exportDoc since heads)', () => {
    const { a, b } = twoDevices();
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    b.importChanges(a.exportDoc());
    const seen = b.heads();
    a.updateSave(P1, { comment: 'again' });
    const delta = a.exportDoc(seen);
    expect(delta.byteLength).toBeLessThan(a.exportDoc().byteLength);
    b.importChanges(delta);
    expect(b.repo.getSave(b.saveId(P1))!.comment).toBe('again');
    expect(b.repo.dumpOwnData()).toBe(a.repo.dumpOwnData());
  });

  it('readTags ignores unknown parents', () => {
    const doc = A.change(createDataDoc(), (d) => {
      const tx = new DocTx(d, { now: () => 1, newId: seqIds('t') });
      const id = tx.createTag({ name: 'x' });
      d.tags[id]!.parentId = new A.ImmutableString('ghost');
    });
    expect(readTags(doc, ME)[0]!.parentId).toBeNull();
    expect(saveIdFor(ME, P1)).toBe(`${ME}|${P1}`);
  });
});
