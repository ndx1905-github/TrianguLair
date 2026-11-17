// SPDX-License-Identifier: MPL-2.0
/**
 * Behaviour added by the fixes of the T-204 review
 * (docs/reviews/2026-11-07-sync-review.md), beyond the reproductions in
 * review.test.ts.
 */
import {
  generateVaultDataKey,
  generateX25519KeyPair,
  issueSharingCert,
  packEntry,
  sealPack,
  serialize,
  signIndex,
  type SharingKey,
} from '@triangulair/crypto';
import { saveIdFor } from '@triangulair/data';
import { AuthError, MemoryAdapter, PreconditionFailed, TooLarge, type StorageAdapter } from '@triangulair/storage';
import { describe, expect, it } from 'vitest';
import { DeviceRevokedError, PayloadError, classifyError } from '../src/errors.ts';
import { parsePlaces, placesCollection, toForeignSave, type PlaceFeature } from '../src/features.ts';
import { PAYLOAD_PAD_FLOOR, encodePayload, utf8 } from '../src/payload.ts';
import { SyncScheduler, type Timers } from '../src/scheduler.ts';
import type { SyncReport } from '../src/engine.ts';
import { addDevice, befriend, friendSaves, indexOf, makeUser, point, World, type Device, type User } from './helpers.ts';

/** `a` with another `get`. */
function withGet(a: StorageAdapter, get: StorageAdapter['get']): StorageAdapter {
  return { capabilities: a.capabilities, get, head: (p) => a.head(p), put: (p, d, o) => a.put(p, d, o), delete: (p, o) => a.delete(p, o), list: (p) => a.list(p) };
}

/** Declares `lost` lost from `primary`: rotation r+1 that revokes it (no key sealed to the other devices). */
async function declareLost(user: User, primary: Device, lost: Device, rotation = 1): Promise<SharingKey> {
  const kp = generateX25519KeyPair();
  const next: SharingKey = {
    keyPair: kp,
    cert: issueSharingCert(user.identity, kp.publicKey, { rotation, location: user.location, revokedDevices: [lost.signer.keys.id] }),
    vaultDataKey: generateVaultDataKey(),
  };
  await primary.engine.own!.rotate(next, []);
  expect((await primary.engine.sync()).own!.published).toBe(true);
  return next;
}

/** What the thief plants: an own-document update sealed to the current public key, listed in an old-rotation index. */
function plant(mem: MemoryAdapter, user: User, thief: Device, publicKey: Uint8Array, seq: number): string {
  thief.store.putSave({ place: point(666, 'INJECTED'), comment: 'planted' });
  const update = thief.store.exportDoc();
  const body = new Uint8Array(update.length + 1);
  body[0] = 1;
  body.set(update, 1);
  const pack = sealPack(user.owner, encodePayload('own-doc', body), [publicKey]);
  const e = packEntry(pack, 'media');
  mem.putUnchecked(e.file, pack);
  const forged = signIndex(thief.signer, { seq, sharingCert: user.sharing.cert, packs: [e], vaultDataKey: user.sharing.vaultDataKey });
  mem.putUnchecked('index.json', utf8(serialize(forged)));
  return e.file;
}

