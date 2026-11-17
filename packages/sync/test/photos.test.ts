// SPDX-License-Identifier: MPL-2.0
/** Personal photos (T-111b): publication, friends' thumbnails and full photos, removal, revocation, quota, cache, own devices. */
import { describe, expect, it } from 'vitest';
import { MemoryAdapter, StorageError, type StorageAdapter } from '@triangulair/storage';
import { NodeSqliteDriver } from '@triangulair/data/node';
import { MemoryMediaCache, SqliteMediaCache } from '../src/media-cache.ts';
import { imageMetadata, sniffImage, stripImageMetadata } from '../src/image-meta.ts';
import { checkPhotoRefs } from '../src/photos.ts';
import { PhotoError } from '../src/photo-service.ts';
import { addDevice, befriend, makeUser, point, World, type Device } from './helpers.ts';
import { has, jpeg, photo, webp } from './photo-fixtures.ts';

const P1 = 'osm:node/1';

async function pair(opts: { aliceStorage?: StorageAdapter; bobCache?: number } = {}) {
  const w = new World();
  const alice = addDevice(w, makeUser(w, 'alice', opts.aliceStorage ? { storage: opts.aliceStorage } : {}));
  const bob = addDevice(w, makeUser(w, 'bob'), opts.bobCache !== undefined ? { friendsCacheBytes: opts.bobCache } : {});
  alice.store.putSave({ place: point(1, 'Chez Lili'), comment: 'Great pizza' });
  await alice.engine.sync();
  await bob.engine.sync();
  await befriend(w, alice, bob);
  return { w, alice, bob };
}

const mediaFiles = async (d: Device) => (await d.user.storage.list('media/')).map((e) => e.path).sort();
const photosOf = (d: Device, placeId = P1) => d.engine.photos.list(placeId);

describe('photos: owner adds, friend sees the thumbnail and opens the full photo', () => {
  it('publishes encrypted media files referenced from the places pack; thumbnails with the places, full photo on opening', async () => {
    const { alice, bob } = await pair();
    const img = photo(1, { exif: true });
    const id = alice.engine.photos.add(P1, img);
    // Metadata (EXIF with GPS and device model) is gone from the local copy.
    const local = alice.engine.photos.list(P1)[0]!;
    expect(local).toMatchObject({ id, mine: true, state: 'waiting', thumbLocal: true, fullLocal: true, mime: 'image/webp', width: 1600 });
    const mine = (await alice.engine.photos.full(id))!.bytes;
    expect(has(mine, 'GPSLatitude')).toBe(false);
    expect(imageMetadata(mine)).toEqual([]);

    const before = await mediaFiles(alice);
    const r = await alice.engine.sync();
    expect(r.ok).toBe(true);
    expect(r.own!.photos).toMatchObject({ uploaded: 1, waiting: 0, renewed: 0 });
    expect(alice.engine.photos.list(P1)[0]!.state).toBe('uploaded');
    const added = (await mediaFiles(alice)).filter((f) => !before.includes(f));
    expect(added.length).toBeGreaterThanOrEqual(2); // full + thumbnail (+ document delta, manifest)
    // Nothing on the storage holds the image in clear.
    for (const e of await alice.user.storage.list('')) {
      const g = await alice.user.storage.get(e.path);
      expect(has(g!.data, 'VP8L')).toBe(false);
    }
    // Files are padded like every payload: at least the 4 KiB floor (a 2 KB thumbnail too).
    const sizes = (await alice.user.storage.list('media/')).map((e) => e.size);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(4096);

    const rb = await bob.engine.sync();
    expect(rb.ok).toBe(true);
    expect(rb.photos?.thumbnails).toBe(1); // came with the places
    const seen = photosOf(bob);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id, mine: false, ownerId: alice.user.owner, state: 'friend', thumbLocal: true, fullLocal: false });
    // The full photo is downloaded only when opened.
    const full = await bob.engine.photos.full(id);
    expect(full!.bytes).toEqual(mine);
    expect(full!.mime).toBe('image/webp');
    expect(photosOf(bob)[0]!.fullLocal).toBe(true);
    const thumb = await bob.engine.photos.thumbnail(id);
    expect(sniffImage(thumb!.bytes)).toBe('image/webp');

    // Idle: nothing re-uploaded.
    const again = await alice.engine.sync();
    expect(again.own!.photos.uploaded).toBe(0);
    expect(again.own!.published).toBe(false);
  });

  it('a new photo on a place a friend already has is "new photo" in What\'s new', async () => {
    const { alice, bob } = await pair();
    await alice.engine.sync();
    await bob.engine.sync();
    const id = alice.engine.photos.add(P1, photo(2));
    await alice.engine.sync();
    const r = await bob.engine.sync();
    const wn = r.friends[0]!.whatsNew;
    expect(wn.photos).toEqual([{ placeId: P1, mediaIds: [id] }]);
    expect(wn.changed).toMatchObject([{ placeId: P1, meaningful: true, fields: ['photos'] }]);
  });

  it('private saves: the photo is uploaded for my devices only; my other device gets it', async () => {
    const { w, alice, bob } = await pair();
    alice.store.putSave({ place: point(2, 'Home'), sharing: 'private' });
    const id = alice.engine.photos.add('osm:node/2', photo(3));
    const id1 = alice.engine.photos.add(P1, photo(4));
    await alice.engine.sync();
    await bob.engine.sync();
    expect(bob.store.repo.mediaById(id)).toBeNull();
    expect(bob.store.repo.mediaById(id1)).not.toBeNull();

    const alice2 = addDevice(w, alice.user);
    const r = await alice2.engine.sync();
    expect(r.ok).toBe(true);
    const items = alice2.engine.photos.list('osm:node/2');
    expect(items).toMatchObject([{ id, mine: true, state: 'uploaded', thumbLocal: true, fullLocal: true }]);
    expect((await alice2.engine.photos.full(id))!.bytes).toEqual((await alice.engine.photos.full(id))!.bytes);
    // Nothing to publish from the second device.
    expect((await alice2.engine.sync()).own!.photos.uploaded).toBe(0);
  });

  it('a photo is refused when it is not an image, too large, or for a place I did not save', async () => {
    const { alice } = await pair();
    expect(() => alice.engine.photos.add(P1, { ...photo(1), full: new Uint8Array(100) })).toThrow(PhotoError);
    expect(() => alice.engine.photos.add(P1, { ...photo(1), thumb: jpeg(100) })).toThrow(/same format/);
    expect(() => alice.engine.photos.add(P1, { ...photo(1), full: webp(9 * 1024 * 1024) })).toThrow(/too large/);
    expect(() => alice.engine.photos.add('osm:node/99', photo(1))).toThrow(/save the place/);
  });
});

