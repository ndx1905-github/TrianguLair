// SPDX-License-Identifier: MPL-2.0
/** Personal photos (T-111b): publication, friends' thumbnails and full photos, removal, revocation, quota, cache, own devices. */
import { describe, expect, it } from 'vitest';
import { MemoryAdapter, StorageError, type StorageAdapter } from '@triangulair/storage';
import { foreignMediaId, saveIdFor } from '@triangulair/data';
import { NodeSqliteDriver } from '@triangulair/data/node';
import { MemoryMediaCache, SqliteMediaCache } from '../src/media-cache.ts';
import { ImageFormatError, imageMetadata, imageSize, sniffImage, stripImageMetadata } from '../src/image-meta.ts';
import { MAX_PHOTO_BYTES, MAX_PHOTO_SIDE, MAX_THUMB_BYTES, MAX_THUMB_SIDE, checkImage, checkPhotoRefs, imageHash, mediaFileBytes } from '../src/photos.ts';
import { DEFAULT_LIMITS } from '../src/limits.ts';
import { friendCacheId } from '../src/media-cache.ts';
import { PhotoError } from '../src/photo-service.ts';
import { addDevice, befriend, makeUser, point, World, type Device } from './helpers.ts';
import { has, jpeg, noise, photo, webp } from './photo-fixtures.ts';

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
/** The id a friend's device gives `owner`'s photo `id` on `placeId`. */
const fid = (owner: Device, id: string, placeId = P1) => foreignMediaId(saveIdFor(owner.user.owner, placeId), id);

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
    expect(seen[0]).toMatchObject({ id: fid(alice, id), mine: false, ownerId: alice.user.owner, state: 'friend', thumbLocal: true, fullLocal: false });
    // The full photo is downloaded only when opened.
    const full = await bob.engine.photos.full(fid(alice, id));
    expect(full!.bytes).toEqual(mine);
    expect(full!.mime).toBe('image/webp');
    expect(photosOf(bob)[0]!.fullLocal).toBe(true);
    const thumb = await bob.engine.photos.thumbnail(fid(alice, id));
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
    expect(wn.photos).toEqual([{ placeId: P1, mediaIds: [fid(alice, id)] }]);
    expect(wn.changed).toMatchObject([{ placeId: P1, meaningful: true, fields: ['photos'] }]);
  });

  it('private saves: the photo is uploaded for my devices only; my other device gets it', async () => {
    const { w, alice, bob } = await pair();
    alice.store.putSave({ place: point(2, 'Home'), sharing: 'private' });
    const id = alice.engine.photos.add('osm:node/2', photo(3));
    const id1 = alice.engine.photos.add(P1, photo(4));
    await alice.engine.sync();
    await bob.engine.sync();
    expect(bob.store.repo.mediaById(fid(alice, id, 'osm:node/2'))).toBeNull();
    expect(bob.store.repo.mediaById(fid(alice, id1))).not.toBeNull();

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
    await bob.engine.photos.full(fid(alice, id));
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
    expect(await bob.engine.photos.full(fid(alice, id))).toBeNull();
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
    const oldRef = bob.store.repo.mediaById(fid(alice, id))!.upload!;

    // Adding someone uploads nothing (the key only travels in the places pack).
    const dave = addDevice(w, makeUser(w, 'dave'));
    await dave.engine.sync();
    await befriend(w, alice, dave);
    const add = await alice.engine.sync();
    expect(add.own!.photos).toMatchObject({ uploaded: 0, renewed: 0 });
    await dave.engine.sync();
    expect(await dave.engine.photos.full(fid(alice, id))).not.toBeNull();

    alice.engine.setPolicy(bob.user.owner, { share: false });
    const r = await alice.engine.sync();
    expect(r.own!.photos).toMatchObject({ uploaded: 1, renewed: 1 });
    // The old files are gone: Bob, who still has the old reference (he has not synced), gets nothing.
    expect(await bob.engine.photos.full(fid(alice, id))).toBeNull();
    const old = await alice.user.storage.get(`media/b2b256-${oldRef.full.slice(7)}.bin`);
    expect(old).toBeNull();
    await bob.engine.sync();
    expect(photosOf(bob)).toEqual([]);
    expect(bob.engine.photos.cache.usage().friends).toBe(0);
    // Carol reads the photo under its new key.
    await carol.engine.sync();
    const ref = carol.store.repo.mediaById(fid(alice, id))!.upload!;
    expect(ref.key).not.toBe(oldRef.key);
    expect((await carol.engine.photos.full(fid(alice, id)))!.bytes).toEqual((await alice.engine.photos.full(id))!.bytes);
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
    expect(photosOf(bob).map((p) => p.id)).toEqual([fid(alice, id)]);
  });

  it('evicts friends\' full photos first, least recently used, and keeps their places', async () => {
    const { alice, bob } = await pair({ bobCache: 70_000 });
    for (let i = 2; i <= 4; i++) alice.store.putSave({ place: point(i, `P${i}`) });
    const ids = [1, 2, 3, 4].map((i) => fid(alice, alice.engine.photos.add(`osm:node/${i}`, photo(10 + i, { size: 30_000 })), `osm:node/${i}`));
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

/** Puts a photo in `d`'s document as a modified app could (no checks of `Photos.add`), with its images. */
function rawPhoto(d: Device, placeId: string, full: Uint8Array, thumb: Uint8Array, opts: { id?: string } = {}): string {
  const file = imageHash(full);
  const th = imageHash(thumb);
  d.engine.photos.cache.put(file, full, { owner: d.user.owner, kind: 'full', mine: true, mime: 'image/webp' });
  d.engine.photos.cache.put(th, thumb, { owner: d.user.owner, kind: 'thumb', mine: true, mime: 'image/webp' });
  return d.store.addMedia(placeId, { ...(opts.id && { id: opts.id }), file, thumb: th, mime: 'image/webp', bytes: full.length, width: 1600, height: 1200 });
}

describe('photos: hostile friends (review photos)', () => {
  it('F-01: a friend reusing another friend\'s (or my) photo id breaks no read and shows nobody else\'s photo', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    const mallory = addDevice(w, makeUser(w, 'mallory'));
    for (const d of [alice, mallory]) d.store.putSave({ place: point(1, 'Chez Lili') });
    bob.store.putSave({ place: point(1, 'Chez Lili') });
    await Promise.all([alice.engine.sync(), bob.engine.sync(), mallory.engine.sync()]);
    await befriend(w, alice, bob);
    await befriend(w, mallory, bob, { mutual: true });
    const mine = bob.engine.photos.add(P1, photo(30));
    await bob.engine.sync();
    await mallory.engine.sync();
    const id = alice.engine.photos.add(P1, photo(31));
    await alice.engine.sync();
    // Mallory publishes photos with Alice's id and Bob's id (seen in Bob's places pack).
    rawPhoto(mallory, P1, webp(20_000, 32), webp(2_000, 33, { width: 400, height: 300 }), { id });
    rawPhoto(mallory, P1, webp(20_000, 34), webp(2_000, 35, { width: 400, height: 300 }), { id: mine });
    await mallory.engine.sync();
    // Mallory read first, then Alice: both reads succeed, every photo keeps its author.
    const r1 = await bob.engine.sync();
    expect(r1.ok).toBe(true);
    const byOwner = (o: Device) => photosOf(bob).filter((p) => p.ownerId === o.user.owner);
    expect(byOwner(alice)).toHaveLength(1);
    expect(byOwner(mallory)).toHaveLength(2);
    expect(photosOf(bob).filter((p) => p.mine).map((p) => p.id)).toEqual([mine]);
    expect((await bob.engine.photos.full(fid(alice, id)))!.bytes).toEqual((await alice.engine.photos.full(id))!.bytes);
    expect((await bob.engine.photos.full(mine))!.bytes).toEqual(photo(30).full);
    // A new device of Bob's whose own pull fails at first: Mallory's copy of Bob's id cannot block Bob's photo.
    const bob2 = addDevice(w, bob.user);
    await bob2.engine.sync({ publish: false });
    expect(bob2.engine.photos.list(P1).filter((p) => p.mine).map((p) => p.id)).toEqual([mine]);
  });

  it('F-02: a friend serving broken thumbnails cannot make one pass download without bound', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'), { limits: { thumbPrefetchBytes: 256 * 1024 } });
    for (let i = 1; i <= 8; i++) alice.store.putSave({ place: point(i, `P${i}`) });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    for (let i = 1; i <= 8; i++) alice.engine.photos.add(`osm:node/${i}`, photo(40 + i));
    await alice.engine.sync();
    // Alice's host (or Alice) now answers every media file with junk.
    const inner = alice.user.storage;
    let mediaGets = 0;
    w.storages.set(alice.user.location, {
      ...inner,
      capabilities: inner.capabilities,
      get: async (p, o) => {
        if (!p.startsWith('media/')) return inner.get(p, o);
        mediaGets++;
        return { data: noise(4096, mediaGets), etag: 'x' };
      },
      head: (p) => inner.head(p),
      put: (p, d, o) => inner.put(p, d, o),
      delete: (p, o) => inner.delete(p, o),
      list: (p) => inner.list(p),
    } as StorageAdapter);
    const r = await bob.engine.sync();
    expect(r.photos?.thumbnails ?? 0).toBe(0);
    expect(mediaGets).toBe(2); // 256 KiB / 128 KiB counted per failed file
    expect(photosOf(bob, 'osm:node/1')[0]).toMatchObject({ thumbLocal: false });
  });

  it('F-03: an image that declares a huge size is refused before it is cached or shown', async () => {
    const { alice, bob } = await pair();
    // Photos.add refuses it…
    expect(() => alice.engine.photos.add(P1, { ...photo(50), thumb: webp(2_000, 51, { width: 400, height: 300, canvas: [16_000, 16_000] }) })).toThrow(/too large/);
    expect(() => alice.engine.photos.add(P1, { ...photo(50), full: webp(20_000, 52, { canvas: [9_000, 9_000] }) })).toThrow(/too large/);
    // …a modified app publishes it anyway.
    const bomb = rawPhoto(alice, P1, webp(20_000, 53, { canvas: [9_000, 9_000] }), webp(2_000, 54, { canvas: [16_000, 16_000] }));
    await alice.engine.sync();
    const r = await bob.engine.sync();
    expect(r.ok).toBe(true);
    expect(r.photos?.thumbnails ?? 0).toBe(0);
    await expect(bob.engine.photos.thumbnail(fid(alice, bomb))).rejects.toThrow(ImageFormatError);
    await expect(bob.engine.photos.full(fid(alice, bomb))).rejects.toThrow(/too large/);
    expect(bob.engine.photos.cache.usage().friends).toBe(0);
    // An image of another format than its reference says is refused too.
    expect(() => checkImage(jpeg(100), 'full', 'image/webp')).toThrow(/announced/);
  });

  it('F-06: a photo near the byte cap reaches friends and my other devices (padding counted)', async () => {
    const { w, alice, bob } = await pair();
    const big = { ...photo(60), full: webp(MAX_PHOTO_BYTES - 64, 60), thumb: webp(MAX_THUMB_BYTES - 64, 61, { width: 400, height: 300 }) };
    const id = alice.engine.photos.add(P1, big);
    await alice.engine.sync();
    await bob.engine.sync();
    expect((await bob.engine.photos.full(fid(alice, id)))!.bytes.length).toBe(big.full.length);
    const alice2 = addDevice(w, alice.user);
    await alice2.engine.sync();
    for (const k of alice2.engine.photos.cache.ids()) alice2.engine.photos.cache.delete(k);
    expect((await alice2.engine.photos.full(id))!.bytes.length).toBe(big.full.length);
    expect((await alice2.engine.photos.thumbnail(id))!.bytes.length).toBe(big.thumb.length);
    expect(mediaFileBytes(8 * 1024 * 1024)).toBeGreaterThan(8_651_151);
  });
});