describe('R-01: trust in my own index', () => {
  it('a device restored after the declaration (no local anchor) does not import an old-rotation index; the planted file is deleted', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const user = makeUser(w, 'alice', { storage: mem });
    const a = addDevice(w, user);
    const stolen = addDevice(w, user);
    a.store.putSave({ place: point(1, 'P1') });
    await a.engine.sync();
    await stolen.engine.sync();
    const next = await declareLost(user, a, stolen);
    const planted = plant(mem, user, stolen, next.keyPair.publicKey, 5000);

    // Restore from the recovery kit: the current sharing key (from the vault's phrase-sealed copy), nothing else.
    const restoredUser: User = { ...user, sharing: next, devices: [] };
    const fresh = addDevice(w, restoredUser);
    const r = await fresh.engine.sync();
    expect(r.own!.pull.rolledBack).toBe(true);
    expect(r.own!.published).toBe(true);
    expect(fresh.store.repo.getMySaveForPlace('osm:node/666')).toBeNull();
    // The vault gave it my anchor: it published above the primary's index, which friends accept.
    expect(r.own!.seq).toBe(a.engine.own!.index!.seq + 1);
    expect(await mem.head(planted)).toBeNull();
    // The primary device follows (an ordinary newer index).
    const ra = await a.engine.sync();
    expect(ra.ok).toBe(true);
    expect(a.store.repo.getMySaveForPlace('osm:node/666')).toBeNull();
    expect(a.store.repo.getMySaveForPlace('osm:node/1')).not.toBeNull();
  });

  it('without any anchor (no vault record either), the certificate rule alone refuses an older rotation', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const user = makeUser(w, 'alice', { storage: mem });
    const a = addDevice(w, user);
    const stolen = addDevice(w, user);
    await a.engine.sync();
    await stolen.engine.sync();
    const next = await declareLost(user, a, stolen);
    await mem.delete('vault.bin');
    plant(mem, user, stolen, next.keyPair.publicKey, 3);
    const fresh = addDevice(w, { ...user, sharing: next, devices: [] });
    const r = await fresh.engine.sync();
    expect(r.own!.pull.rolledBack).toBe(true);
    expect(fresh.store.repo.getMySaveForPlace('osm:node/666')).toBeNull();
  });

  it('my anchor is recorded in the vault at a rotation and every few publications, not at each one', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const user = makeUser(w, 'alice', { storage: mem });
    const a = addDevice(w, user);
    await a.engine.sync();
    const vaultWrites = () => [...mem.store.keys()].filter((k) => k === 'vault.bin').length && mem.store.get('vault.bin')!.etag;
    const first = vaultWrites();
    for (let i = 0; i < 5; i++) {
      a.store.putSave({ place: point(10 + i, `P${i}`) });
      await a.engine.sync();
    }
    expect(vaultWrites()).toBe(first);
    expect(a.engine.book.ownAnchor()!.seq).toBe(a.engine.own!.index!.seq);
  });
});

describe('R-02: my published places come from my document', () => {
  it('a friend with the same OSM place cannot change the kind, edge or geometry I publish, even after an OSM refresh', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    const carol = addDevice(w, makeUser(w, 'carol'));
    alice.store.putSave({ place: point(1, 'Chez Lili') });
    alice.store.repo.updatePlaceOsmData('osm:node/1', { openingHours: 'Mo-Su 10:00-22:00' }); // OSM-synced, no identity fields
    bob.store.putSave({
      place: { osm: { type: 'node', id: 1 }, name: 'BOB', category: 'shop=x', geometry: { type: 'Polygon', coordinates: [[[10, 10], [10.1, 10], [10.1, 10.1], [10, 10]]] } },
    });
    await Promise.all([alice.engine.sync(), bob.engine.sync(), carol.engine.sync()]);
    await befriend(w, bob, alice);
    await befriend(w, alice, carol);
    await bob.engine.sync();
    await alice.engine.sync();
    await carol.engine.sync();
    const row = carol.store.repo.getPlace('osm:node/1')!;
    expect(row).toMatchObject({ name: 'Chez Lili', kind: 'place', category: 'amenity=restaurant' });
    expect(row.geometry.type).toBe('Point');
    // Alice still has Bob's own description, in his save.
    expect(alice.store.repo.savePlaceSnapshot(saveIdFor(bob.user.owner, 'osm:node/1'))).toMatchObject({ name: 'BOB', kind: 'zone' });
  });
});