describe('photos: removal and revocation', () => {
  it('removing a photo deletes its files and removes it from the friend\'s cache', async () => {
    const { alice, bob } = await pair();
    const id = alice.engine.photos.add(P1, photo(1));
    await alice.engine.sync();
    await bob.engine.sync();
    await bob.engine.photos.full(id);
    const withPhoto = await mediaFiles(alice);
    alice.engine.photos.remove(P1, id);
    expect(alice.engine.photos.list(P1)).toEqual([]);
    const r = await alice.engine.sync();
    expect(r.own!.filesDeleted).toBeGreaterThanOrEqual(2);
    const now = await mediaFiles(alice);
    expect(withPhoto.filter((f) => !now.includes(f)).length).toBeGreaterThanOrEqual(2);
    await bob.engine.sync();
    expect(photosOf(bob)).toEqual([]);
    expect(bob.engine.photos.cache.usage().friends).toBe(0);
    expect(await bob.engine.photos.full(id)).toBeNull();
  });

  it('a friend whose access is removed cannot fetch the photo; the others get it under a new key', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    const carol = addDevice(w, makeUser(w, 'carol'));
    alice.store.putSave({ place: point(1, 'Chez Lili') });
    await Promise.all([alice.engine.sync(), bob.engine.sync(), carol.engine.sync()]);
    await befriend(w, alice, bob);
    await befriend(w, alice, carol);
    const id = alice.engine.photos.add(P1, photo(5));
    await alice.engine.sync();
    await bob.engine.sync();
    await carol.engine.sync();
    const oldRef = bob.store.repo.mediaById(id)!.upload!;

    // Adding someone uploads nothing (the key only travels in the places pack).
    const dave = addDevice(w, makeUser(w, 'dave'));
    await dave.engine.sync();
    await befriend(w, alice, dave);
    const add = await alice.engine.sync();
    expect(add.own!.photos).toMatchObject({ uploaded: 0, renewed: 0 });
    await dave.engine.sync();
    expect(await dave.engine.photos.full(id)).not.toBeNull();

    alice.engine.setPolicy(bob.user.owner, { share: false });
    const r = await alice.engine.sync();
    expect(r.own!.photos).toMatchObject({ uploaded: 1, renewed: 1 });
    // The old files are gone: Bob, who still has the old reference (he has not synced), gets nothing.
    expect(await bob.engine.photos.full(id)).toBeNull();
    const old = await alice.user.storage.get(`media/b2b256-${oldRef.full.slice(7)}.bin`);
    expect(old).toBeNull();
    await bob.engine.sync();
    expect(photosOf(bob)).toEqual([]);
    expect(bob.engine.photos.cache.usage().friends).toBe(0);
    // Carol reads the photo under its new key.
    await carol.engine.sync();
    const ref = carol.store.repo.mediaById(id)!.upload!;
    expect(ref.key).not.toBe(oldRef.key);
    expect((await carol.engine.photos.full(id))!.bytes).toEqual((await alice.engine.photos.full(id))!.bytes);
    // Nothing more to renew.
    expect((await alice.engine.sync()).own!.photos.renewed).toBe(0);
  });

  it('a save made private renews its photo key; a device that never opened the photo renews it from the storage', async () => {
    const { w, alice, bob } = await pair();
    const id = alice.engine.photos.add(P1, photo(6));
    await alice.engine.sync();
    const alice2 = addDevice(w, alice.user, { media: new MemoryMediaCache() });
    await alice2.engine.sync();
    // Make the second device forget the image: it must fetch it with the old key to re-seal it.
    for (const k of alice2.engine.photos.cache.ids()) alice2.engine.photos.cache.delete(k);
    alice2.store.updateSave(P1, { sharing: 'private' });
    const r = await alice2.engine.sync();
    expect(r.own!.photos).toMatchObject({ renewed: 1 });
    await bob.engine.sync();
    expect(photosOf(bob)).toEqual([]);
    await alice.engine.sync();
    expect((await alice.engine.photos.full(id))).not.toBeNull();
  });
});

