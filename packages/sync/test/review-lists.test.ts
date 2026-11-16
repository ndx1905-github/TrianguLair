// SPDX-License-Identifier: MPL-2.0
/**
 * Review of PR #85 (T-211/T-212: shared lists, link-only lists, following by link).
 * docs/reviews/2026-11-10-lists-review.md. Each test was an `it.fails` reproduction that states
 * the desired behaviour; the fixes made them plain tests, with extra ones for the new behaviour.
 */
import { describe, expect, it } from 'vitest';
import { audienceOf, ContactBook, FOLLOWED_REMOVED_KEEP_MS, MAX_FOLLOWED_LISTS, mergeBooks, TooManyFollowedListsError, desiredListPacks, followIdOf, listLinkFragment, listsReady, newListKey, parseListLinkFragment, parseLists, readOwnItems, heldPublicPlaces, looksLikeHome, type Audience, type ListDef } from '../src/index.ts';
import { addDevice, befriend, friendSaves, makeUser, point, World, type Device } from './helpers.ts';

await listsReady();

function linkOf(d: Device, listId: string): string {
  const l = d.store.repo.getList(listId)!;
  return listLinkFragment({ kind: 'link', owner: d.user.owner, location: d.user.location, secret: Buffer.from(l.linkKey!, 'base64url') });
}

function anna(w: World) {
  const a = addDevice(w, makeUser(w, 'anna'), { author: 'Anna' });
  const s = a.store;
  s.putSave({ place: point(1, 'Chez Lili'), comment: 'Public note', commentVisibility: 'public', status: 'favorite' });
  s.putSave({ place: point(2, 'Bistro'), comment: 'Friends only' });
  const list = s.createList({ name: 'Brunch', kind: 'manual', visibility: 'link', linkKey: newListKey() });
  for (const id of ['osm:node/1', 'osm:node/2']) s.addToList(list, id);
  return { a, list };
}