describe('R-03: owner side', () => {
  it('one of my files served at another listed path is treated as missing and rewritten', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const user = makeUser(w, 'alice', { storage: mem });
    const a = addDevice(w, user, { capacity: 2, blur: false });
    for (let i = 1; i <= 4; i++) a.store.putSave({ place: point(i, `P${i}`) });
    await a.engine.sync();
    const b = addDevice(w, user);
    const places = a.engine.own!.index!.packs.filter((p) => p.file.startsWith('packs/'));
    mem.putUnchecked(places[0]!.file, (await mem.get(places[1]!.file))!.data);
    const r = await b.engine.sync();
    expect(r.own!.pull.missing).toContain(places[0]!.file);
    expect(r.own!.published).toBe(true);
    for (const p of b.engine.own!.index!.packs) expect(await mem.head(p.file)).not.toBeNull();
    expect(b.engine.own!.index!.packs.map((p) => p.file)).not.toContain(places[0]!.file);
  });

  it('one malformed own pack does not stop the pull (R-12): it is rewritten', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const user = makeUser(w, 'alice', { storage: mem });
    const a = addDevice(w, user);
    a.store.putSave({ place: point(1, 'P1') });
    await a.engine.sync();
    // Another device of mine (a bug) lists a places pack whose payload is not valid JSON.
    const bad = sealPack(user.owner, encodePayload('places', utf8('{"type":"FeatureCollection",')), [user.sharing.keyPair.publicKey]);
    const e = packEntry(bad, 'packs');
    mem.putUnchecked(e.file, bad);
    const prev = a.engine.own!.index!;
    const idx = signIndex(a.signer, { seq: prev.seq + 1, sharingCert: user.sharing.cert, packs: [...prev.packs, e].sort((x, y) => (x.hash < y.hash ? -1 : 1)), vaultDataKey: user.sharing.vaultDataKey, previous: prev });
    mem.putUnchecked('index.json', utf8(serialize(idx)));
    const b = addDevice(w, user);
    const r = await b.engine.sync();
    expect(r.ok).toBe(true);
    expect(b.engine.own!.index!.packs.map((p) => p.file)).not.toContain(e.file);
    expect(b.store.repo.getMySaveForPlace('osm:node/1')).not.toBeNull();
  });
});

describe('R-05: remote wipe', () => {
  it('erases the keys (hook), the sync state and the database, and never syncs again', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const bob = addDevice(w, makeUser(w, 'bob'));
    bob.store.putSave({ place: point(9, 'Bob place') });
    let secrets = 0;
    const stolen = addDevice(w, user, { wipe: { secrets: () => void secrets++ } });
    stolen.store.putSave({ place: point(1, 'Mine') });
    await Promise.all([a.engine.sync(), stolen.engine.sync(), bob.engine.sync()]);
    await befriend(w, bob, stolen);
    await bob.engine.sync();
    await stolen.engine.sync();
    expect(friendSaves(stolen, bob.user.owner).size).toBe(1);
    await a.engine.sync();
    await declareLost(user, a, stolen);
    const count = stolen.driver.get.bind(stolen.driver);
    const rows: Record<string, number> = {};
    const close = stolen.driver.close.bind(stolen.driver);
    stolen.driver.close = () => {
      for (const t of ['saves', 'places', 'doc_chunks', 'people']) rows[t] = count<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n;
      close();
    };
    const keyBefore = stolen.engine.keys()[0]!.secretKey;
    const r = await stolen.engine.sync();
    expect(r.wiped).toBe(true);
    expect(r.friends).toEqual([]);
    expect(secrets).toBe(1);
    expect(rows).toEqual({ saves: 0, places: 0, doc_chunks: 0, people: 0 });
    expect(stolen.state.keys('')).toEqual([]);
    expect(keyBefore.every((b) => b === 0)).toBe(true);
    // Later passes do nothing at all.
    const again = await stolen.engine.sync();
    expect(again).toMatchObject({ wiped: true, friends: [] });
    expect(again.problems[0]!.problem.kind).toBe('device-revoked');
  });

  it('the scheduler stops for good once the device is wiped', async () => {
    let runs = 0;
    const s = new SyncScheduler({
      timers: { setTimeout: () => 0, clearTimeout: () => {}, now: () => 0 },
      run: async () => {
        runs++;
        return { own: null, friends: [], problems: [{ about: 'own', problem: classifyError(new DeviceRevokedError(), 'own') }], ok: false, wiped: true, startedAt: 0, durationMs: 0 };
      },
    });
    await s.appForeground('launch');
    expect(s.getStatus().state).toBe('wiped');
    await s.appForeground('foreground');
    await s.pullToRefresh();
    await s.resume();
    s.localChange();
    expect(runs).toBe(1);
  });
});

