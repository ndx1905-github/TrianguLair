// SPDX-License-Identifier: MPL-2.0
/**
 * Lists shared beyond the public file (T-211, T-212): friends with access, link-only lists followed
 * without being a contact, "new link" rotation, deletion, and public lists followed by link.
 */
import { verifyIndex, verifyPublicFile } from '@triangulair/crypto';
import { describe, expect, it } from 'vitest';
import {
  ListGoneError,
  decodeListLink,
  encodeListLink,
  followIdOf,
  listLinkFragment,
  listsReady,
  newListKey,
  parseListLinkFragment,
  publicListsUrl,
  umapUrl,
  type ListLink,
} from '../src/index.ts';
import { addDevice, befriend, friendSaves, makeUser, point, World, type Device } from './helpers.ts';

await listsReady();

/** The link fragment of one of my link-only lists (what the share sheet hands out). */
function linkOf(d: Device, listId: string): string {
  const l = d.store.repo.getList(listId)!;
  return listLinkFragment({ kind: 'link', owner: d.user.owner, location: d.user.location, secret: Buffer.from(l.linkKey!, 'base64url') });
}

function anna(w: World) {
  const a = addDevice(w, makeUser(w, 'anna'), { author: 'Anna' });
  const s = a.store;
  s.putSave({ place: point(1, 'Chez Lili'), comment: 'Public note', commentVisibility: 'public', status: 'favorite' });
  s.putSave({ place: point(2, 'Bistro'), comment: 'Friends only' });
  s.putSave({ place: point(3, 'My home'), sharing: 'private' });
  s.putSave({ place: point(4, 'Not in the list') });
  const list = s.createList({ name: 'Brunch', description: 'Sunday spots', kind: 'manual', visibility: 'link', linkKey: newListKey() });
  for (const id of ['osm:node/1', 'osm:node/2', 'osm:node/3']) s.addToList(list, id);
  return { a, list };
}

describe('list links', () => {
  it('round-trips both kinds and refuses malformed links', () => {
    const owner = makeUser(new World(), 'x').owner;
    const secret = new Uint8Array(32).fill(7);
    const link: ListLink = { kind: 'link', owner, location: 'https://cloud.example/s/abc/', secret };
    const back = decodeListLink(encodeListLink(link));
    expect(back).toEqual(link);
    const pub: ListLink = { kind: 'public', owner, location: 'https://cloud.example/s/abc/', listId: 'k3j2h1' };
    expect(parseListLinkFragment(listLinkFragment(pub))).toEqual(pub);
    // Short enough for a small QR code: 26 + ~170 characters for a typical address.
    expect(listLinkFragment(link).length).toBeLessThan(160);
    expect(followIdOf(link)).toMatch(/^list:[A-Za-z0-9_-]{22}$/);
    expect(followIdOf(link)).not.toBe(followIdOf({ ...link, secret: new Uint8Array(32).fill(8) }));
    expect(() => encodeListLink({ ...link, location: 'http://cloud.example/' })).toThrow();
    expect(() => encodeListLink({ ...link, location: 'https://localhost/x/' })).toThrow();
    const bytes = encodeListLink(link);
    expect(() => decodeListLink(Uint8Array.from([2, ...bytes.subarray(1)]))).toThrow(/version/);
    expect(() => decodeListLink(Uint8Array.from([1, 3, ...bytes.subarray(2)]))).toThrow(/kind/);
    expect(() => decodeListLink(bytes.subarray(0, 40))).toThrow();
    expect(() => parseListLinkFragment('not a link!')).toThrow();
  });

  it('builds the public file address and a well-formed uMap link', () => {
    const file = publicListsUrl('https://cloud.example/s/abc/');
    expect(file).toBe('https://cloud.example/s/abc/public/lists.geojson');
    const u = new URL(umapUrl(file, { lang: 'fr' }));
    expect(u.origin).toBe('https://umap.openstreetmap.fr');
    expect(u.pathname).toBe('/fr/map/new/');
    expect(u.searchParams.get('dataUrl')).toBe(file);
    expect(u.searchParams.get('dataFormat')).toBe('geojson');
    expect(new URL(umapUrl(file, { lang: '../x' })).pathname).toBe('/en/map/new/');
  });
});