describe('review PR #85: lists', () => {
  // M-01 (Medium): a contact picked for a list while seeing everything, then restricted to "some
  // lists", keeps the stale `policy.lists` entry: listsSeenBy() still names the old list, so its
  // definition (name, description, place ids of places she can no longer read) is sealed to her.
  it('M-01: a friend restricted to "some lists" never receives a list she was picked for earlier', async () => {
    const w = new World();
    const a = addDevice(w, makeUser(w, 'anna'));
    const s = a.store;
    for (let i = 1; i <= 4; i++) s.putSave({ place: point(i, `P${i}`) });
    const trip = s.createList({ name: 'Trip', kind: 'manual', visibility: 'link' });
    const secret = s.createList({ name: 'Secret dinners', kind: 'manual', visibility: 'link' });
    for (const id of ['osm:node/1', 'osm:node/2']) s.addToList(trip, id);
    for (const id of ['osm:node/3', 'osm:node/4']) s.addToList(secret, id);
    const erin = addDevice(w, makeUser(w, 'erin'));
    for (const d of [a, erin]) await d.engine.sync();
    await befriend(w, a, erin); // sees everything
    a.engine.setListAccess(erin.user.owner, secret, true); // picked for "Secret dinners"
    // Later, from the contact screen: "she sees some lists: Trip" (contacts service → setPolicy).
    a.engine.setPolicy(erin.user.owner, { share: { lists: [trip] } });
    await a.engine.sync();
    await erin.engine.sync();
    expect([...friendSaves(erin, a.user.owner).keys()].sort()).toEqual(['osm:node/1', 'osm:node/2']); // places: OK
    expect(a.engine.book.listViewers(secret)).toEqual([]);
    expect(erin.engine.reader.friendLists(a.user.owner).map((l) => l.name)).toEqual(['Trip']);
  });

  it('M-01: a pick is dropped when the scope changes and does not come back (true → false → true)', () => {
    const w = new World();
    const book = ContactBook.empty(makeUser(w, 'me').owner);
    book.setPolicy('ed25519:erin', { share: true, follow: false }, 1);
    book.setListAccess('ed25519:erin', 'secret', true, 2);
    expect(book.policy('ed25519:erin').lists).toEqual(['secret']);
    book.setPolicy('ed25519:erin', { share: true }, 3); // same scope: kept
    expect(book.policy('ed25519:erin').lists).toEqual(['secret']);
    book.setPolicy('ed25519:erin', { share: false }, 4);
    expect(book.policy('ed25519:erin').lists).toBeUndefined();
    book.setPolicy('ed25519:erin', { share: true }, 5);
    expect(book.policy('ed25519:erin').lists).toBeUndefined();
    // Restricted: the restriction alone decides; picking adds to the restriction itself.
    book.setPolicy('ed25519:erin', { share: { lists: ['trip'] } }, 6);
    book.setListAccess('ed25519:erin', 'secret', true, 7);
    expect(book.policy('ed25519:erin')).toMatchObject({ share: { lists: ['secret', 'trip'] } });
    expect(book.policy('ed25519:erin').lists).toBeUndefined();
  });

  it('M-01: a friends\' lists pack only names places every viewer of the pack can read', () => {
    const w = new World();
    const a = addDevice(w, makeUser(w, 'anna'));
    const s = a.store;
    for (let i = 1; i <= 3; i++) s.putSave({ place: point(i, `P${i}`) });
    const list = s.createList({ name: 'Mixed', kind: 'manual', visibility: 'link' });
    for (const id of ['osm:node/1', 'osm:node/2', 'osm:node/3']) s.addToList(list, id);
    const erin = makeUser(w, 'erin');
    const me = a.user.sharing.cert.key;
    const her = erin.sharing.cert.key;
    // As if a policy slip named the list to Erin while she can only read place 1.
    const contacts = [{ owner: erin.owner, sharingCert: erin.sharing.cert, anchor: undefined, verified: true, policy: { share: true, follow: false, lists: [list], at: 1 } }];
    const audiences = new Map<string, Audience>([
      ['osm:node/1', audienceOf([me, her])],
      ['osm:node/2', audienceOf([me])],
    ]);
    const packs = desiredListPacks({ repo: s.repo, items: readOwnItems(s.repo), myCert: a.user.sharing.cert, contacts, audiences, now: new Date() });
    const friends = packs.filter((p) => p.role === 'friends');
    expect(friends).toHaveLength(1);
    expect((parseLists(friends[0]!.body).lists[0] as ListDef).items).toEqual(['osm:node/1']);
  });

  // M-02 (Medium): a home-like place that a public filter list takes by itself is held out of the
  // public file until the author confirms it (an explicit "include" of the filter).
  it('M-02: a home-like place newly matching a public filter list waits for the author', async () => {
    const w = new World();
    const a = addDevice(w, makeUser(w, 'anna'));
    const s = a.store;
    const tag = s.createTag({ name: 'Brunch', color: '#16A34A' });
    s.putSave({ place: point(1, 'Cafe') });
    const list = s.createList({ name: 'Brunch', kind: 'filter', visibility: 'public', filter: { tags: [tag] } });
    s.addSaveTag('osm:node/1', tag);
    await a.engine.sync();
    const names = async () => {
      const geo = JSON.parse(new TextDecoder().decode((await w.readAdapter(a.user.location).get('public/lists.geojson'))!.data));
      return (geo.features as { properties: { name: string } }[]).map((f) => f.properties.name).sort();
    };
    expect(await names()).toEqual(['Cafe']);

    // A friend's house and a point placed by hand get the same tag: held.
    s.putSave({ place: { ...point(2, "Marie's"), category: 'building=house' } });
    s.putSave({ place: { id: 'local:pin00001', name: 'Pin', category: null, kind: 'place', geometry: { type: 'Point', coordinates: [2.3, 48.8] } } });
    const pin = s.repo.queryPlaces({ source: 'mine' }).find((p) => p.name === 'Pin')!.id;
    s.addSaveTag('osm:node/2', tag);
    s.addSaveTag(pin, tag);
    await a.engine.sync();
    expect(await names()).toEqual(['Cafe']);
    expect([...heldPublicPlaces(s.repo, readOwnItems(s.repo)).get(list)!.map((i) => i.name)].sort()).toEqual(["Marie's", 'Pin']);

    // Confirmed (include): published; refused (exclude): out of the list for good.
    s.setListFilter(list, { tags: [tag], include: ['osm:node/2'], exclude: [pin] });
    await a.engine.sync();
    expect(await names()).toEqual(['Cafe', "Marie's"]);
    expect(heldPublicPlaces(s.repo, readOwnItems(s.repo)).size).toBe(0);
  });

  it('M-02: the home rule (dwellings, places without category, never zones)', () => {
    expect(looksLikeHome({ kind: 'place', category: 'building=apartments', local: false, address: null })).toBe(true);
    expect(looksLikeHome({ kind: 'place', category: 'amenity=cafe', local: false, address: '1 rue X' })).toBe(false);
    expect(looksLikeHome({ kind: 'place', category: null, local: false, address: '1 rue X' })).toBe(true);
    expect(looksLikeHome({ kind: 'place', category: null, local: false, address: null })).toBe(false);
    expect(looksLikeHome({ kind: 'place', category: null, local: true, address: null })).toBe(true);
    expect(looksLikeHome({ kind: 'zone', category: null, local: true, address: null })).toBe(false);
  });

  // L-01 (Low): switching a link-only list to public and back keeps `linkKey`, so the "dead" link
  // silently works again for everyone who had it (README: "switching to public does the same" as
  // "taking the link away").
  it('L-01: a link cut by going public stays dead when the list becomes link-only again', async () => {
    const w = new World();
    const { a, list } = anna(w);
    const ben = addDevice(w, makeUser(w, 'ben'));
    await a.engine.sync();
    const link = linkOf(a, list);
    const id = followIdOf(parseListLinkFragment(link));
    await ben.engine.followList(link);

    a.store.updateList(list, { visibility: 'public' });
    await a.engine.sync();
    expect((await ben.engine.sync()).lists!.find((x) => x.id === id)).toMatchObject({ gone: 'link-dead' });

    a.store.updateList(list, { visibility: 'link' });
    await a.engine.sync();
    const r = await ben.engine.sync();
    expect(r.lists!.find((x) => x.id === id)).toMatchObject({ status: 'gone', gone: 'link-dead' });
    expect(friendSaves(ben, id).size).toBe(0);
  });

  // L-02 (Low): unfollowing keeps the whole link (the list's secret key) in the `removed` vault
  // entry forever; the vault only needs the followed-list id to stop a merge from bringing it back.
  it('L-02: an unfollowed list leaves no list key in my vault', async () => {
    const w = new World();
    const { a, list } = anna(w);
    const ben = addDevice(w, makeUser(w, 'ben'));
    await a.engine.sync();
    await ben.engine.sync();
    const link = linkOf(a, list);
    await ben.engine.followList(link);
    ben.engine.unfollowList(followIdOf(parseListLinkFragment(link)));
    await ben.engine.sync();
    expect(JSON.stringify(ben.engine.book.records)).not.toContain(link);
  });

  it('L-02: removed entries lose their link in a merge, are dropped after 180 days, and the number of followed lists is capped', () => {
    const w = new World();
    const owner = makeUser(w, 'me').owner;
    const book = ContactBook.empty(owner);
    // A vault written by older code: the removed entry still holds its link.
    const old = ContactBook.empty(owner);
    old.followList('list:a', 'SECRET', 1);
    const part = (old.records.app as Record<string, { lists: Record<string, unknown> }>).triangulair_sync!;
    part.lists['list:a'] = { link: 'SECRET', at: 2, removed: true };
    book.records = mergeBooks(book.records, old.records);
    expect(JSON.stringify(book.records)).not.toContain('SECRET');
    expect(book.followedLists()).toEqual([]);
    // Kept 180 days (a merge cannot bring the list back), then dropped.
    expect(book.pruneFollowedLists(2 + FOLLOWED_REMOVED_KEEP_MS)).toBe(false);
    expect(book.pruneFollowedLists(3 + FOLLOWED_REMOVED_KEEP_MS)).toBe(true);
    expect(JSON.stringify(book.records)).not.toContain('list:a');

    for (let i = 0; i < MAX_FOLLOWED_LISTS; i++) book.followList(`list:${i}`, `L${i}`, 10 + i);
    expect(() => book.followList('list:more', 'M', 1000)).toThrow(TooManyFollowedListsError);
    book.followList('list:0', 'L0', 1001); // already followed: fine
    book.unfollowList('list:1', 1002);
    book.followList('list:more', 'M', 1003);
    expect(book.followedLists()).toHaveLength(MAX_FOLLOWED_LISTS);
  });

  // L-03 (Low): a forwardable link carries the exact time each place was saved and last edited
  // (habits), although the preview never shows them; the public file has the same fields.
  it.fails('L-03: places of a link-only list carry no exact save dates', async () => {
    const w = new World();
    const { a, list } = anna(w);
    const ben = addDevice(w, makeUser(w, 'ben'));
    await a.engine.sync();
    const p = await ben.engine.previewList(linkOf(a, list));
    for (const f of p.features) expect((f.properties as Record<string, unknown>).created).toBeUndefined();
  });
});
