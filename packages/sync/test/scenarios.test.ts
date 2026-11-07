// SPDX-License-Identifier: MPL-2.0
/** Headless multi-user simulations on the in-memory storage adapter (spec "Testing strategy": synchronization). */
import { describe, expect, it } from 'vitest';
import { addDevice, befriend, friendSaves, makeUser, point, World } from './helpers.ts';

describe('owner publishes, friend reads', () => {
  it('shares friends places, never private ones, with comments by visibility', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    const s = alice.store;
    s.putSave({ place: point(1, 'Chez Lili'), comment: 'Great pizza', status: 'favorite' });
    s.putSave({ place: point(2, 'Secret spot'), sharing: 'private', comment: 'home' });
    s.putSave({ place: point(3, 'Bistro'), comment: 'only me', commentVisibility: 'private' });
    const tag = s.createTag({ name: 'Pizza', color: '#EF4444', icon: 'pizza' });
    s.addSaveTag('osm:node/1', tag);
    expect((await alice.engine.sync()).ok).toBe(true);
    expect((await bob.engine.sync()).ok).toBe(true);
    await befriend(w, alice, bob);
    await alice.engine.sync();

    const r = await bob.engine.sync();
    expect(r.ok).toBe(true);
    const f = r.friends.find((x) => x.owner === alice.user.owner)!;
    expect(f.status).toBe('updated');
    expect(f.whatsNew.added.sort()).toEqual(['osm:node/1', 'osm:node/3']);
    const saves = friendSaves(bob, alice.user.owner);
    expect([...saves.keys()]).toEqual(['osm:node/1', 'osm:node/3']);
    expect(saves.get('osm:node/1')).toEqual({ comment: 'Great pizza', status: 'favorite' });
    expect(saves.get('osm:node/3')!.comment).toBe(''); // private comment not shared
    expect(bob.store.repo.friendTags()).toMatchObject([{ name: 'Pizza', color: '#EF4444', icon: 'pizza' }]);
    // The private place's name never reached Bob's database at all.
    expect(bob.store.repo.getPlace('osm:node/2')).toBeNull();
    // Single pin, "1 friend".
    const hits = bob.store.repo.queryPlaces({ source: 'friends' });
    expect(hits.find((h) => h.id === 'osm:node/1')!.friendsCount).toBe(1);

    // Nothing changed: one HEAD, no pack download.
    const again = await bob.engine.sync();
    expect(again.friends[0]!.status).toBe('unchanged');
  });

  it('owner edits, friend sees what changed (meaningful or not), deletion removes', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    for (let i = 1; i <= 30; i++) alice.store.putSave({ place: point(i, `Place ${i}`) });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    await bob.engine.sync();
    expect(friendSaves(bob, alice.user.owner).size).toBe(30);

    alice.store.updateSave('osm:node/5', { status: 'tried' });
    alice.store.updateSave('osm:node/6', { comment: 'New comment' });
    alice.store.updateSave('osm:node/7', { priceLevel: 2 });
    alice.store.deleteSave('osm:node/8'); // trash: disappears at friends'
    alice.store.updateSave('osm:node/9', { sharing: 'private' });
    alice.store.putSave({ place: point(31, 'New one') });
    await alice.engine.sync();
    const r = await bob.engine.sync();
    const wn = r.friends[0]!.whatsNew;
    expect(wn.added).toEqual(['osm:node/31']);
    expect(wn.removed.sort()).toEqual(['osm:node/8', 'osm:node/9']);
    const ch = Object.fromEntries(wn.changed.map((c) => [c.placeId, c]));
    expect(ch['osm:node/5']).toMatchObject({ meaningful: true, fields: ['status'] });
    expect(ch['osm:node/6']).toMatchObject({ meaningful: true, fields: ['comment'] });
    expect(ch['osm:node/7']).toMatchObject({ meaningful: false, fields: ['price_level'] });
    const saves = friendSaves(bob, alice.user.owner);
    expect(saves.size).toBe(29);
    expect(saves.get('osm:node/6')!.comment).toBe('New comment');
    expect(bob.store.repo.getPlace('osm:node/9')).toBeNull(); // pruned: its data came from Alice
  });

  it('revocation removes the content from the friend\'s cache and deletes the old packs', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    const carol = addDevice(w, makeUser(w, 'carol'));
    for (let i = 1; i <= 10; i++) alice.store.putSave({ place: point(i, `P${i}`) });
    await Promise.all([alice.engine.sync(), bob.engine.sync(), carol.engine.sync()]);
    await befriend(w, alice, bob);
    await befriend(w, alice, carol);
    await alice.engine.sync();
    await bob.engine.sync();
    await carol.engine.sync();
    expect(friendSaves(bob, alice.user.owner).size).toBe(10);
    const oldFiles = (await w.readAdapter(alice.user.location).list('')).map((e) => e.path).filter((p) => p.startsWith('packs/'));

    alice.engine.setPolicy(bob.user.owner, { share: false });
    const pub = await alice.engine.sync();
    expect(pub.own!.published).toBe(true);
    // Every places pack is re-encrypted (new batch keys, new files); the old files are gone.
    const files = new Set((await alice.user.storage.list('packs/')).map((e) => e.path));
    expect(oldFiles.filter((f) => files.has(f)).length).toBeLessThanOrEqual(1); // at most the own-document pack, unchanged
    const r = await bob.engine.sync();
    expect(r.friends[0]!.whatsNew.removed.length).toBe(10);
    expect(friendSaves(bob, alice.user.owner).size).toBe(0);
    // Carol still reads everything.
    await carol.engine.sync();
    expect(friendSaves(carol, alice.user.owner).size).toBe(10);
  });

  it('a friend restricted to one list sees only its places', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    for (let i = 1; i <= 6; i++) alice.store.putSave({ place: point(i, `P${i}`) });
    const list = alice.store.createList({ name: 'Trip', kind: 'manual', visibility: 'link' });
    alice.store.addToList(list, 'osm:node/2');
    alice.store.addToList(list, 'osm:node/4');
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    alice.engine.setPolicy(bob.user.owner, { share: { lists: [list] } });
    await alice.engine.sync();
    await bob.engine.sync();
    expect([...friendSaves(bob, alice.user.owner).keys()]).toEqual(['osm:node/2', 'osm:node/4']);
  });

  it('removing a friend erases their content and stops reading them', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    alice.store.putSave({ place: point(1, 'P1') });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    await bob.engine.sync();
    expect(friendSaves(bob, alice.user.owner).size).toBe(1);
    bob.engine.removeContact(alice.user.owner);
    expect(friendSaves(bob, alice.user.owner).size).toBe(0);
    const r = await bob.engine.sync();
    expect(r.friends).toEqual([]);
  });
});