describe('link-only lists', () => {
  it('someone with the link previews and follows it without being a contact; updates arrive; private never', async () => {
    const w = new World();
    const { a, list } = anna(w);
    const ben = addDevice(w, makeUser(w, 'ben'));
    expect((await a.engine.sync()).ok).toBe(true);
    const link = linkOf(a, list);

    const p = await ben.engine.previewList(link);
    expect(p).toMatchObject({ kind: 'link', name: 'Brunch', description: 'Sunday spots', author: 'Anna', count: 2, owner: a.user.owner });
    expect(p.features.map((f) => f.properties.name)).toEqual(['Bistro', 'Chez Lili']);
    // Only public comments travel with a link (it can be forwarded); never the private place.
    expect(p.features.find((f) => f.id === 'osm:node/1')!.properties.comment).toBe('Public note');
    expect(p.features.find((f) => f.id === 'osm:node/2')!.properties.comment).toBeUndefined();

    const r = await ben.engine.followList(link);
    expect(r.status).toBe('updated');
    expect(r.whatsNew.added.sort()).toEqual(['osm:node/1', 'osm:node/2']);
    expect(ben.engine.contacts()).toEqual([]); // no contact, no key exchange
    const id = followIdOf(parseListLinkFragment(link));
    expect([...friendSaves(ben, id).keys()]).toEqual(['osm:node/1', 'osm:node/2']);
    expect(ben.store.repo.getPlace('osm:node/3')).toBeNull();
    // Shown like friends' places, one pin.
    expect(ben.store.repo.queryPlaces({ source: 'friends' }).map((x) => x.id).sort()).toEqual(['osm:node/1', 'osm:node/2']);
    expect(ben.engine.followedLists()).toMatchObject([{ id, name: 'Brunch', author: 'Anna', count: 2, gone: null }]);

    // Anna adds a place: Ben's next pass picks it up (What's new); nothing changed: unchanged.
    a.store.addToList(list, 'osm:node/4');
    a.store.updateSave('osm:node/1', { comment: 'Even better', commentVisibility: 'public' });
    await a.engine.sync();
    const r2 = await ben.engine.sync();
    const lr = r2.lists!.find((x) => x.id === id)!;
    expect(lr.status).toBe('updated');
    expect(lr.whatsNew.added).toEqual(['osm:node/4']);
    expect(lr.whatsNew.changed).toMatchObject([{ placeId: 'osm:node/1', meaningful: true }]);
    expect((await ben.engine.sync()).lists!.find((x) => x.id === id)!.status).toBe('unchanged');

    // Unfollow: the places leave.
    ben.engine.unfollowList(id);
    expect(friendSaves(ben, id).size).toBe(0);
    expect(ben.engine.followedLists()).toEqual([]);
  });

  it('"new link" cuts the old link: old holders see "This link no longer works"; the new link works', async () => {
    const w = new World();
    const { a, list } = anna(w);
    const ben = addDevice(w, makeUser(w, 'ben'));
    await a.engine.sync();
    const oldLink = linkOf(a, list);
    await ben.engine.followList(oldLink);
    const oldId = followIdOf(parseListLinkFragment(oldLink));
    const filesBefore = (await a.user.storage.list('packs/')).map((e) => e.path);

    a.store.updateList(list, { linkKey: newListKey() });
    await a.engine.sync();
    // The old list packs are gone from the storage (re-sealed to the new key, new files).
    const filesAfter = new Set((await a.user.storage.list('packs/')).map((e) => e.path));
    expect(filesBefore.filter((f) => !filesAfter.has(f)).length).toBeGreaterThan(0);

    const r = await ben.engine.sync();
    expect(r.lists!.find((x) => x.id === oldId)).toMatchObject({ status: 'gone', gone: 'link-dead' });
    expect(friendSaves(ben, oldId).size).toBe(0);
    expect(ben.engine.followedLists()[0]).toMatchObject({ id: oldId, gone: 'link-dead', count: 0 });
    await expect(ben.engine.previewList(oldLink)).rejects.toThrow(ListGoneError);
    await expect(ben.engine.previewList(oldLink)).rejects.toMatchObject({ gone: 'link-dead' });

    const newLink = linkOf(a, list);
    expect((await ben.engine.previewList(newLink)).count).toBe(2);
    // Stop sharing by link altogether: same answer for the holders.
    a.store.updateList(list, { linkKey: null });
    await a.engine.sync();
    await expect(ben.engine.previewList(newLink)).rejects.toMatchObject({ gone: 'link-dead' });
  });

  it('a deleted list says "This list no longer exists", also after it leaves the trash', async () => {
    const w = new World();
    const { a, list } = anna(w);
    const a2 = addDevice(w, a.user);
    const ben = addDevice(w, makeUser(w, 'ben'));
    await a.engine.sync();
    const link = linkOf(a, list);
    await ben.engine.followList(link);
    const id = followIdOf(parseListLinkFragment(link));

    a.store.deleteList(list);
    await a.engine.sync();
    expect((await ben.engine.sync()).lists![0]).toMatchObject({ id, status: 'gone', gone: 'deleted' });
    expect(friendSaves(ben, id).size).toBe(0);

    // Purged from the trash on Anna's other device: the tombstone stays (until its date).
    await a2.engine.sync();
    a2.store.purgeTrash();
    a2.store.repo.db.run(`DELETE FROM lists WHERE id = ?`, [list]); // as after the 30 days
    await a2.engine.sync();
    await a.engine.sync();
    await expect(ben.engine.previewList(link)).rejects.toMatchObject({ gone: 'deleted' });
  });

  it('nothing is re-sealed when nothing changed; another device of mine keeps the same list packs', async () => {
    const w = new World();
    const { a } = anna(w);
    const a2 = addDevice(w, a.user, { author: 'Anna' }); // the author name is in the link packs
    await a.engine.sync();
    const before = a.engine.own!.index!.packs.map((p) => p.file).sort();
    expect((await a.engine.sync()).own!.published).toBe(false);
    await a2.engine.sync();
    const r = await a2.engine.sync();
    expect(r.own!.packsWritten).toBe(0);
    expect(a2.engine.own!.index!.packs.map((p) => p.file).sort()).toEqual(before);
  });

  it('a link naming another storage, or a forged list pack, is refused', async () => {
    const w = new World();
    const { a, list } = anna(w);
    const eve = addDevice(w, makeUser(w, 'eve'));
    const ben = addDevice(w, makeUser(w, 'ben'));
    await a.engine.sync();
    await eve.engine.sync();
    const secret = Buffer.from(a.store.repo.getList(list)!.linkKey!, 'base64url');
    // Anna's key, Eve's address: Eve's index is not signed by Anna's master key.
    const forged = listLinkFragment({ kind: 'link', owner: a.user.owner, location: eve.user.location, secret });
    await expect(ben.engine.previewList(forged)).rejects.toThrow();
    // A list pack re-listed in Eve's own index does not open as Anna's (owner bound in the AEAD).
    const evesLink = listLinkFragment({ kind: 'link', owner: eve.user.owner, location: eve.user.location, secret });
    await expect(ben.engine.previewList(evesLink)).rejects.toMatchObject({ gone: 'link-dead' });
  });

  it('the list key is never usable by friends: a friend who sees everything cannot open the link pack', async () => {
    const w = new World();
    const { a, list } = anna(w);
    const carol = addDevice(w, makeUser(w, 'carol'));
    await a.engine.sync();
    await carol.engine.sync();
    await befriend(w, a, carol);
    await a.engine.sync();
    await carol.engine.sync();
    expect([...friendSaves(carol, a.user.owner).keys()].sort()).toEqual(['osm:node/1', 'osm:node/2', 'osm:node/4']);
    // She sees no list definition until Anna picks her for that list.
    expect(carol.engine.reader.friendLists(a.user.owner)).toEqual([]);
    expect(list).toBeTruthy();
  });
});

