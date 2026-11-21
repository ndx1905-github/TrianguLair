import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { ready } from '@triangulair/crypto';
import { DataStore, foreignMediaId, saveIdFor } from '@triangulair/data';
import { MemoryAdapter, StorageError, type StorageAdapter } from '@triangulair/storage';
import { SqliteStateStore, imageMetadata, type FriendReport } from '@triangulair/sync';
import { applyImport, buildPlan, exportArchive, matchPlaces, readImportFile } from '@triangulair/import';

import { SqlJsDriver } from '../data/sqljsDriver';
import { createIdentity } from '../identity/create';
import { rotateStoredSharingKey } from '../storage/certify';
import type { StorageConfig } from '../storage/config';
import type { StorageAccess } from '../storage/interfaces';
import { SyncController } from '../sync/controller';
import { openSyncKeys } from '../sync/keys';
import { WhatsNewLog, filterEntries } from '../sync/whatsNew';
import { MAX_PHOTO_BYTES, MAX_PHOTO_SIDE, MAX_THUMB_BYTES, MAX_THUMB_SIDE } from '@triangulair/sync';
import { CACHE_CAPS_MB, DEFAULT_CACHE_MB, MIN_QUALITY, QUALITY, cacheCapMb, dataUri, encodeToFit, fitSize, fromBase64, photoQuality, setCacheCapMb, setPhotoQuality, toBase64, waitingReason } from './model';

await ready();
const SQL = await initSqlJs();

describe('photo sizes and settings', () => {
  it('fits the longest side, never enlarges', () => {
    expect(fitSize(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitSize(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(10000, 10, 400)).toEqual({ width: 400, height: 1 });
    expect(() => fitSize(0, 10, 400)).toThrow();
    expect(QUALITY.standard.side).toBe(1600);
    expect(QUALITY.saver.side).toBeLessThan(QUALITY.standard.side);
  });

  it('base64 round trip and data URIs', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 1000]) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      expect(fromBase64(toBase64(b))).toEqual(b);
      expect(toBase64(b)).toBe(Buffer.from(b).toString('base64'));
    }
    expect(dataUri(new Uint8Array([1, 2, 3]), 'image/webp')).toBe('data:image/webp;base64,AQID');
  });

  it('quality and cache size are kept per device, with defaults', () => {
    expect(photoQuality()).toBe('standard');
    setPhotoQuality('saver');
    expect(photoQuality()).toBe('saver');
    expect(cacheCapMb()).toBe(DEFAULT_CACHE_MB);
    setCacheCapMb(CACHE_CAPS_MB[0]!);
    expect(cacheCapMb()).toBe(CACHE_CAPS_MB[0]);
    expect(() => setCacheCapMb(3)).toThrow();
    expect(waitingReason({ hasStorage: false, quota: true })).toBe('local');
    expect(waitingReason({ hasStorage: true, quota: true })).toBe('quota');
  });
});

describe('photos are made to fit the caps, never refused for their size', () => {
  /** A fake encoder: the file size grows with the area and the quality, like a real one. */
  const fake = (bytesPerPx: number, w = 4032, h = 3024) => {
    const calls: { side: number; quality: number }[] = [];
    const encode = async (side: number, quality: number) => {
      calls.push({ side, quality });
      const s = fitSize(w, h, side);
      return { bytes: new Uint8Array(Math.ceil(s.width * s.height * bytesPerPx * quality)), ...s };
    };
    return { encode, calls };
  };

  it('keeps the setting when the result already fits', async () => {
    const f = fake(0.1);
    const out = await encodeToFit(f.encode, { side: QUALITY.standard.side, quality: QUALITY.standard.quality, maxSide: MAX_PHOTO_SIDE, maxBytes: MAX_PHOTO_BYTES });
    expect(f.calls).toEqual([{ side: 1600, quality: 0.8 }]);
    expect(out).toMatchObject({ width: 1600, height: 1200 });
  });

  it('lowers the quality step by step, then the size, until the file fits the byte cap', async () => {
    const f = fake(1.2); // 1600 × 1200 at 0.8: 1.8 MB, over 1.5 MiB
    const out = await encodeToFit(f.encode, { side: 1600, quality: 0.8, maxSide: MAX_PHOTO_SIDE, maxBytes: MAX_PHOTO_BYTES });
    expect(out.bytes.length).toBeLessThanOrEqual(MAX_PHOTO_BYTES);
    expect(f.calls[0]).toEqual({ side: 1600, quality: 0.8 });
    expect(f.calls[1]).toEqual({ side: 1600, quality: 0.7 });
    expect(out.width).toBe(1600); // fitted by quality alone

    const g = fake(8); // far too heavy even at the lowest quality: the size goes down too
    const small = await encodeToFit(g.encode, { side: 400, quality: 0.6, maxSide: MAX_THUMB_SIDE, maxBytes: MAX_THUMB_BYTES });
    expect(small.bytes.length).toBeLessThanOrEqual(MAX_THUMB_BYTES);
    expect(small.width).toBeLessThan(400);
    expect(g.calls.some((c) => c.quality === MIN_QUALITY && c.side === 400)).toBe(true);
    expect(Math.min(...g.calls.map((c) => c.quality))).toBe(MIN_QUALITY);
  });

  it('never goes over the side caps, whatever the setting', async () => {
    const f = fake(0.01, 8000, 6000);
    const out = await encodeToFit(f.encode, { side: 5000, quality: 0.9, maxSide: MAX_PHOTO_SIDE, maxBytes: MAX_PHOTO_BYTES });
    expect(out.width).toBe(MAX_PHOTO_SIDE);
    expect(QUALITY.standard.side).toBeLessThanOrEqual(MAX_PHOTO_SIDE);
    expect(QUALITY.standard.thumbSide).toBeLessThanOrEqual(MAX_THUMB_SIDE);
  });
});