describe('photos: quota full and the friends\' cache', () => {
  it('quota full: the text is published, the photo waits and goes out once there is room', async () => {
    const inner = new MemoryAdapter();
    let full = false;
    const storage: StorageAdapter = {
      capabilities: inner.capabilities,
      get: (p, o) => inner.get(p, o),
      head: (p) => inner.head(p),
      list: (p) => inner.list(p),
      delete: (p, o) => inner.delete(p, o),
      put: async (p, d, o) => {
        if (full && p.startsWith('media/') && d.length > 16_000) throw new StorageError('PROTOCOL', 'Insufficient Storage', { status: 507, path: p });
        return inner.put(p, d, o);
      },
    };
    const { alice, bob } = await pair({ aliceStorage: storage });
    full = true;
    const id = alice.engine.photos.add(P1, photo(7, { size: 40_000 }));
    alice.store.updateSave(P1, { comment: 'Now with a photo' });
    const r = await alice.engine.sync();
    expect(r.own!.published).toBe(true);
    expect(r.own!.photos).toMatchObject({ uploaded: 0, waiting: 1 });
    expect(r.problems.map((p) => p.problem.kind)).toEqual(['quota']);
    expect(alice.engine.photos.list(P1)[0]!.state).toBe('waiting');
    await bob.engine.sync();
    expect(bob.store.repo.getSave(bob.store.repo.savesForPlace(P1)[0]!.id)!.comment).toBe('Now with a photo');
    expect(photosOf(bob)).toEqual([]);

    full = false;
    const again = await alice.engine.sync();
    expect(again.ok).toBe(true);
    expect(again.own!.photos).toMatchObject({ uploaded: 1, waiting: 0 });
    await bob.engine.sync();
    expect(photosOf(bob).map((p) => p.id)).toEqual([id]);
  });

  it('evicts friends\' full photos first, least recently used, and keeps their places', async () => {
    const { alice, bob } = await pair({ bobCache: 70_000 });
    for (let i = 2; i <= 4; i++) alice.store.putSave({ place: point(i, `P${i}`) });
    const ids = [1, 2, 3, 4].map((i) => alice.engine.photos.add(`osm:node/${i}`, photo(10 + i, { size: 30_000 })));
    await alice.engine.sync();
    await bob.engine.sync();
    expect(bob.engine.photos.usage().friends).toBeLessThan(70_000); // four thumbnails
    await bob.engine.photos.full(ids[0]!);
    await bob.engine.photos.full(ids[1]!);
    await bob.engine.photos.full(ids[2]!); // over the cap: the least recently used full photo goes
    const has = (id: string) => bob.engine.photos.list(bob.store.repo.mediaById(id)!.placeId)[0]!;
    expect(has(ids[0]!).fullLocal).toBe(false);
    expect(has(ids[1]!).fullLocal).toBe(true);
    expect(has(ids[2]!).fullLocal).toBe(true);
    for (const id of ids) expect(has(id).thumbLocal).toBe(true);
    expect(bob.engine.photos.usage().friends).toBeLessThanOrEqual(70_000);
    // A smaller cap: full photos first, then thumbnails; places stay.
    bob.engine.photos.setFriendsCacheBytes(10_000);
    for (const id of ids) expect(has(id).fullLocal).toBe(false);
    expect(bob.store.repo.savesForPlace(P1)).toHaveLength(1);
    // Opened again: downloaded again.
    expect(await bob.engine.photos.full(ids[0]!)).not.toBeNull();
  });

  it('the SQLite cache behaves like the memory one', () => {
    let t = 0;
    const c = new SqliteMediaCache(new NodeSqliteDriver(':memory:'), () => ++t);
    c.put('a', new Uint8Array(100), { owner: 'f', kind: 'full', mine: false, mime: 'image/webp' });
    c.put('b', new Uint8Array(100), { owner: 'f', kind: 'thumb', mine: false });
    c.put('c', new Uint8Array(100), { owner: 'f', kind: 'full', mine: false });
    c.put('m', new Uint8Array(500), { owner: 'me', kind: 'full', mine: true });
    expect(c.get('a')!.mime).toBe('image/webp'); // a is now the most recent
    expect(c.usage()).toEqual({ mine: 500, friends: 300, files: 4 });
    expect(c.evict(150)).toEqual(['c', 'a']); // full photos first, least recently used first
    expect(c.evict(0)).toEqual(['b']);
    expect(c.ids()).toEqual(['m']); // mine never evicted
    expect(c.ids({ owner: 'me', mine: true })).toEqual(['m']);
  });
});