describe('image metadata and size (review photos)', () => {
  it('F-05: JPEG: MPF and what follows the end of the image are removed, an ICC profile is kept', () => {
    const j = jpeg(500, 7, { mpf: true, icc: true });
    expect(imageMetadata(j)).toEqual(['other', 'trailer']);
    const s = stripImageMetadata(j);
    expect(imageMetadata(s)).toEqual([]);
    expect(has(s, 'MPF')).toBe(false);
    expect(has(s, 'GPSLatitude')).toBe(false);
    expect(has(s, 'ICC_PROFILE')).toBe(true);
    expect(s.subarray(s.length - 2)).toEqual(new Uint8Array([0xff, 0xd9]));
    expect(imageSize(s)).toEqual({ width: 1600, height: 1200 });
  });

  it('F-05: JPEG: metadata between the scans of a progressive JPEG is removed', () => {
    const j = jpeg(300, 8);
    const exif = [...new TextEncoder().encode('Exif\0\0MM GPSLatitud')];
    const app1 = [0xff, 0xe1, 0, exif.length + 2, ...exif];
    const sos = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0];
    const tail = j.length - 2; // before EOI
    const p = new Uint8Array([...j.subarray(0, tail), ...app1, ...sos, 1, 2, 3, 0xff, 0x00, 4, 0xff, 0xd9]);
    expect(imageMetadata(p)).toEqual(['exif']);
    const s = stripImageMetadata(p);
    expect(imageMetadata(s)).toEqual([]);
    expect(has(s, 'GPSLatitud')).toBe(false);
    expect(s.length).toBe(p.length - app1.length);
  });

  it('WebP: chunks the format does not define are removed too', () => {
    const w = webp(300, 9);
    const extra = [...new TextEncoder().encode('GPS '), 6, 0, 0, 0, ...new TextEncoder().encode('48.85N')];
    const body = [...w.subarray(12), ...extra];
    const x = new Uint8Array([...w.subarray(0, 4), (body.length + 4) & 255, ((body.length + 4) >> 8) & 255, 0, 0, ...w.subarray(8, 12), ...body]);
    expect(imageMetadata(x)).toEqual(['other']);
    const s = stripImageMetadata(x);
    expect(s).toEqual(w);
    expect(imageMetadata(s)).toEqual([]);
  });

  it('imageSize reads JPEG, WebP (VP8X, VP8, VP8L) and AVIF headers', () => {
    expect(imageSize(jpeg(100, 1, { width: 640, height: 480 }))).toEqual({ width: 640, height: 480 });
    expect(imageSize(webp(100, 1, { width: 300, height: 200 }))).toEqual({ width: 300, height: 200 });
    expect(imageSize(webp(100, 1, { width: 300, height: 200, canvas: [12_000, 20] }))).toEqual({ width: 12_000, height: 200 });
    // Simple lossy WebP (VP8 chunk only).
    const vp8 = [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01];
    const body = [...new TextEncoder().encode('WEBPVP8 '), vp8.length, 0, 0, 0, ...vp8];
    const lossy = new Uint8Array([...new TextEncoder().encode('RIFF'), body.length, 0, 0, 0, ...body]);
    expect(imageSize(lossy)).toEqual({ width: 640, height: 480 });
    const box = (type: string, b: number[]) => {
      const n = b.length + 8;
      return [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...new TextEncoder().encode(type), ...b];
    };
    const u32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    const avif = new Uint8Array([...box('ftyp', [...new TextEncoder().encode('avifmif1')]), ...box('meta', [0, 0, 0, 0, ...box('iprp', box('ipco', box('ispe', [0, 0, 0, 0, ...u32(1600), ...u32(900)])))])]);
    expect(imageSize(avif)).toEqual({ width: 1600, height: 900 });
    expect(() => imageSize(new Uint8Array([...box('ftyp', [...new TextEncoder().encode('avifmif1')])]))).toThrow(/size/);
    expect(() => checkImage(webp(100, 1, { width: 2000, height: 100 }), 'thumb')).toThrow(/too large/);
    expect(checkImage(webp(100, 1, { width: 500, height: 100 }), 'thumb')).toMatchObject({ mime: 'image/webp', width: 500 });
  });
});