describe("What's new: new photo", () => {
  it('records new photos on a place already there, filterable as photos', () => {
    const kv = new Map<string, unknown>();
    const log = new WhatsNewLog({ get: <T,>(k: string) => kv.get(k) as T, set: (k, v) => void kv.set(k, v) });
    const report: FriendReport = {
      owner: 'ed25519:lea',
      status: 'updated',
      whatsNew: { added: [], changed: [{ placeId: 'osm:node/1', meaningful: true, fields: ['photos'] }], removed: [], photos: [{ placeId: 'osm:node/1', mediaIds: ['m1', 'm2'] }] },
      downloaded: { packs: 1, bytes: 1 },
    };
    const fresh = log.record([report], { now: 5, firstRead: new Set(), placeName: () => 'Chez Lili', theirSave: () => ({ comment: '', status: null }) });
    expect(fresh).toMatchObject([{ kind: 'photo', placeId: 'osm:node/1', name: 'Chez Lili', count: 2, mediaIds: ['m1', 'm2'] }]);
    expect(filterEntries(log.entries(), { type: 'photos', owner: null })).toHaveLength(1);
    expect(filterEntries(log.entries(), { type: 'comments', owner: null })).toHaveLength(0);
  });
});

describe("What's new: photos that are gone", () => {
  it('leave What\'s new as if they had never been added', () => {
    const kv = new Map<string, unknown>();
    const log = new WhatsNewLog({ get: <T,>(k: string) => kv.get(k) as T, set: (k, v) => void kv.set(k, v) });
    const report = (placeId: string, mediaIds: string[]): FriendReport => ({
      owner: 'ed25519:lea',
      status: 'updated',
      whatsNew: { added: [], changed: [{ placeId, meaningful: true, fields: ['photos'] }], removed: [], photos: [{ placeId, mediaIds }] },
      downloaded: { packs: 1, bytes: 1 },
    });
    const ctx = { now: 5, firstRead: new Set<string>(), placeName: () => 'Chez Lili', theirSave: () => ({ comment: '', status: null }) };
    log.record([report('osm:node/1', ['m1', 'm2']), report('osm:node/2', ['m3'])], ctx);
    const alive = new Set(['m2']);
    expect(log.prunePhotos((id) => alive.has(id))).toBe(true);
    expect(log.entries()).toMatchObject([{ kind: 'photo', placeId: 'osm:node/1', count: 1, mediaIds: ['m2'] }]);
    expect(log.entries()).toHaveLength(1);
    expect(log.prunePhotos((id) => alive.has(id))).toBe(false);
  });
});

// ------------------------------------------------------------------ controller, two people

const world = new Map<string, StorageAdapter>();
const readAdapter = (loc: string) => {
  const a = world.get(loc);
  if (!a) throw new StorageError('NETWORK', `no server at ${loc}`);
  return a;
};
let ids = 0;

