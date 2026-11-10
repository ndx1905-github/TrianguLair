// SPDX-License-Identifier: MPL-2.0
/**
 * Review of PR #85 (T-211/T-212: shared lists, link-only lists, following by link).
 * docs/reviews/2026-11-10-lists-review.md. Each `it.fails` states the DESIRED behaviour and
 * fails today; it turns red (unexpected pass) once the finding is fixed, so flip it to `it`.
 */
import { describe, expect, it } from 'vitest';
import { followIdOf, listLinkFragment, listsReady, newListKey, parseListLinkFragment } from '../src/index.ts';
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
  it.fails('M-01: a friend restricted to "some lists" never receives a list she was picked for earlier', async () => {
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

  // L-01 (Low): switching a link-only list to public and back keeps `linkKey`, so the "dead" link
  // silently works again for everyone who had it (README: "switching to public does the same" as
  // "taking the link away").
  it.fails('L-01: a link cut by going public stays dead when the list becomes link-only again', async () => {
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
  it.fails('L-02: an unfollowed list leaves no list key in my vault', async () => {
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
