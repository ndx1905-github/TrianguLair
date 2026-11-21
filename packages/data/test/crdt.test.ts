import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createDataDoc,
  DocTx,
  mergeDataDocs,
  hasSave,
  loadDataDoc,
  readTombstones,
  roots,
  saveEntry,
  saveEntryKeys,
  savePlaceIds,
  tagIdsOf,
  TOMBSTONE_RETENTION_MS,
  TRASH_RETENTION_MS,
} from '../src/crdt/doc.ts';
import { readTags } from '../src/crdt/project.ts';
import { NodeSqliteDriver } from '../src/driver/node.ts';
import { saveIdFor } from '../src/ids.ts';
import { DataStore } from '../src/store.ts';
import { clientIdFor } from '../src/crdt/doc.ts';
import { fakeClock, hexActor, localPoint, ME, osmPoint, rect, seqIds } from './helpers.ts';
import { openStore } from './stores.ts';

/** Two devices of the same person (`swap`: exchange their Yjs client ids, which break LWW ties). */
function twoDevices(swap = false) {
  const a = openStore({ actor: hexActor(swap ? 2 : 1), newId: seqIds('a-') });
  const b = openStore({ actor: hexActor(swap ? 1 : 2), newId: seqIds('b-') });
  return { a, b };
}

/** Same document version: same state vector and same deletions. */
function sameVersion(x: DataStore, y: DataStore): boolean {
  return Y.equalSnapshots(Y.snapshot(x.doc), Y.snapshot(y.doc));
}

/** Full exchange until both hold the same document. */
function sync(...stores: DataStore[]): void {
  for (let round = 0; round < 3; round++) {
    for (const x of stores) for (const y of stores) if (x !== y) x.merge(y.doc);
  }
}

const P1 = 'osm:node/1';