function makeUser(name: string) {
  const created = createIdentity({ primary: true });
  const location = `https://${name}.example/tl/`;
  const rot = rotateStoredSharingKey(created.record, created.secrets, { location }, { kind: 'primary' });
  const storage = new MemoryAdapter();
  world.set(location, storage);
  const driver = new SqlJsDriver(new SQL.Database());
  const store = DataStore.open({ driver, meId: created.record.owner, actor: (++ids).toString(16).padStart(32, '0'), newId: () => `id${++ids}` });
  const config = { kind: 'webdav', flavor: 'generic', url: `${location}dav/`, username: 'u', password: 'p', readUrl: location, conditionalWrites: true } as StorageConfig;
  const access: StorageAccess = {
    config: () => config,
    writeAdapter: () => storage,
    readAdapter: () => storage,
    readAddress: () => location,
    redirects: () => [],
    republishPending: () => false,
    markRepublished: async () => {},
  };
  const ctl = new SyncController({
    store,
    state: new SqliteStateStore(driver),
    loadKeys: async () => openSyncKeys(created.record, { deviceKeys: created.secrets.deviceKeys, sharingKey: rot.sealedForThisDevice, syncKeys: null }),
    saveKeys: async () => {},
    access,
    readAdapter,
    wipe: { secrets: async () => {}, data: async () => store.wipe() },
    onData: () => {},
    onChange: () => {},
    author: () => name,
  });
  return { name, owner: created.record.owner, location, storage, store, driver, ctl };
}

/** A WebP container (EXIF with GPS when asked) around noise. */
function webp(size: number, seed: number, exif = false): Uint8Array {
  const enc = new TextEncoder();
  const le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const chunk = (id: string, d: Uint8Array) => [...enc.encode(id), ...le(d.length), ...d, ...(d.length & 1 ? [0] : [])];
  const vp8x = new Uint8Array(10);
  vp8x[0] = exif ? 8 : 0;
  const noise = new Uint8Array(size).map((_, i) => (i * 131 + seed * 7) ^ (i >> 3));
  const body = [...enc.encode('WEBP'), ...chunk('VP8X', vp8x), ...(exif ? chunk('EXIF', enc.encode('Exif\0\0GPSLatitude 48.85')) : []), ...chunk('VP8L', noise)];
  return new Uint8Array([...enc.encode('RIFF'), ...le(body.length), ...body]);
}