describe('R-06: size limits', () => {
  /** A friend's host that answers every listed pack with a huge body (the adapter enforces the limit it is given). */
  function hostile(inner: StorageAdapter, size: number): StorageAdapter {
    return withGet(inner, async (p, o) => {
      if (!p.startsWith('packs/')) return inner.get(p, o);
      if (o?.maxBytes === undefined) throw new Error('pack downloaded without a size limit');
      if (size > o.maxBytes) throw new TooLarge(p, o.maxBytes);
      return { data: new Uint8Array(size), etag: '"x"' };
    });
  }

  it('a friend\'s oversized pack is refused before verification (limit passed to the adapter), cache kept', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'), { limits: { packBytes: 1024 * 1024 } });
    alice.store.putSave({ place: point(1, 'P1') });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    await bob.engine.sync();
    expect(friendSaves(bob, alice.user.owner).size).toBe(1);
    alice.store.putSave({ place: point(2, 'P2') });
    await alice.engine.sync();
    // Friends read through World.readAdapter, which looks the storage up at each read.
    w.storages.set(alice.user.location, hostile(alice.user.storage, 4 * 1024 * 1024));
    const r = await bob.engine.sync();
    expect(r.friends[0]!.problem).toMatchObject({ kind: 'too-large', retryable: false });
    expect(friendSaves(bob, alice.user.owner).size).toBe(1);
  });

  it('one friend\'s read and one pass are bounded in total; the pass limit is retried next time', async () => {
    const w = new World();
    const users = ['alice', 'carol'].map((n) => addDevice(w, makeUser(w, n), { capacity: 50 }));
    for (const u of users) for (let i = 1; i <= 120; i++) u.store.putSave({ place: point(i, `${u.user.name} place ${i} ${'x'.repeat(200)}`), comment: 'c'.repeat(300) });
    const bob = addDevice(w, makeUser(w, 'bob'), { limits: { passBytes: 150 * 1024 } });
    await Promise.all([...users.map((u) => u.engine.sync()), bob.engine.sync()]);
    for (const u of users) await befriend(w, u, bob);
    for (const u of users) await u.engine.sync();
    const r1 = await bob.engine.sync();
    const problems = r1.friends.filter((f) => f.problem);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((f) => f.problem!.kind === 'too-large' && f.problem!.retryable)).toBe(true);
    // Each pass gets a fresh budget: the friends left over are read next.
    for (let i = 0; i < 4 && users.some((u) => friendSaves(bob, u.user.owner).size < 120); i++) await bob.engine.sync();
    for (const u of users) expect(friendSaves(bob, u.user.owner).size).toBe(120);
    // A single friend over the per-read limit is not retried in a loop.
    const dave = addDevice(w, makeUser(w, 'dave'), { limits: { friendReadBytes: 20 * 1024 } });
    await dave.engine.sync();
    await befriend(w, users[0]!, dave);
    await users[0]!.engine.sync();
    const rd = await dave.engine.sync();
    expect(rd.friends[0]!.problem).toMatchObject({ kind: 'too-large', retryable: false });
  });

  it('pack work is limited across all the friends read at once', async () => {
    const w = new World();
    const friends = ['a', 'b', 'c', 'd'].map((n) => addDevice(w, makeUser(w, n), { capacity: 5, blur: false }));
    for (const f of friends) for (let i = 1; i <= 20; i++) f.store.putSave({ place: point(i, `${f.user.name}${i}`) });
    const bob = addDevice(w, makeUser(w, 'bob'), { concurrency: 3, friendConcurrency: 4 });
    await Promise.all([...friends.map((f) => f.engine.sync()), bob.engine.sync()]);
    for (const f of friends) await befriend(w, f, bob);
    for (const f of friends) await f.engine.sync();
    let inFlight = 0;
    let max = 0;
    for (const f of friends) {
      const a = f.user.storage;
      w.storages.set(f.user.location, withGet(a, async (p, o) => {
        if (!p.startsWith('packs/')) return a.get(p, o);
        max = Math.max(max, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return a.get(p, o);
      }));
    }
    const r = await bob.engine.sync();
    expect(r.ok).toBe(true);
    expect(max).toBeLessThanOrEqual(3);
    expect(max).toBeGreaterThan(1);
  });
});