describe('photos: trash and visibility (review photos)', () => {
  it('a trashed place takes its photos from friends; restored they come back; purged their files and copies go', async () => {
    const { w, alice, bob } = await pair();
    const id = alice.engine.photos.add(P1, photo(70));
    await alice.engine.sync();
    await bob.engine.sync();
    const files = await mediaFiles(alice);
    alice.store.deleteSave(P1);
    await alice.engine.sync();
    await bob.engine.sync();
    expect(photosOf(bob)).toEqual([]);
    expect(bob.engine.photos.cache.usage().friends).toBe(0);
    expect(alice.engine.photos.list(P1)).toEqual([]); // not shown while in the trash
    // Kept on my storage and on my devices while restorable.
    expect((await mediaFiles(alice)).filter((f) => files.includes(f)).length).toBeGreaterThanOrEqual(2);
    expect(alice.engine.photos.cache.usage().mine).toBeGreaterThan(0);

    alice.store.restoreSave(P1);
    const r = await alice.engine.sync();
    expect(r.own!.photos.renewed).toBe(0); // same readers
    await bob.engine.sync();
    expect((await bob.engine.photos.full(fid(alice, id)))!.bytes).toEqual((await alice.engine.photos.full(id))!.bytes);

    // Trashed, then a reader removed while in the trash: restored, the photo is re-sealed.
    alice.store.deleteSave(P1);
    await alice.engine.sync();
    alice.engine.setPolicy(bob.user.owner, { share: false });
    await alice.engine.sync();
    alice.store.restoreSave(P1);
    expect((await alice.engine.sync()).own!.photos.renewed).toBe(1);

    // Purged: the files leave my storage and the local copies go.
    const alice2 = addDevice(w, alice.user);
    await alice2.engine.sync();
    const u = alice.store.repo.mediaById(id)!.upload!;
    const paths = [u.full, u.thumb].map((h) => `media/b2b256-${h.slice(7)}.bin`);
    expect((await mediaFiles(alice)).filter((f) => paths.includes(f))).toHaveLength(2);
    alice.store.deleteSave(P1);
    alice.store.purgeTrash({ kind: 'save', id: P1 }); // "Delete forever"
    const p = await alice.engine.sync();
    expect(p.own!.filesDeleted).toBeGreaterThanOrEqual(2);
    expect((await mediaFiles(alice)).filter((f) => paths.includes(f))).toEqual([]);
    expect(alice.engine.photos.cache.usage().mine).toBe(0);
    await alice2.engine.sync();
    expect(alice2.engine.photos.cache.usage().mine).toBe(0);
  });
});