describe('my own devices', () => {
  it('two devices converge through the storage (document, contacts)', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const b = addDevice(w, user);
    a.store.putSave({ place: point(1, 'From A'), comment: 'a' });
    await a.engine.sync();
    const rb = await b.engine.sync();
    expect(rb.ok).toBe(true);
    expect(b.store.repo.getMySaveForPlace('osm:node/1')!.comment).toBe('a');

    // Concurrent offline edits on both, including the same save.
    a.store.updateSave('osm:node/1', { status: 'tried' });
    b.store.updateSave('osm:node/1', { priceLevel: 3 });
    b.store.putSave({ place: point(2, 'From B') });
    const tag = a.store.createTag({ name: 'Bar' });
    a.store.addSaveTag('osm:node/1', tag);
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    expect(a.store.repo.dumpOwnData()).toBe(b.store.repo.dumpOwnData());
    const s = a.store.repo.getMySaveForPlace('osm:node/1')!;
    expect(s.status).toBe('tried');
    expect(s.priceLevel).toBe(3);

    // A deletion on one device reaches the other (a delete set only).
    b.store.deleteSave('osm:node/2');
    await b.engine.sync();
    await a.engine.sync();
    expect(a.store.repo.getMySaveForPlace('osm:node/2')!.deletedAt).not.toBeNull();

    // A contact added on A is known on B (vault).
    const bob = addDevice(w, makeUser(w, 'bob'));
    await bob.engine.sync();
    await befriend(w, a, bob);
    await a.engine.sync();
    await b.engine.sync();
    expect(b.engine.contacts().map((c) => c.owner)).toEqual([bob.user.owner]);
    expect(b.engine.contacts()[0]!.policy.share).toBe(true);
    // Nothing left to publish: no new index.
    const quiet = await b.engine.sync();
    expect(quiet.own!.published).toBe(false);
  });

  it('own-document deltas are compacted into a full snapshot', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user, { maxOwnDeltas: 3 });
    const b = addDevice(w, user);
    const kinds: string[] = [];
    for (let i = 1; i <= 6; i++) {
      a.store.putSave({ place: point(i, `P${i}`) });
      kinds.push((await a.engine.sync()).own!.ownDoc);
    }
    expect(kinds).toEqual(['full', 'delta', 'delta', 'full', 'delta', 'delta']);
    await b.engine.sync();
    expect(b.store.repo.dumpOwnData()).toBe(a.store.repo.dumpOwnData());
  });
});