/** Coarse ETags (mtime in seconds + size, as WsgiDAV and Nextcloud): every write in the same second keeps the ETag; emulated conditions. */
function coarse(inner: MemoryAdapter): StorageAdapter {
  const tag = '"coarse"';
  return {
    capabilities: { ...inner.capabilities, conditionalWrites: false },
    get: async (p, o) => {
      const g = await inner.get(p, o);
      return g && { data: g.data, etag: tag };
    },
    head: async (p) => {
      const h = await inner.head(p);
      return h && { etag: tag, size: h.size };
    },
    list: (p) => inner.list(p),
    delete: (p) => inner.delete(p),
    async put(p, d, o = {}) {
      const h = await inner.head(p);
      if (o.ifMatch !== undefined && (!h || tag !== o.ifMatch)) throw new PreconditionFailed(p);
      if (o.ifNoneMatch === '*' && h) throw new PreconditionFailed(p);
      await inner.put(p, d);
      return { etag: tag };
    },
  };
}

describe('R-08: lost races on coarse-ETag servers', () => {
  it('an index changed under an unchanged ETag is noticed before overwriting it; both devices\' changes land', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const user = makeUser(w, 'alice', { storage: coarse(mem) });
    // Long full-check period: the HEAD shortcut (unchanged ETag → cached index) is what each pass uses.
    const a = addDevice(w, user, { fullCheckMs: 3_600_000 });
    const b = addDevice(w, user, { fullCheckMs: 3_600_000 });
    a.store.putSave({ place: point(1, 'base') });
    await a.engine.sync();
    await b.engine.sync();
    b.store.putSave({ place: point(2, 'B') });
    expect((await b.engine.sync()).own!.published).toBe(true);
    a.store.putSave({ place: point(3, 'A') });
    const r = await a.engine.sync();
    expect(r.own!.published).toBe(true);
    expect(r.own!.conflicts).toBeGreaterThanOrEqual(1);
    expect(a.store.repo.getMySaveForPlace('osm:node/2')).not.toBeNull();
    for (const p of a.engine.own!.index!.packs) expect(await mem.head(p.file)).not.toBeNull();
    await b.engine.own!.pull({ full: true });
    expect(b.store.repo.getMySaveForPlace('osm:node/3')).not.toBeNull();
  });

  it('a race inside the publication itself (another device writes after our pull) is caught too', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const store = coarse(mem);
    const user = makeUser(w, 'alice', { storage: store });
    const a = addDevice(w, user);
    const b = addDevice(w, user);
    a.store.putSave({ place: point(1, 'base') });
    await a.engine.sync();
    await b.engine.sync();
    b.store.putSave({ place: point(2, 'B') });
    a.store.putSave({ place: point(3, 'A') });
    // B publishes while A uploads its packs (after A's pull, before A's index write).
    const put = store.put.bind(store);
    let once = true;
    store.put = async (p, d, o) => {
      if (once && p.startsWith('media/')) {
        once = false;
        await b.engine.sync();
      }
      return put(p, d, o);
    };
    const r = await a.engine.own!.publish();
    store.put = put;
    expect(r.published).toBe(true);
    expect(r.conflicts).toBe(1);
    expect(a.store.repo.getMySaveForPlace('osm:node/2')).not.toBeNull();
    await b.engine.sync();
    expect(b.store.repo.dumpOwnData()).toBe(a.store.repo.dumpOwnData());
  });
});