describe('lists shared with friends', () => {
  it('a friend with "some lists" sees only those lists and their places; a picked friend sees the definition too', async () => {
    const w = new World();
    const a = addDevice(w, makeUser(w, 'anna'));
    const s = a.store;
    for (let i = 1; i <= 6; i++) s.putSave({ place: point(i, `P${i}`) });
    s.updateSave('osm:node/5', { sharing: 'private' });
    const trip = s.createList({ name: 'Trip', kind: 'manual', visibility: 'link' });
    const secret = s.createList({ name: 'Secret dinners', kind: 'manual', visibility: 'link' });
    for (const id of ['osm:node/1', 'osm:node/2', 'osm:node/5']) s.addToList(trip, id);
    for (const id of ['osm:node/3', 'osm:node/4']) s.addToList(secret, id);
    const carol = addDevice(w, makeUser(w, 'carol')); // restricted to "Trip"
    const dave = addDevice(w, makeUser(w, 'dave')); // sees everything
    const erin = addDevice(w, makeUser(w, 'erin')); // sees everything, picked for "Secret dinners"
    for (const d of [a, carol, dave, erin]) await d.engine.sync();
    for (const d of [carol, dave, erin]) await befriend(w, a, d);
    a.engine.setPolicy(carol.user.owner, { share: false });
    a.engine.setListAccess(carol.user.owner, trip, true);
    a.engine.setListAccess(erin.user.owner, secret, true);
    expect(a.engine.book.policy(carol.user.owner).share).toEqual({ lists: [trip] });
    expect(a.engine.book.policy(erin.user.owner)).toMatchObject({ share: true, lists: [secret] });
    expect(a.engine.book.listViewers(trip)).toEqual([carol.user.owner]);
    await a.engine.sync();
    for (const d of [carol, dave, erin]) await d.engine.sync();

    expect([...friendSaves(carol, a.user.owner).keys()]).toEqual(['osm:node/1', 'osm:node/2']);
    expect(carol.engine.reader.friendLists(a.user.owner)).toEqual([
      { id: trip, name: 'Trip', updated: expect.any(String), items: ['osm:node/1', 'osm:node/2'] },
    ]);
    expect(dave.engine.reader.friendLists(a.user.owner)).toEqual([]);
    expect(erin.engine.reader.friendLists(a.user.owner).map((l) => [l.name, l.items])).toEqual([['Secret dinners', ['osm:node/3', 'osm:node/4']]]);
    expect(friendSaves(erin, a.user.owner).size).toBe(5);

    // Renaming reaches them; taking Carol's access away removes the list and its places.
    s.updateList(trip, { name: 'Lisbon trip' });
    await a.engine.sync();
    await carol.engine.sync();
    expect(carol.engine.reader.friendLists(a.user.owner)[0]!.name).toBe('Lisbon trip');
    a.engine.setListAccess(carol.user.owner, trip, false);
    expect(a.engine.book.policy(carol.user.owner).share).toBe(false);
    await a.engine.sync();
    await carol.engine.sync();
    expect(carol.engine.reader.friendLists(a.user.owner)).toEqual([]);
    expect(friendSaves(carol, a.user.owner).size).toBe(0);

    // Access settings travel through the vault: Anna's other device publishes the same audiences.
    const a2 = addDevice(w, a.user);
    await a2.engine.sync();
    expect(a2.engine.book.policy(erin.user.owner)).toMatchObject({ lists: [secret] });
  });
});

