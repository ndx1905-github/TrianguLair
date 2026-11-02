// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '../src/driver/node.ts';
import { databaseOwner, reassignOwner } from '../src/owner.ts';
import { FRIEND, osmPoint } from './helpers.ts';
import { openStore } from './stores.ts';

const OLD = 'local-me';
const NEW = 'ed25519:new-owner';

function seeded() {
  const driver = new NodeSqliteDriver(':memory:');
  const store = openStore({ driver, meId: OLD });
  const food = store.createTag({ name: 'Food' });
  const p1 = store.putSave({ place: osmPoint(1, 'Pizzeria', 48.85, 2.35), tagIds: [food], comment: 'Crispy', status: 'favorite' });
  const p2 = store.putSave({ place: osmPoint(2, 'Bistro', 48.86, 2.36), sharing: 'private' });
  store.addMedia(p1, { file: 'photos/a.webp', width: 10, height: 10 });
  const manual = store.createList({ name: 'Mine', kind: 'manual', items: [p1] });
  const filter = store.createList({ name: 'Food', kind: 'filter', filter: { tags: [food] } });
  store.repo.upsertPerson({ id: OLD, displayName: 'Me' });
  store.repo.upsertForeignSave({
    id: 'friend-save',
    ownerId: FRIEND,
    place: { id: p1, osmType: 'node', osmId: 1, name: 'Pizzeria', category: 'amenity=restaurant', kind: 'place', edge: 'sharp', geometry: { type: 'Point', coordinates: [2.35, 48.85] } },
    theirTags: ['Pizza'],
    createdAt: 1,
    updatedAt: 1,
  });
  store.setTagMapping(FRIEND, 'Pizza', food);
  expect(store.repo.listItems(manual)).toEqual([`${OLD}|${p1}`]);
  return { driver, food, p1, p2, manual, filter, before: store.repo.dumpOwnData() };
}

describe('reassignOwner', () => {
  it('moves my saves, tags, lists, media and profile to the new owner, keeping friends', () => {
    const { driver, food, p1, p2, manual, filter } = seeded();
    expect(databaseOwner(driver)).toBe(OLD);
    expect(reassignOwner(driver, OLD, NEW)).toEqual({ migrated: true, saves: 2 });
    // The old id is gone everywhere.
    for (const [table, col] of [['saves', 'owner_id'], ['tags', 'owner_id'], ['lists', 'owner_id'], ['people', 'id']] as const) {
      expect(driver.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`, [OLD])!.n, table).toBe(0);
    }

    const store = openStore({ driver, meId: NEW });
    const repo = store.repo;
    expect(databaseOwner(driver)).toBe(NEW);
    expect(repo.getPerson(NEW)).toMatchObject({ displayName: 'Me', isMe: true });
    const s1 = repo.getMySaveForPlace(p1)!;
    expect(s1).toMatchObject({ id: `${NEW}|${p1}`, ownerId: NEW, comment: 'Crispy', status: 'favorite', tagIds: [food] });
    expect(repo.getMySaveForPlace(p2)).toMatchObject({ ownerId: NEW, sharing: 'private' });
    expect(repo.getMedia(s1.id)).toHaveLength(1);
    expect(repo.tags().map((t) => [t.id, t.ownerId])).toEqual([[food, NEW]]);
    expect(repo.listItems(manual)).toEqual([`${NEW}|${p1}`]);
    expect(repo.listItems(filter)).toEqual([`${NEW}|${p1}`]);
    expect(repo.listsContaining(`${NEW}|${p1}`).sort()).toEqual([filter, manual].sort());
    // Friends' data and mappings are untouched.
    expect(repo.getSave('friend-save')).toMatchObject({ ownerId: FRIEND });
    expect(repo.tagMappings()).toEqual([{ personId: FRIEND, theirTag: 'Pizza', myTagId: food }]);
    // Text search sees my comment and tag again.
    expect(repo.search('crispy').map((h) => h.id)).toEqual([p1]);
    // Further edits work under the new owner.
    store.updateSave(p2, { comment: 'Later' });
    expect(repo.getMySaveForPlace(p2)!.comment).toBe('Later');
  });

  it('keeps the same document content (only the owner changes)', () => {
    const { driver, before } = seeded();
    reassignOwner(driver, OLD, NEW);
    const after = openStore({ driver, meId: NEW }).repo.dumpOwnData();
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v).split(OLD).join('<me>').split(NEW).join('<me>'));
    expect(strip(after)).toEqual(strip(before));
  });

  it('does nothing on a new database or one already moved, refuses a third identity', () => {
    const fresh = new NodeSqliteDriver(':memory:');
    expect(databaseOwner(fresh)).toBeNull();
    expect(reassignOwner(fresh, OLD, NEW)).toEqual({ migrated: false, saves: 0 });

    const { driver } = seeded();
    reassignOwner(driver, OLD, NEW);
    openStore({ driver, meId: NEW });
    expect(reassignOwner(driver, OLD, NEW)).toEqual({ migrated: false, saves: 0 });
    expect(() => reassignOwner(driver, OLD, 'ed25519:third')).toThrow(/belongs to ed25519:new-owner/);
    expect(() => reassignOwner(driver, NEW, NEW)).toThrow(/same id/);
  });

  it('refuses to turn a friend into me', () => {
    const { driver } = seeded();
    expect(() => reassignOwner(driver, OLD, FRIEND)).toThrow(/already a person/);
    expect(databaseOwner(driver)).toBe(OLD);
  });
});