describe('Yjs document', () => {
  it('two devices that never met share the root maps (named roots, deterministic base update)', () => {
    const d1 = createDataDoc(hexActor(1));
    const d2 = createDataDoc(hexActor(2));
    // The only initial write comes from the same base update: identical bytes, nothing to conflict.
    expect(Y.encodeStateAsUpdate(d1)).toEqual(Y.encodeStateAsUpdate(d2));
    expect([...Y.decodeStateVector(Y.encodeStateVector(d1)).keys()]).toEqual([0]);
    d1.transact(() => new DocTx(d1).putSave({ place: osmPoint(1, 'A', 1, 1) }));
    d2.transact(() => new DocTx(d2).putSave({ place: osmPoint(2, 'B', 2, 2) }));
    const m = mergeDataDocs(d1, d2);
    expect(savePlaceIds(m)).toEqual(['osm:node/1', 'osm:node/2']);
    expect(roots(m).meta.get('schema')).toBe(1);
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
    expect(sameVersion(a, b)).toBe(true);
    expect(a.heads()).toEqual(b.heads());
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

  // Yjs maps are last-writer-wins (ties by client id); these rules are
  // implemented with per-device slots, so they must hold for both orders.
  describe.each([{ swap: false }, { swap: true }])('whichever device has the larger client id (swap: $swap)', ({ swap }) => {
    it('delete while the other device restores: deletion wins', () => {
      const { a, b } = twoDevices(swap);
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
      const { a, b } = twoDevices(swap);
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

    it('a deletion wins over a restore that did not see it, even after a delete/restore on the restoring device', () => {
      const { a, b } = twoDevices(swap);
      a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
      sync(a, b);
      a.deleteSave(P1);
      b.deleteSave(P1);
      b.restoreSave(P1); // B restores only its own deletion
      sync(a, b);
      for (const s of [a, b]) expect(s.repo.getSave(s.saveId(P1))!.deletedAt).not.toBeNull();
      a.restoreSave(P1); // an informed restore
      sync(a, b);
      for (const s of [a, b]) expect(s.repo.getSave(s.saveId(P1))!.deletedAt).toBeNull();
    });

    it('deletion wins for tags and lists too', () => {
      const { a, b } = twoDevices(swap);
      const t = a.createTag({ name: 'Pizza' });
      const l = a.createList({ name: 'L', kind: 'manual' });
      a.deleteTag(t);
      a.deleteList(l);
      sync(a, b);
      a.restoreTag(t);
      a.deleteTag(t);
      b.restoreTag(t);
      b.restoreList(l);
      a.restoreList(l);
      a.deleteList(l);
      sync(a, b);
      for (const s of [a, b]) {
        expect(s.repo.tags().find((x) => x.id === t)!.deletedAt).not.toBeNull();
        expect(s.repo.lists().map((x) => x.id)).toEqual([]);
      }
    });

    it('privacy wins over a "friends" that did not see it, even after a private/friends on that device', () => {
      const { a, b } = twoDevices(swap);
      a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
      sync(a, b);
      a.updateSave(P1, { sharing: 'private' });
      b.updateSave(P1, { sharing: 'private' });
      b.updateSave(P1, { sharing: 'friends' });
      sync(a, b);
      for (const s of [a, b]) expect(s.repo.getSave(s.saveId(P1))!.sharing).toBe('private');
    });

    it('concurrent edits of a plain field converge (last writer wins, same value everywhere)', () => {
      const { a, b } = twoDevices(swap);
      a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
      sync(a, b);
      a.updateSave(P1, { status: 'tried' });
      b.updateSave(P1, { status: 'favorite' });
      sync(a, b);
      expect(a.repo.getSave(a.saveId(P1))!.status).toBe(b.repo.getSave(b.saveId(P1))!.status);
      expect(a.repo.dumpOwnData()).toBe(b.repo.dumpOwnData());
    });
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
    expect(Object.keys(readTombstones(s.doc))).toEqual([`save:${P1}`]);
    clock.set(clock.now() + TOMBSTONE_RETENTION_MS);
    s.purgeTrash();
    expect(Object.keys(readTombstones(s.doc))).toEqual([]);
    expect(s.repo.queryPlaces({}).map((h) => h.id)).toEqual(['osm:node/2']);
  });

  it('"delete forever": one item of the trash is purged now, the others wait', () => {
    const clock = fakeClock();
    const s = openStore({ now: clock.now });
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    s.putSave({ place: osmPoint(2, 'Flore', 48.85, 2.33) });
    s.putSave({ place: osmPoint(3, 'Kept', 48.85, 2.34) });
    const tag = s.createTag({ name: 'Old' });
    const list = s.createList({ name: 'Gone', kind: 'manual' });
    s.deleteSave(P1);
    s.deleteSave('osm:node/2');
    s.deleteTag(tag);
    s.deleteList(list);
    // Not in the trash: nothing happens.
    expect(s.purgeTrash({ kind: 'save', id: 'osm:node/3' })).toBe(0);
    expect(s.purgeTrash({ kind: 'save', id: P1 })).toBe(1);
    expect(s.repo.trash().map((r) => r.placeId)).toEqual(['osm:node/2']);
    expect(s.purgeTrash({ kind: 'tag', id: tag })).toBe(1);
    expect(s.repo.tags().map((t) => t.id)).not.toContain(tag);
    expect(s.purgeTrash({ kind: 'list', id: list })).toBe(1);
    expect(s.repo.lists({ includeDeleted: true })).toEqual([]);
    expect(Object.keys(readTombstones(s.doc)).sort()).toEqual([`list:${list}`, `save:${P1}`, `tag:${tag}`]);
    expect(s.repo.queryPlaces({}).map((h) => h.id)).toEqual(['osm:node/3']);
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

  it('photos: thumbnail, format, size and upload record; a removal wins over a concurrent upload record', () => {
    const a = openStore({ actor: hexActor(1), newId: seqIds('a-') });
    const b = openStore({ actor: hexActor(2), newId: seqIds('b-') });
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    const m = a.addMedia(P1, { file: 'b2b256:full', thumb: 'b2b256:thumb', mime: 'image/webp', bytes: 1234, width: 1600, height: 1200 });
    const before = a.repo.getSave(a.saveId(P1))!.updatedAt;
    a.setMediaUpload(P1, m, { key: 'k', full: 'b2b256:ef', thumb: 'b2b256:et', fp: 'b2b256:fp' });
    expect(a.repo.getSave(a.saveId(P1))!.updatedAt).toBe(before); // not an edit
    expect(a.repo.getMedia(a.saveId(P1))).toMatchObject([
      { id: m, file: 'b2b256:full', thumb: 'b2b256:thumb', mime: 'image/webp', bytes: 1234, upload: { key: 'k', full: 'b2b256:ef', thumb: 'b2b256:et', fp: 'b2b256:fp' } },
    ]);
    expect(a.repo.mediaForPlace(P1)).toMatchObject([{ id: m, mine: true }]);
    expect(a.repo.mediaById(m)).toMatchObject({ placeId: P1, mine: true });
    b.merge(a.doc);
    expect(b.repo.getMedia(b.saveId(P1))[0]!.upload).toMatchObject({ key: 'k' });
    // B removes the photo while A records a new upload: the photo stays removed.
    b.removeMedia(P1, m);
    a.setMediaUpload(P1, m, { key: 'k2', full: 'b2b256:ef2', thumb: 'b2b256:et2', fp: 'b2b256:fp' });
    a.merge(b.doc);
    b.merge(a.doc);
    expect(a.repo.getMedia(a.saveId(P1))).toEqual([]);
    expect(b.repo.getMedia(b.saveId(P1))).toEqual([]);
    a.setMediaUpload(P1, m, null); // no-op on a removed photo
  });

  it("a friend's photos are cached with their key and leave with the save", () => {
    const s = openStore();
    s.repo.upsertForeignSave({ id: 'f1', ownerId: 'ed25519:friend', place: { id: 'osm:node/7', osmType: 'node', osmId: 7, name: 'X', category: null, kind: 'place', edge: 'sharp', geometry: { type: 'Point', coordinates: [2.35, 48.85] } }, createdAt: 1, updatedAt: 1 });
    s.repo.setForeignMedia('f1', [{ id: 'p1', file: 'b2b256:ef', thumb: 'b2b256:et', mime: 'image/webp', bytes: 10, upload: { key: 'k', full: 'b2b256:ef', thumb: 'b2b256:et' }, blurhash: null, width: 4, height: 3, createdAt: 5 }]);
    expect(s.repo.mediaForPlace('osm:node/7')).toMatchObject([{ id: 'p1', ownerId: 'ed25519:friend', mine: false, upload: { key: 'k' } }]);
    expect(() => s.repo.setForeignMedia('nope', [])).toThrow();
    s.repo.deleteForeignSave('f1');
    expect(s.repo.db.all(`SELECT * FROM media`)).toEqual([]);
  });

  it('three devices save the same place offline: folds chain without losing anyone', () => {
    const a = openStore({ actor: hexActor(1), newId: seqIds('a-') });
    const b = openStore({ actor: hexActor(2), newId: seqIds('b-') });
    const c = openStore({ actor: hexActor(3), newId: seqIds('c-') });
    const tags = [a, b, c].map((s, i) => s.createTag({ name: `tag ${i}` }));
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), tagIds: [tags[0]!], comment: 'from a' });
    b.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), tagIds: [tags[1]!], comment: 'from b', sharing: 'private' });
    c.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), tagIds: [tags[2]!], comment: 'from c', status: 'tried' });
    a.merge(b.doc); // A folds {A, B}
    c.merge(b.doc); // C folds {B, C}, concurrently
    sync(a, b, c);
    for (const s of [a, b, c]) {
      const save = s.repo.getSave(s.saveId(P1))!;
      expect(new Set(save.tagIds)).toEqual(new Set(tags));
      for (const x of ['a', 'b', 'c']) expect(save.comment.split(`from ${x}`)).toHaveLength(2); // each exactly once
      expect(save.sharing).toBe('private');
      expect(save.status).toBe('tried');
      expect(s.repo.queryPlaces({})).toHaveLength(1);
    }
    expect(a.repo.dumpOwnData()).toBe(b.repo.dumpOwnData());
    expect(a.repo.dumpOwnData()).toBe(c.repo.dumpOwnData());
  });

  it('two devices healing the same duplicate at once do not duplicate the comment', () => {
    const { a, b } = twoDevices();
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), comment: 'terrace' });
    b.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), comment: 'closed mondays' });
    const fromA = a.exportDoc();
    const fromB = b.exportDoc();
    a.importChanges(fromB); // both heal before seeing the other's heal
    b.importChanges(fromA);
    sync(a, b);
    const comment = a.repo.getSave(a.saveId(P1))!.comment;
    expect(comment.split('terrace')).toHaveLength(2);
    expect(comment.split('closed mondays')).toHaveLength(2);
    expect(a.repo.dumpOwnData()).toBe(b.repo.dumpOwnData());
    expect(saveEntryKeys(a.doc, P1)).toHaveLength(2); // both entries kept, one canonical
  });

  it('a change that throws leaves the document and the database unchanged', () => {
    const s = openStore({ actor: hexActor(5) });
    s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    const dump = s.repo.dumpOwnData();
    const heads = s.heads();
    expect(() =>
      s.change((tx) => {
        tx.createTag({ name: 'half' });
        tx.updateSave(P1, { comment: 'half-written' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.docLoaded).toBe(false); // dropped, reloaded from SQLite on next use
    expect(tagIdsOf(s.doc)).toEqual([]);
    expect(s.heads()).toEqual(heads);
    expect(s.repo.dumpOwnData()).toBe(dump);
    s.updateSave(P1, { comment: 'ok' });
    expect(s.repo.getSave(s.saveId(P1))!.comment).toBe('ok');
    const other = openStore({ actor: hexActor(6) });
    other.merge(s.exportDoc());
    expect(other.repo.dumpOwnData()).toBe(s.repo.dumpOwnData());
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
    const heads = s.heads();
    const dump = s.repo.dumpOwnData();
    s.close();
    const r = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(7) });
    expect(r.docLoaded).toBe(false); // the projection is current: reads need no document
    expect(r.repo.queryPlaces({ source: 'mine' })).toHaveLength(8);
    expect(r.heads()).toEqual(heads);
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

  it('reuses the device actor as Yjs client id across sessions', () => {
    const file = join(dir, 'actor.db');
    const open = () => DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: 'device-1', compactEvery: 3 });
    for (let i = 1; i <= 4; i++) {
      const s = open();
      s.putSave({ place: osmPoint(i, `Place ${i}`, 48, 2) });
      expect(s.doc.clientID).toBe(clientIdFor('device-1'));
      s.close();
    }
    const s = open();
    // Only the base update's client and this device: loading its own updates did not make Yjs pick a new id.
    expect([...Y.decodeStateVector(s.heads()).keys()].sort()).toEqual([0, clientIdFor('device-1')].sort());
    expect(savePlaceIds(s.doc)).toHaveLength(4);
    s.close();
  });

  it('refuses a database whose document is not stored as Yjs updates', () => {
    const file = join(dir, 'old.db');
    DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME }).close();
    const db = new NodeSqliteDriver(file);
    db.run(`DELETE FROM meta WHERE key = 'doc_format'`);
    db.close();
    expect(() => DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME })).toThrow(/stored as an older format/);
  });

  it('keeps an out-of-order update until its dependencies arrive, across a reopen', () => {
    const a = openStore({ actor: hexActor(1) });
    const file = join(dir, 'pending.db');
    const b = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(2) });
    const base = b.heads();
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    const first = a.exportDoc(base);
    const mid = a.heads();
    a.updateSave(P1, { comment: 'second' });
    const second = a.exportDoc(mid);
    b.importChanges(second); // depends on `first`, not received yet
    expect(b.repo.getSave(b.saveId(P1))).toBeNull();
    b.close();
    const b2 = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(2) });
    b2.importChanges(first);
    expect(b2.repo.getSave(b2.saveId(P1))!.comment).toBe('second');
    expect(b2.repo.dumpOwnData()).toBe(a.repo.dumpOwnData());
    b2.close();
  });

  it('keeps fields written by a newer version through edits, merges, folding, relinking and compaction (spec "Format versions")', () => {
    const file = join(dir, 'unknown.db');
    const a = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(1), newId: seqIds('a-') });
    const tag = a.createTag({ name: 'Pizza' });
    a.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35) });
    a.putSave({ place: localPoint('manual01', 'Spot', 48.85, 2.35) });
    const list = a.createList({ name: 'L', kind: 'filter' });
    // A newer app version, on another device, writes fields this version does not know.
    const newer = loadDataDoc(a.exportDoc(), hexActor(9));
    const seen = a.heads();
    newer.transact(() => {
      const r = roots(newer);
      const e = saveEntry(newer, P1)!;
      e.set('rating', 4.5);
      const review = new Y.Map<unknown>();
      e.set('review', review);
      review.set('text', new Y.Text('great dough'));
      saveEntry(newer, 'local:manual01')!.set('visitedAt', 1234);
      r.tags.get(tag)!.set('emoji', 'pizza');
      (r.lists.get(list)!.get('filter') as Y.Map<unknown>).set('openNow', true);
      r.meta.set('minor', 3);
      newer.getMap('visits').set('2026-10-01', P1);
    });
    a.importChanges(Y.encodeStateAsUpdate(newer, seen));
    // This version edits the same items…
    a.updateSave(P1, { comment: 'edited', sharing: 'private', status: 'tried' });
    a.addSaveTag(P1, tag);
    a.updateTag(tag, { name: 'Pizzas', color: '#f00' });
    a.setListFilter(list, { statuses: ['tried'] });
    a.relinkSave('local:manual01', osmPoint(2, 'Spot', 48.85, 2.35));
    // …another device saved the same place offline (folded on merge)…
    const c = openStore({ actor: hexActor(3), newId: seqIds('c-') });
    c.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), comment: 'from c' });
    a.merge(c.doc);
    a.compact();
    a.close();
    // …and after a reopen, what goes back to the newer device still carries its fields.
    const r = DataStore.open({ driver: new NodeSqliteDriver(file), meId: ME, actor: hexActor(1) });
    const back = loadDataDoc(r.exportDoc());
    const e = saveEntry(back, P1)!;
    expect(e.get('rating')).toBe(4.5);
    expect(((e.get('review') as Y.Map<unknown>).get('text') as Y.Text).toString()).toBe('great dough');
    expect(saveEntry(back, 'osm:node/2')!.get('visitedAt')).toBe(1234);
    expect(hasSave(back, 'local:manual01')).toBe(false);
    expect(roots(back).tags.get(tag)!.get('emoji')).toBe('pizza');
    expect((roots(back).lists.get(list)!.get('filter') as Y.Map<unknown>).get('openNow')).toBe(true);
    expect(roots(back).meta.get('minor')).toBe(3);
    expect(back.getMap('visits').get('2026-10-01')).toBe(P1);
    expect(r.repo.getSave(r.saveId(P1))).toMatchObject({ sharing: 'private', status: 'tried' });
    expect(r.repo.getSave(r.saveId(P1))!.comment).toContain('edited');
    r.close();
  });

  it('readTags ignores unknown parents', () => {
    const doc = createDataDoc();
    doc.transact(() => {
      const tx = new DocTx(doc, { now: () => 1, newId: seqIds('t') });
      const id = tx.createTag({ name: 'x' });
      roots(doc).tags.get(id)!.set('parentId', 'ghost');
    });
    expect(readTags(doc, ME)[0]!.parentId).toBeNull();
    expect(saveIdFor(ME, P1)).toBe(`${ME}|${P1}`);
  });
});