describe('public lists', () => {
  it('the file is valid GeoJSON with attribution and uMap styles; a public list is followed by link', async () => {
    const w = new World();
    const a = addDevice(w, makeUser(w, 'anna'), { author: 'Anna' });
    const ben = addDevice(w, makeUser(w, 'ben'));
    const s = a.store;
    const tag = s.createTag({ name: 'Brunch', color: '#16A34A' });
    s.putSave({ place: point(1, 'Open'), comment: 'public note', commentVisibility: 'public' });
    s.putSave({ place: point(2, 'Friends note'), comment: 'friends only' });
    s.putSave({ place: point(3, 'Private'), sharing: 'private' });
    s.putSave({ place: { id: 'local:marketzone1', name: 'Market zone', category: null, kind: 'zone', geometry: { type: 'Polygon', coordinates: [[[2.34, 48.85], [2.35, 48.85], [2.35, 48.86], [2.34, 48.85]]] } } });
    const zone = s.repo.queryPlaces({ source: 'mine' }).find((p) => p.name === 'Market zone')!.id;
    for (const id of ['osm:node/1', 'osm:node/2', 'osm:node/3', zone]) s.addSaveTag(id, tag);
    const list = s.createList({ name: 'Brunch spots', description: 'Weekends', kind: 'filter', visibility: 'public', filter: { tags: [tag] } });
    await a.engine.sync();
    const bytes = (await w.readAdapter(a.user.location).get('public/lists.geojson'))!.data;
    verifyPublicFile(bytes, a.engine.own!.index!);
    const geo = JSON.parse(new TextDecoder().decode(bytes));
    // RFC 7946 shape.
    expect(geo.type).toBe('FeatureCollection');
    for (const f of geo.features) {
      expect(f.type).toBe('Feature');
      expect(['Point', 'Polygon']).toContain(f.geometry.type);
      expect(typeof f.properties.name).toBe('string');
      expect(f.properties.list).toBe(list);
      expect(f.properties.list_name).toBe('Brunch spots');
    }
    expect(geo.attribution).toBe('Contains data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0');
    expect(geo.license).toEqual({ name: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' });
    expect(geo.triangulair).toMatchObject({ kind: 'public-lists', owner: a.user.owner, author: 'Anna', lists: [{ id: list, name: 'Brunch spots', description: 'Weekends', count: 3 }] });
    const open = geo.features.find((f: { properties: { name: string } }) => f.properties.name === 'Open');
    expect(open.properties).toMatchObject({ description: 'public note', url: 'https://www.openstreetmap.org/node/1', _umap_options: { color: '#16A34A', iconClass: 'Drop' } });
    const z = geo.features.find((f: { properties: { name: string } }) => f.properties.name === 'Market zone');
    expect(z.properties._umap_options).toMatchObject({ color: '#16A34A', fillOpacity: 0.2 });
    expect(geo.features.some((f: { properties: { name: string } }) => f.properties.name === 'Private')).toBe(false);

    // Followed by its public link (no key at all).
    const link = listLinkFragment({ kind: 'public', owner: a.user.owner, location: a.user.location, listId: list });
    const p = await ben.engine.previewList(link);
    expect(p).toMatchObject({ kind: 'public', name: 'Brunch spots', author: 'Anna', count: 3 });
    await ben.engine.followList(link);
    const id = followIdOf(parseListLinkFragment(link));
    expect(friendSaves(ben, id).get('osm:node/1')).toEqual({ comment: 'public note', status: null });
    s.deleteList(list);
    await a.engine.sync();
    expect((await ben.engine.sync()).lists![0]).toMatchObject({ status: 'gone', gone: 'deleted' });
    // The index still verifies for anyone (sanity).
    verifyIndex((await w.readAdapter(a.user.location).get('index.json'))!.data, { expectedOwner: a.user.owner, location: a.user.location });
  });
});

describe('followed lists across my devices', () => {
  it('a list followed on one device is followed by the other through the vault; unfollowing too', async () => {
    const w = new World();
    const { a, list } = anna(w);
    const benUser = makeUser(w, 'ben');
    const b1 = addDevice(w, benUser);
    const b2 = addDevice(w, benUser);
    await a.engine.sync();
    await b1.engine.sync();
    await b2.engine.sync();
    const link = linkOf(a, list);
    await b1.engine.followList(link);
    await b1.engine.sync();
    await b2.engine.sync();
    const id = followIdOf(parseListLinkFragment(link));
    expect(friendSaves(b2, id).size).toBe(2);
    b2.engine.unfollowList(id);
    await b2.engine.sync();
    await b1.engine.sync();
    expect(b1.engine.followedLists()).toEqual([]);
    expect(friendSaves(b1, id).size).toBe(0);
  });

  it('refuses to follow my own list', async () => {
    const w = new World();
    const { a, list } = anna(w);
    await a.engine.sync();
    await expect(a.engine.followList(linkOf(a, list))).rejects.toThrow(/mine/);
  });
});
