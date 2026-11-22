// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { normalizeSnapshot } from '../src/place.ts';
import { FRIEND, localPoint, osmPoint } from './helpers.ts';
import { openStore } from './stores.ts';

function chunks(s: ReturnType<typeof openStore>): number {
  return s.repo.db.get<{ n: number }>(`SELECT count(*) AS n FROM doc_chunks`)!.n;
}

function withFriend() {
  const s = openStore();
  const tag = s.createTag({ name: 'Pizza' });
  s.putSave({ place: osmPoint(1, 'Napoli', 48.85, 2.35), tagIds: [tag], status: 'to_try' });
  s.putSave({ place: osmPoint(2, 'Flore', 48.85, 2.33) });
  s.putSave({ place: localPoint('threeabc', 'Three', 48.86, 2.34), status: 'favorite' });
  // Only my friend saves this one (it is in my local cache, not in my document).
  s.repo.upsertForeignSave({
    id: 'f1',
    ownerId: FRIEND,
    place: normalizeSnapshot(osmPoint(9, 'Their bar', 48.86, 2.38, 'amenity=bar')),
    theirTags: ['Bar'],
    createdAt: 1,
    updatedAt: 1,
  });
  return { s, tag, ids: ['osm:node/1', 'osm:node/2', 'local:threeabc', 'osm:node/9'] };
}

describe('bulkEdit (the list\'s "Select" mode)', () => {
  it('to the trash in one change; friends\' places are skipped; restore brings them all back', () => {
    const { s, ids } = withFriend();
    const before = chunks(s);
    const r = s.bulkEdit(ids, { kind: 'delete' });
    expect(r.changed).toEqual(['osm:node/1', 'osm:node/2', 'local:threeabc']);
    expect(r.skipped).toEqual(['osm:node/9']);
    expect(chunks(s)).toBe(before + 1);
    expect(s.repo.trash().map((t) => t.placeId).sort()).toEqual(['local:threeabc', 'osm:node/1', 'osm:node/2']);
    expect(s.repo.queryPlaces({ source: 'mine', limit: 10 })).toEqual([]);
    // The friend's place is untouched.
    expect(s.repo.queryPlaces({ source: 'friends', limit: 10 }).map((h) => h.id)).toEqual(['osm:node/9']);

    // Already in the trash: skipped by a second delete, and by tag or status edits.
    expect(s.bulkEdit(ids, { kind: 'delete' }).changed).toEqual([]);
    expect(s.bulkEdit(ids, { kind: 'status', status: 'tried' }).changed).toEqual([]);

    const back = s.bulkEdit(r.changed, { kind: 'restore' });
    expect(back.changed).toHaveLength(3);
    expect(s.repo.trash()).toEqual([]);
    expect(s.repo.queryPlaces({ source: 'mine', limit: 10 })).toHaveLength(3);
  });

  it('adds and removes a tag, sets a status; what is already so is left untouched', () => {
    const { s, tag, ids } = withFriend();
    const add = s.bulkEdit(ids, { kind: 'addTag', tagId: tag });
    expect(add.changed).toEqual(['osm:node/2', 'local:threeabc']);
    expect(add.unchanged).toEqual(['osm:node/1']);
    expect(add.skipped).toEqual(['osm:node/9']);
    for (const id of ids.slice(0, 3)) expect(s.repo.getMySaveForPlace(id)!.tagIds).toEqual([tag]);
    // The tag becomes the main one of a place that had none.
    expect(s.repo.getMySaveForPlace('osm:node/2')!.mainTagId).toBe(tag);

    const rm = s.bulkEdit(['osm:node/1', 'osm:node/2'], { kind: 'removeTag', tagId: tag });
    expect(rm.changed).toEqual(['osm:node/1', 'osm:node/2']);
    expect(s.repo.getMySaveForPlace('osm:node/1')!.tagIds).toEqual([]);
    expect(s.repo.getMySaveForPlace('osm:node/1')!.mainTagId).toBeNull();

    const st = s.bulkEdit(ids, { kind: 'status', status: 'favorite' });
    expect(st.changed).toEqual(['osm:node/1', 'osm:node/2']);
    expect(st.unchanged).toEqual(['local:threeabc']);
    expect(ids.slice(0, 3).map((id) => s.repo.getMySaveForPlace(id)!.status)).toEqual(['favorite', 'favorite', 'favorite']);
    s.bulkEdit(ids, { kind: 'status', status: null });
    expect(s.repo.getMySaveForPlace('local:threeabc')!.status).toBeNull();

    // Nothing to do: no chunk written.
    const before = chunks(s);
    expect(s.bulkEdit(ids, { kind: 'status', status: null }).changed).toEqual([]);
    expect(chunks(s)).toBe(before);
  });

  it('adds to a manual list; a friend\'s place is not added', () => {
    const { s, ids } = withFriend();
    const list = s.createList({ name: 'Weekend', kind: 'manual' });
    const r = s.bulkEdit(ids, { kind: 'addToList', listId: list });
    expect(r.skipped).toEqual(['osm:node/9']);
    expect(s.repo.listItems(list).sort()).toEqual(['osm:node/1', 'osm:node/2', 'local:threeabc'].map((id) => s.saveId(id)).sort());
  });

  it('merges on another device like single edits', () => {
    const { s, ids } = withFriend();
    const other = openStore({ actor: 'device-b' });
    other.merge(s.exportDoc());
    s.bulkEdit(ids, { kind: 'delete' });
    other.merge(s.exportDoc(other.heads()));
    expect(other.repo.trash()).toHaveLength(3);
  });

  it('thousands of places: one change, quickly', () => {
    const s = openStore();
    const n = 3000;
    const tag = s.createTag({ name: 'Bulk' });
    s.change((tx) => {
      for (let i = 0; i < n; i++) tx.putSave({ place: osmPoint(1000 + i, `P${i}`, 48 + i / 10_000, 2 + i / 10_000) });
    });
    const ids = Array.from({ length: n }, (_, i) => `osm:node/${1000 + i}`);
    const before = chunks(s);
    const t0 = Date.now();
    expect(s.bulkEdit(ids, { kind: 'addTag', tagId: tag }).changed).toHaveLength(n);
    expect(s.bulkEdit(ids, { kind: 'delete' }).changed).toHaveLength(n);
    const ms = Date.now() - t0;
    expect(chunks(s)).toBe(before + 2);
    expect(s.repo.trash()).toHaveLength(n);
    expect(ms).toBeLessThan(20_000);
  }, 60_000);
});