describe('R-09 / R-10: the vault', () => {
  it('a removed contact reaches the vault before any pack is written', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const alice = addDevice(w, makeUser(w, 'alice', { storage: mem }));
    const bob = addDevice(w, makeUser(w, 'bob'));
    alice.store.putSave({ place: point(1, 'P1') });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    const order: string[] = [];
    const put = mem.put.bind(mem);
    mem.put = (p, d, o) => (order.push(p), put(p, d, o));
    alice.engine.removeContact(bob.user.owner);
    await alice.engine.sync();
    mem.put = put;
    const vault = order.indexOf('vault.bin');
    const firstPack = order.findIndex((p) => p.startsWith('packs/') || p === 'index.json');
    expect(vault).toBeGreaterThanOrEqual(0);
    expect(vault).toBeLessThan(firstPack);
  });

  it('a vault sealed with my previous vault key is merged after a plain rotation, never after a declaration of loss', async () => {
    for (const revoke of [false, true]) {
      const w = new World();
      const mem = new MemoryAdapter();
      const user = makeUser(w, 'alice', { storage: mem });
      const a = addDevice(w, user);
      const b = addDevice(w, user);
      const carol = addDevice(w, makeUser(w, 'carol'));
      await Promise.all([a.engine.sync(), b.engine.sync(), carol.engine.sync()]);
      // A rotates (adopting a new vault key) …
      const kp = generateX25519KeyPair();
      await a.engine.own!.rotate({
        keyPair: kp,
        cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location, revokedDevices: revoke ? [b.signer.keys.id] : [] }),
        vaultDataKey: generateVaultDataKey(),
      });
      // … while B, which has not seen it yet, adds a contact and writes the vault with the old key.
      b.engine.addContact(await indexOf(w, carol.user), { share: true });
      await b.engine.own!.pushVault();
      await a.engine.sync();
      expect(!!a.engine.book.contact(carol.user.owner)).toBe(!revoke);
    }
  });
});

describe('R-07 / R-11: scheduler', () => {
  function fakeTimers() {
    let t = 0;
    const q: { at: number; fn: () => void; id: number }[] = [];
    let id = 0;
    const timers: Timers = {
      setTimeout: (fn, ms) => (q.push({ at: t + ms, fn, id: ++id }), id),
      clearTimeout: (h) => {
        const i = q.findIndex((x) => x.id === h);
        if (i >= 0) q.splice(i, 1);
      },
      now: () => t,
    };
    return { timers, pending: () => q.length };
  }
  const report = (problems: SyncReport['problems']): SyncReport => ({ own: null, friends: [], problems, ok: problems.length === 0, startedAt: 0, durationMs: 0 });

  it('blocked: opening the app runs a read-only pass; once my storage answers again, what waited is published', async () => {
    const ft = fakeTimers();
    const runs: { reason: string; publish: boolean }[] = [];
    let auth = true;
    const s = new SyncScheduler({
      timers: ft.timers,
      run: async (reason, o) => {
        runs.push({ reason, publish: o.publish });
        return report(auth ? [{ about: 'own', problem: classifyError(new AuthError('401'), 'own') }] : []);
      },
    });
    await s.appForeground('launch');
    s.localChange();
    await s.appBackground();
    expect(runs.at(-1)).toEqual({ reason: 'background', publish: true });
    auth = false;
    await s.appForeground('foreground');
    expect(runs.slice(-2)).toEqual([{ reason: 'foreground', publish: false }, { reason: 'retry', publish: true }]);
    expect(s.getStatus()).toMatchObject({ state: 'idle', pending: 0 });
  });

  it('a non-retryable problem of mine is not retried in a loop, only at the next foreground', async () => {
    const ft = fakeTimers();
    let runs = 0;
    const s = new SyncScheduler({
      timers: ft.timers,
      run: async () => (runs++, report([{ about: 'own', problem: classifyError(new PayloadError('bad', true), 'own') }])),
    });
    await s.appForeground('launch');
    expect(s.getStatus().problem?.kind).toBe('unsupported');
    expect(ft.pending()).toBe(0);
    await s.appForeground('foreground');
    expect(runs).toBe(2);
  });
});