describe('image metadata', () => {
  it('removes Exif and comments from JPEG, keeps JFIF and the image data', () => {
    const j = jpeg(500, 3, { exif: true });
    expect(imageMetadata(j)).toEqual(['exif', 'comment']);
    const s = stripImageMetadata(j);
    expect(imageMetadata(s)).toEqual([]);
    expect(has(s, 'GPSLatitude')).toBe(false);
    expect(has(s, 'JFIF')).toBe(true);
    expect(s.length).toBeLessThan(j.length);
    expect(stripImageMetadata(s)).toBe(s);
    expect(s.subarray(s.length - 2)).toEqual(new Uint8Array([0xff, 0xd9]));
  });

  it('removes EXIF and XMP chunks from WebP and clears their flags', () => {
    const w = webp(300, 2, { exif: true, xmp: true });
    expect(imageMetadata(w)).toEqual(['exif', 'xmp']);
    const s = stripImageMetadata(w);
    expect(imageMetadata(s)).toEqual([]);
    expect(has(s, 'GPS')).toBe(false);
    expect(s[20]! & 0x0c).toBe(0); // VP8X flags
    expect(new DataView(s.buffer).getUint32(4, true)).toBe(s.length - 8);
    expect(sniffImage(s)).toBe('image/webp');
  });

  it('reports an Exif item in AVIF and refuses unknown formats', () => {
    const box = (type: string, body: number[]) => {
      const n = body.length + 8;
      return [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...new TextEncoder().encode(type), ...body];
    };
    const infe = (t: string) => box('infe', [2, 0, 0, 0, 0, 1, 0, 0, ...new TextEncoder().encode(t), 0]);
    const avif = (items: string[]) =>
      new Uint8Array([...box('ftyp', [...new TextEncoder().encode('avifmif1')]), ...box('meta', [0, 0, 0, 0, ...box('iinf', [0, 0, 0, 0, 0, items.length, ...items.flatMap(infe)])])]);
    expect(sniffImage(avif(['av01']))).toBe('image/avif');
    expect(imageMetadata(avif(['av01']))).toEqual([]);
    expect(imageMetadata(avif(['av01', 'Exif']))).toEqual(['exif']);
    expect(() => imageMetadata(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a JPEG/);
  });

  it('photo references in a places payload are strict', () => {
    const ok = { id: 'abc', key: 'A'.repeat(43), full: `b2b256:${'B'.repeat(43)}`, thumb: `b2b256:${'C'.repeat(43)}`, type: 'image/webp', w: 1600, h: 1200, created: '2026-11-17T10:00:00.000Z' };
    expect(checkPhotoRefs([ok], false)).toHaveLength(1);
    expect(() => checkPhotoRefs([{ ...ok, url: 'https://x' }], false)).toThrow(/unknown field/);
    expect(checkPhotoRefs([{ ...ok, url: 'https://x' }], true)).toHaveLength(1);
    expect(() => checkPhotoRefs([{ ...ok, type: 'image/svg+xml' }], false)).toThrow(/type/);
    expect(() => checkPhotoRefs([ok, ok], false)).toThrow(/id/);
    expect(() => checkPhotoRefs([{ ...ok, thumb: ok.full }], false)).toThrow(/hash/);
    expect(() => checkPhotoRefs(Array.from({ length: 25 }, (_, i) => ({ ...ok, id: `p${i}` })), false)).toThrow(/bounded/);
  });
});