describe('photos through the sync controller (sql.js database)', () => {
  it('Anna adds a photo, Ben sees the thumbnail, opens the full photo; Anna removes it', async () => {
    const anna = makeUser('anna');
    const ben = makeUser('ben');
    anna.store.putSave({ place: { osm: { type: 'node', id: 1 }, name: 'Chez Lili', category: 'amenity=restaurant', geometry: { type: 'Point', coordinates: [2.35, 48.85] } } });
    await anna.ctl.refresh();
    await ben.ctl.refresh();
    await ben.ctl.addContact({ location: anna.location, owner: anna.owner, name: 'Anna', follow: true, share: false });
    await anna.ctl.addContact({ location: ben.location, name: 'Ben', follow: false, share: true });

    const photos = (await anna.ctl.photos())!;
    const id = photos.add('osm:node/1', { full: webp(30_000, 1, true), thumb: webp(3_000, 2), width: 1600, height: 1200 });
    const local = await photos.full(id);
    expect(imageMetadata(local!.bytes)).toEqual([]);
    // Kept in the database itself (media_cache), covered by its protection and by the wipe.
    expect(anna.driver.get<{ n: number }>(`SELECT count(*) AS n FROM media_cache`)!.n).toBe(2);
    await anna.ctl.refresh();
    expect(photos.list('osm:node/1')[0]!.state).toBe('uploaded');

    await ben.ctl.refresh();
    const theirs = (await ben.ctl.photos())!;
    const item = theirs.list('osm:node/1')[0]!;
    // A friend's photo id is kept inside the id of their save (review photos F-01).
    const theirId = foreignMediaId(saveIdFor(anna.owner, 'osm:node/1'), id);
    expect(item).toMatchObject({ id: theirId, mine: false, ownerId: anna.owner, thumbLocal: true, fullLocal: false });
    expect((await theirs.full(theirId))!.bytes).toEqual(local!.bytes);
    expect(theirs.list('osm:node/1')[0]!.fullLocal).toBe(true);
    expect(theirs.usage().friends).toBeGreaterThan(30_000);

    photos.remove('osm:node/1', id);
    await anna.ctl.refresh();
    await ben.ctl.refresh();
    expect(theirs.list('osm:node/1')).toEqual([]);
    expect(theirs.usage().friends).toBe(0);
  });

  it('"Delete all my content" deletes the photo files on my storage, the friend\'s copy and my local copies', async () => {
    const anna = makeUser('anna2');
    const ben = makeUser('ben2');
    anna.store.putSave({ place: { osm: { type: 'node', id: 1 }, name: 'Chez Lili', category: 'amenity=restaurant', geometry: { type: 'Point', coordinates: [2.35, 48.85] } } });
    await anna.ctl.refresh();
    await ben.ctl.refresh();
    await ben.ctl.addContact({ location: anna.location, owner: anna.owner, name: 'Anna', follow: true, share: false });
    await anna.ctl.addContact({ location: ben.location, name: 'Ben', follow: false, share: true });
    const photos = (await anna.ctl.photos())!;
    const id = photos.add('osm:node/1', { full: webp(30_000, 3), thumb: webp(3_000, 4), width: 1600, height: 1200 });
    await anna.ctl.refresh();
    const u = anna.store.repo.mediaById(id)!.upload!;
    const paths = [u.full, u.thumb].map((h) => `media/b2b256-${h.slice(7)}.bin`);
    expect((await anna.storage.list('media/')).filter((e) => paths.includes(e.path))).toHaveLength(2);
    await ben.ctl.refresh();
    const theirs = (await ben.ctl.photos())!;
    const theirId = foreignMediaId(saveIdFor(anna.owner, 'osm:node/1'), id);
    expect(await theirs.full(theirId)).not.toBeNull();

    // The wipe empties every table of the database, media_cache included.
    const tables = () => anna.driver.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name);
    expect(tables()).toContain('media_cache');
    let cacheRows = -1;
    // Counted just before the database closes (after its tables are emptied).
    const realClose = anna.driver.close.bind(anna.driver);
    anna.driver.close = () => {
      cacheRows = anna.driver.get<{ n: number }>(`SELECT count(*) AS n FROM media_cache`)!.n;
      realClose();
    };
    await anna.ctl.deleteAllContent();
    expect(cacheRows).toBe(0);
    expect((await anna.storage.list('media/')).filter((e) => paths.includes(e.path))).toEqual([]);
    await ben.ctl.refresh();
    expect(theirs.list('osm:node/1')).toEqual([]);
    expect(theirs.usage().friends).toBe(0);
  });

  it('the export holds my photos (decrypted, with place and date) and not my friends\'; importing it restores them', async () => {
    const anna = makeUser('anna3');
    const ben = makeUser('ben3');
    const place = { osm: { type: 'node' as const, id: 1 }, name: 'Chez Lili', category: 'amenity=restaurant', geometry: { type: 'Point' as const, coordinates: [2.35, 48.85] as [number, number] } };
    anna.store.putSave({ place });
    ben.store.putSave({ place });
    await anna.ctl.refresh();
    await ben.ctl.refresh();
    await anna.ctl.addContact({ location: ben.location, owner: ben.owner, name: 'Ben', follow: true, share: false });
    await ben.ctl.addContact({ location: anna.location, name: 'Anna', follow: false, share: true });
    const benPhotos = (await ben.ctl.photos())!;
    benPhotos.add('osm:node/1', { full: webp(20_000, 7), thumb: webp(2_000, 8), width: 1600, height: 1200 });
    await ben.ctl.refresh();
    const photos = (await anna.ctl.photos())!;
    const id = photos.add('osm:node/1', { full: webp(30_000, 5, true), thumb: webp(3_000, 6), width: 1600, height: 1200 });
    await anna.ctl.refresh();
    expect(photos.list('osm:node/1').map((p) => p.mine)).toEqual([true, false]); // Ben's photo is on Anna's card

    const out = await exportArchive(anna.store, { image: (m, which) => (which === 'full' ? photos.full(m) : photos.thumbnail(m)) });
    expect(out).toMatchObject({ mime: 'application/zip', photos: 1, missing: 0 });

    // A new account imports it: the photo comes back on the place, with its date, stored like any of mine.
    const carl = makeUser('carl3');
    const carlPhotos = (await carl.ctl.photos())!;
    const o = readImportFile({ name: out.name, bytes: out.bytes });
    if (o.kind !== 'parsed') throw new Error(o.kind);
    const plan = buildPlan(o.result, await matchPlaces(o.result.places, null), carl.store.repo);
    const report = await applyImport(carl.store, plan, {
      yieldFn: async () => {},
      addPhoto: (placeId, p) => carlPhotos.add(placeId, { full: p.images.full, thumb: p.images.thumb, width: p.width ?? 0, height: p.height ?? 0 }, p.createdAt !== undefined ? { createdAt: p.createdAt } : {}),
    });
    expect(report.counts).toMatchObject({ photos: 1, photosSkipped: 0 });
    const [mine] = carlPhotos.list('osm:node/1');
    expect(mine).toMatchObject({ mine: true, state: 'waiting', fullLocal: true, thumbLocal: true, createdAt: anna.store.repo.mediaById(id)!.createdAt });
    expect((await carlPhotos.full(mine!.id))!.bytes).toEqual((await photos.full(id))!.bytes);
    await carl.ctl.refresh();
    expect(carlPhotos.list('osm:node/1')[0]!.state).toBe('uploaded');
  });
});