describe('photos: product decisions after the review', () => {
  it('caps: 2,048 px and 1.5 MiB for a photo, 512 px and 128 KiB for a thumbnail; the default limits are the caps', () => {
    expect([MAX_PHOTO_SIDE, MAX_THUMB_SIDE, MAX_PHOTO_BYTES, MAX_THUMB_BYTES]).toEqual([2048, 512, 1536 * 1024, 128 * 1024]);
    expect(DEFAULT_LIMITS.photoBytes).toBe(MAX_PHOTO_BYTES);
    expect(DEFAULT_LIMITS.thumbBytes).toBe(MAX_THUMB_BYTES);
    expect(checkImage(webp(100, 1, { width: 2048, height: 1536 }), 'full')).toMatchObject({ width: 2048 });
    expect(() => checkImage(webp(100, 1, { width: 2049, height: 1536 }), 'full')).toThrow(/too large/);
    expect(checkImage(webp(100, 1, { width: 512, height: 512 }), 'thumb')).toMatchObject({ width: 512 });
    expect(() => checkImage(webp(100, 1, { width: 400, height: 513 }), 'thumb')).toThrow(/too large/);
    // A reference announcing a size over the cap is refused with the payload.
    const ok = { id: 'abc', key: 'A'.repeat(43), full: `b2b256:${'B'.repeat(43)}`, thumb: `b2b256:${'C'.repeat(43)}`, type: 'image/webp', w: 2048, h: 1200, created: '2026-11-17T10:00:00.000Z' };
    expect(checkPhotoRefs([ok], false)).toHaveLength(1);
    expect(() => checkPhotoRefs([{ ...ok, w: 2049 }], false)).toThrow(/size/);
  });

  it('caps: a friend\'s oversized files are refused by the reader, and nothing is cached', async () => {
    const { alice, bob } = await pair();
    // A modified app of Alice's publishes files over the caps (Photos.add would refuse them).
    const heavy = rawPhoto(alice, P1, webp(MAX_PHOTO_BYTES + 8192, 80), webp(MAX_THUMB_BYTES + 8192, 81, { width: 400, height: 300 }));
    const wide = rawPhoto(alice, 'osm:node/1', webp(20_000, 82, { width: 4000, height: 3000 }), webp(2_000, 83, { width: 800, height: 600 }));
    await alice.engine.sync();
    const r = await bob.engine.sync();
    expect(r.ok).toBe(true);
    expect(r.photos?.thumbnails ?? 0).toBe(0);
    for (const id of [heavy, wide]) {
      await expect(bob.engine.photos.thumbnail(fid(alice, id))).rejects.toThrow();
      await expect(bob.engine.photos.full(fid(alice, id))).rejects.toThrow();
    }
    expect(bob.engine.photos.cache.usage().friends).toBe(0);
  });

  it('F-07: a renewal that cannot get the image (stale index, no local copy) drops the photo cleanly everywhere, once', async () => {
    const mem = new MemoryAdapter();
    const { w, alice, bob } = await pair({ aliceStorage: mem });
    const id = alice.engine.photos.add(P1, photo(90));
    await alice.engine.sync();
    await bob.engine.sync();
    await bob.engine.photos.full(fid(alice, id));
    expect(bob.engine.photos.cache.usage().friends).toBeGreaterThan(0);
    const alice2 = addDevice(w, alice.user, { media: new MemoryMediaCache() });
    await alice2.engine.sync();
    for (const k of alice2.engine.photos.cache.ids()) alice2.engine.photos.cache.delete(k);
    // The storage rolls back to an older index (the photo is listed there under its key).
    const old = (await mem.get('index.json'))!.data;
    alice.store.updateSave(P1, { comment: 'newer' });
    await alice.engine.sync();
    await alice2.engine.sync({ publish: false });
    for (const k of alice2.engine.photos.cache.ids()) alice2.engine.photos.cache.delete(k);
    mem.putUnchecked('index.json', old);
    // Bob loses access while alice2 cannot fetch the image through the stale index.
    alice2.engine.setPolicy(bob.user.owner, { share: false });
    const r = await alice2.engine.sync();
    expect(r.own!.pull.rolledBack).toBe(true);
    expect(r.own!.photos).toMatchObject({ dropped: 1, waiting: 0, uploaded: 0 });
    expect(r.problems).toEqual([]);
    // As if it had never been there: no row, no copy, nothing waiting, nothing retried.
    expect(alice2.engine.photos.list(P1)).toEqual([]);
    expect(alice2.store.repo.mediaById(id)).toBeNull();
    expect(alice2.store.repo.getMySaveForPlace(P1)!.comment).toBe('newer');
    const again = await alice2.engine.sync();
    expect(again.own!.photos).toMatchObject({ dropped: 0, waiting: 0, uploaded: 0, renewed: 0 });
    // The other device forgets it too, and its files leave the storage.
    await alice.engine.sync();
    expect(alice.engine.photos.list(P1)).toEqual([]);
    expect(alice.engine.photos.cache.ids()).toEqual([]);
    const u = bob.store.repo.mediaById(fid(alice, id))!.upload!;
    expect(await mem.head(`media/b2b256-${u.full.slice(7)}.bin`)).toBeNull();
    // The friend who lost access purges what they had of it.
    await bob.engine.sync();
    expect(photosOf(bob)).toEqual([]);
    expect(bob.store.repo.mediaById(fid(alice, id))).toBeNull();
    expect(bob.engine.photos.cache.ids()).toEqual([]);
  });

  it('F-08: a friend naming one of my file hashes gets another cache entry; mine is never replaced', async () => {
    const { alice, bob } = await pair();
    bob.store.putSave({ place: point(1, 'Chez Lili') });
    const mine = bob.engine.photos.add(P1, photo(95));
    const m = bob.store.repo.mediaById(mine)!;
    await alice.engine.sync();
    await bob.engine.sync();
    // A forged reference of Alice's naming Bob's local ids as her files.
    const forged = { key: 'A'.repeat(43), full: m.file, thumb: m.thumb! };
    bob.store.repo.setForeignMedia(saveIdFor(alice.user.owner, P1), [
      { id: 'forged', file: forged.full, thumb: forged.thumb, mime: 'image/webp', bytes: null, upload: forged, blurhash: null, width: 1600, height: 1200, createdAt: 1 },
    ]);
    const theirs = bob.engine.photos.list(P1).find((p) => !p.mine)!;
    expect(theirs).toMatchObject({ thumbLocal: false, fullLocal: false });
    expect(await bob.engine.photos.full(theirs.id)).toBeNull(); // not on her storage: nothing of mine is shown as hers
    // A friend's entry under one of my ids is ignored; prune and eviction keep mine.
    bob.engine.photos.cache.put(m.file, new Uint8Array(10), { owner: alice.user.owner, kind: 'full', mine: false });
    bob.engine.photos.prune();
    bob.engine.photos.setFriendsCacheBytes(0);
    expect((await bob.engine.photos.full(mine))!.bytes).toEqual(photo(95).full);
    expect(bob.engine.photos.cache.ids({ mine: true }).sort()).toEqual([m.file, m.thumb!].sort());
    const sql = new SqliteMediaCache(new NodeSqliteDriver(':memory:'));
    sql.put('h', new Uint8Array(5), { owner: 'me', kind: 'full', mine: true });
    sql.put('h', new Uint8Array(1), { owner: 'f', kind: 'full', mine: false });
    expect(sql.get('h')!.bytes.length).toBe(5);
    expect(friendCacheId('f', 'b2b256:x')).toBe('f|b2b256:x');
  });

  it('a friend\'s cache ids carry the owner; removing the friend erases them', async () => {
    const { alice, bob } = await pair();
    const id = alice.engine.photos.add(P1, photo(96));
    await alice.engine.sync();
    await bob.engine.sync();
    await bob.engine.photos.full(fid(alice, id));
    const ids = bob.engine.photos.cache.ids({ owner: alice.user.owner });
    expect(ids).toHaveLength(2);
    for (const k of ids) expect(k.startsWith(`${alice.user.owner}|b2b256:`)).toBe(true);
    bob.engine.removeContact(alice.user.owner);
    expect(bob.engine.photos.cache.ids()).toEqual([]);
    expect(bob.store.repo.mediaById(fid(alice, id))).toBeNull();
  });

  for (const how of ['removed as a contact', 'content deleted', 'save made private'] as const) {
    it(`a friend whose access is gone (${how}) purges every thumbnail, full photo and cache row of mine`, async () => {
      const { alice, bob } = await pair();
      alice.store.putSave({ place: point(2, 'P2') });
      const a = alice.engine.photos.add(P1, photo(97));
      const b = alice.engine.photos.add('osm:node/2', photo(98));
      await alice.engine.sync();
      await bob.engine.sync();
      await bob.engine.photos.full(fid(alice, a)); // one full photo opened, both thumbnails prefetched
      expect(bob.engine.photos.cache.ids({ owner: alice.user.owner })).toHaveLength(3);
      if (how === 'removed as a contact') alice.engine.removeContact(bob.user.owner);
      else if (how === 'save made private') for (const p of [P1, 'osm:node/2']) alice.store.updateSave(p, { sharing: 'private' });
      else {
        // "Delete all my content": the document emptied, the publication lists nothing for anyone.
        for (const p of [P1, 'osm:node/2']) alice.store.deleteSave(p);
        for (const p of [P1, 'osm:node/2']) alice.store.purgeTrash({ kind: 'save', id: p });
      }
      expect((await alice.engine.sync()).ok).toBe(true);
      const r = await bob.engine.sync();
      expect(r.ok).toBe(true);
      expect(bob.store.repo.savesForPlace(P1).filter((s) => s.ownerId === alice.user.owner)).toEqual([]);
      for (const id of [a, b]) expect(bob.store.repo.mediaById(fid(alice, id, id === a ? P1 : 'osm:node/2'))).toBeNull();
      expect(bob.store.repo.db.get<{ n: number }>(`SELECT count(*) AS n FROM media`)!.n).toBe(0);
      expect(bob.engine.photos.cache.ids()).toEqual([]);
      expect(bob.engine.photos.usage().friends).toBe(0);
    });
  }
});