describe('R-13: friend-controlled strings and dates', () => {
  const base: PlaceFeature = {
    type: 'Feature',
    id: 'osm:node/1',
    geometry: { type: 'Point', coordinates: [2.35, 48.85] },
    properties: { name: 'A', tags: [{ name: 'T', color: '#EF4444', icon: 'pizza' }], created: '2026-10-13T15:10:00.000Z', updated: '2026-10-13T15:10:00.000Z' },
  };
  const withProps = (p: Partial<PlaceFeature['properties']>) => placesCollection([{ ...base, properties: { ...base.properties, ...p } }]);

  it('refuses colors that are not #RRGGBB, icons that are not symbol names, controls and bidi overrides', () => {
    expect(parsePlaces(withProps({})).length).toBe(1);
    expect(() => parsePlaces(withProps({ tags: [{ name: 'T', color: 'red;background:url(x)' }] }))).toThrow(/color/);
    expect(() => parsePlaces(withProps({ tags: [{ name: 'T', icon: '<svg onload=x>' }] }))).toThrow(/icon/);
    expect(() => parsePlaces(withProps({ name: 'evil‮txt.exe' }))).toThrow(/bidirectional/);
    expect(() => parsePlaces(withProps({ name: 'two\nlines' }))).toThrow(/control/);
    expect(() => parsePlaces(withProps({ comment: 'bell\u0007', comment_visibility: 'friends' }))).toThrow(/control/);
    expect(parsePlaces(withProps({ comment: 'line 1\nline 2', comment_visibility: 'friends' })).length).toBe(1);
  });

  it('clamps dates in the future to now + 24 h', () => {
    const now = Date.parse('2026-11-07T12:00:00.000Z');
    const f = parsePlaces(withProps({ created: '2099-01-01T00:00:00.000Z', updated: '2099-01-01T00:00:00.000Z' }))[0]!.feature;
    const s = toForeignSave('ed25519:x', f, now);
    expect(s.updatedAt).toBe(now + 24 * 3600 * 1000);
    expect(s.createdAt).toBe(now + 24 * 3600 * 1000);
  });

  it('my own writer never emits what readers refuse (a tag color of my own that is not #RRGGBB)', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    const tag = alice.store.createTag({ name: 'Weird‮', color: 'red', icon: 'Pizza Icon' });
    alice.store.putSave({ place: point(1, 'Name\twith tab') });
    alice.store.setSaveTags('osm:node/1', [tag]);
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    const r = await bob.engine.sync();
    expect(r.ok).toBe(true);
    expect(friendSaves(bob, alice.user.owner).size).toBe(1);
  });
});

describe('padding floor (THREATS)', () => {
  it('small places packs and own-document deltas are padded to at least 4 KiB', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const user = makeUser(w, 'alice', { storage: mem });
    const a = addDevice(w, user);
    a.store.putSave({ place: point(1, 'P1') });
    await a.engine.sync();
    a.store.updateSave('osm:node/1', { comment: 'x' });
    const r = await a.engine.sync();
    expect(r.own!.ownDoc).toBe('delta');
    for (const p of a.engine.own!.index!.packs) expect((await mem.head(p.file))!.size).toBeGreaterThan(PAYLOAD_PAD_FLOOR);
    // All of them land in the same Padmé bucket, whatever the size of the edit.
    const sizes = new Set<number>();
    for (const p of a.engine.own!.index!.packs) sizes.add((await mem.head(p.file))!.size);
    expect(sizes.size).toBeLessThanOrEqual(2);
  });
});

describe('R-14: the injected clock', () => {
  it('the periodic full read follows `now`, not the wall clock', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const alice = addDevice(w, makeUser(w, 'alice', { storage: coarse(mem) }));
    // Anchored on the wall clock: indexes are dated with it, and a reader refuses one more than 24 h ahead of `now`.
    let t = Date.now();
    const bob = addDevice(w, makeUser(w, 'bob'), { fullCheckMs: 600_000, now: () => new Date(t) });
    alice.store.putSave({ place: point(1, 'P1'), status: 'tried' });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    await bob.engine.sync();
    alice.store.updateSave('osm:node/1', { status: 'favorite' });
    await alice.engine.sync();
    await bob.engine.sync();
    expect(friendSaves(bob, alice.user.owner).get('osm:node/1')!.status).toBe('tried'); // same ETag, within 10 min
    t += 11 * 60_000;
    await bob.engine.sync();
    expect(friendSaves(bob, alice.user.owner).get('osm:node/1')!.status).toBe('favorite');
  });
});
