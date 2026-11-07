// SPDX-License-Identifier: MPL-2.0
/**
 * Independent review of T-204 (PR #71), docs/reviews/2026-11-07-sync-review.md.
 * Each `it.fails` states the DESIRED behaviour and fails today; it starts
 * passing (and therefore turns red) once the finding is fixed: flip it to `it`.
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
import { AuthError, MemoryAdapter } from '@triangulair/storage';
import { describe, expect, it } from 'vitest';
import { classifyError } from '../src/errors.ts';
import { decodePayload, encodePayload, utf8 } from '../src/payload.ts';
import { SyncScheduler, type Timers } from '../src/scheduler.ts';
import type { SyncReport } from '../src/engine.ts';
import { addDevice, befriend, friendSaves, makeUser, point, World } from './helpers.ts';

describe('review R-01: own pull trusts the content of a rolled-back / older-rotation index', () => {
  it.fails('a device declared lost cannot inject own-document updates through an index of the old rotation', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const user = makeUser(w, 'alice', { storage: mem });
    const a = addDevice(w, user);
    const stolen = addDevice(w, user);
    a.store.putSave({ place: point(1, 'P1') });
    await a.engine.sync();
    await stolen.engine.sync();

    // Declaration of loss on the primary device: rotation 1 revokes the stolen device.
    const kp = generateX25519KeyPair();
    const next: SharingKey = {
      keyPair: kp,
      cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location, revokedDevices: [stolen.signer.keys.id] }),
      vaultDataKey: generateVaultDataKey(),
    };
    await a.engine.own!.rotate(next, []);
    expect((await a.engine.sync()).own!.published).toBe(true);

    // The thief still has the storage credentials (spec "Loss and theft" step 4 comes later), the old
    // certificate and its own (now revoked) device key. It plants a Yjs update sealed to the NEW sharing
    // public key (public: it is in the index) and lists it in an index of the OLD rotation.
    stolen.store.putSave({ place: point(666, 'INJECTED'), comment: 'planted by the thief' });
    const update = stolen.store.exportDoc();
    const body = new Uint8Array(update.length + 1);
    body[0] = 1; // full
    body.set(update, 1);
    const pack = sealPack(user.owner, encodePayload('own-doc', body), [kp.publicKey]);
    const e = packEntry(pack, 'media');
    mem.putUnchecked(e.file, pack);
    const forged = signIndex(stolen.signer, { seq: 1000, sharingCert: user.sharing.cert, packs: [e], vaultDataKey: user.sharing.vaultDataKey });
    mem.putUnchecked('index.json', utf8(serialize(forged)));

    const r = await a.engine.sync();
    // Desired: the rolled-back index is used only to detect the rollback; nothing listed in it is imported.
    expect(r.own?.pull.rolledBack).toBe(true);
    expect(a.store.repo.getMySaveForPlace('osm:node/666')).toBeNull();
  });
});

describe('review R-02: a friend\'s feature overwrites my own place record, which I then republish', () => {
  it.fails('the name and geometry I publish for my place come from my document, not from a friend\'s cache entry', async () => {
    const w = new World();
    const alice = addDevice(w, makeUser(w, 'alice'));
    const bob = addDevice(w, makeUser(w, 'bob'));
    const carol = addDevice(w, makeUser(w, 'carol'));
    alice.store.putSave({ place: point(1, 'Chez Lili') });
    alice.store.putSave({ place: point(2, 'Other') });
    // Bob saves the same OSM place, with another name and a far-away point.
    bob.store.putSave({ place: point(1, 'RENAMED BY BOB', 10, 10) });
    await Promise.all([alice.engine.sync(), bob.engine.sync(), carol.engine.sync()]);
    await befriend(w, bob, alice); // Bob shares with Alice, Alice follows Bob
    await befriend(w, alice, carol); // Alice shares with Carol
    await bob.engine.sync();
    await alice.engine.sync(); // reads Bob: upsertForeignSave → upsertPlaceSnapshot overwrites osm:node/1
    expect(alice.store.repo.getPlace('osm:node/1')!.name).toBe('Chez Lili');

    // Any later edit that rewrites the pack republishes the place row as it now is.
    alice.store.updateSave('osm:node/2', { comment: 'edit' });
    await alice.engine.sync();
    await carol.engine.sync();
    expect(carol.store.repo.getPlace('osm:node/1')!.name).toBe('Chez Lili');
  });
});

describe('review R-03: the storage host can swap listed packs', () => {
  it.fails('a pack served at another listed pack\'s path is rejected and the cache kept', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const alice = addDevice(w, makeUser(w, 'alice', { storage: mem }), { capacity: 2, blur: false });
    const bob = addDevice(w, makeUser(w, 'bob'));
    for (let i = 1; i <= 4; i++) alice.store.putSave({ place: point(i, `P${i}`) });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    await bob.engine.sync();
    expect(friendSaves(bob, alice.user.owner).size).toBe(4);

    // One place changes: one pack is replaced (blur off), the other is kept.
    const before = new Set(alice.engine.own!.index!.packs.map((p) => p.file));
    alice.store.updateSave('osm:node/1', { comment: 'new' });
    await alice.engine.sync();
    const places = alice.engine.own!.index!.packs.filter((p) => p.file.startsWith('packs/'));
    const fresh = places.find((p) => !before.has(p.file))!;
    const kept = places.find((p) => before.has(p.file))!;
    // The host serves the kept pack's bytes at the new pack's path (the hash is listed, so openPack accepts it).
    mem.putUnchecked(fresh.file, (await mem.get(kept.file))!.data);

    const r = await bob.engine.sync();
    expect(r.friends[0]!.status).toBe('error');
    expect(friendSaves(bob, alice.user.owner).size).toBe(4); // today: the 2 places of the swapped pack are erased
  });
});

describe('review R-04: reader state aliasing after an address change', () => {
  it.fails('a failed read after an address change does not mark unprojected packs as seen', async () => {
    const w = new World();
    const mem = new MemoryAdapter();
    const alice = addDevice(w, makeUser(w, 'alice', { storage: mem }), { capacity: 2, blur: false });
    const bob = addDevice(w, makeUser(w, 'bob'), { concurrency: 1 });
    for (let i = 1; i <= 4; i++) alice.store.putSave({ place: point(i, `P${i}`) });
    await alice.engine.sync();
    await bob.engine.sync();
    await befriend(w, alice, bob);
    await alice.engine.sync();
    await bob.engine.sync();
    const key = `friend:${alice.user.owner}`;

    // Both packs change.
    for (let i = 1; i <= 4; i++) alice.store.updateSave(`osm:node/${i}`, { comment: `v2-${i}` });
    await alice.engine.sync();
    const listed = alice.engine.own!.index!.packs.filter((p) => p.file.startsWith('packs/'));
    const last = listed.at(-1)!;
    const saved = (await mem.get(last.file))!.data;
    // The reader state still carries an older address (another device followed the friend's move, the vault
    // brought the new certificate): FriendReader.read builds `st` with `packs: prev.packs` by reference.
    bob.state.set(key, { ...bob.state.get<Record<string, unknown>>(key)!, location: 'https://old.example/tl/' });
    await mem.delete(last.file); // the second pack is not there yet: the read fails after opening the first
    const target = { owner: alice.user.owner, location: alice.user.location };
    expect((await bob.engine.reader.read(target)).status).toBe('error');
    mem.putUnchecked(last.file, saved);
    expect((await bob.engine.reader.read(target)).status).toBe('updated');
    const saves = friendSaves(bob, alice.user.owner);
    for (let i = 1; i <= 4; i++) expect(saves.get(`osm:node/${i}`)!.comment).toBe(`v2-${i}`);
  });
});

describe('review R-05: remote wipe', () => {
  it.fails('a device that finds itself revoked does not go on reading and caching friends in the same pass', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const stolen = addDevice(w, user);
    const bob = addDevice(w, makeUser(w, 'bob'));
    bob.store.putSave({ place: point(9, 'Bob place') });
    await Promise.all([a.engine.sync(), stolen.engine.sync(), bob.engine.sync()]);
    await befriend(w, bob, stolen);
    await bob.engine.sync();
    const kp = generateX25519KeyPair();
    await a.engine.own!.rotate({
      keyPair: kp,
      cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location, revokedDevices: [stolen.signer.keys.id] }),
      vaultDataKey: generateVaultDataKey(),
    });
    await a.engine.sync();
    const r = await stolen.engine.sync();
    expect(r.problems.some((p) => p.problem.kind === 'device-revoked')).toBe(true);
    expect(r.friends).toEqual([]); // today: Bob is read (and decrypted into the cache) after the revocation was seen
  });
});

describe('review R-06: payload size budget', () => {
  it.fails('a places payload is bounded far below the generic 64 MiB (a 200-place pack is ~70 KB)', () => {
    const body = new Uint8Array(24 * 1024 * 1024).fill(0x20);
    const payload = encodePayload('places', body); // ~24 KB compressed
    expect(payload.length).toBeLessThan(64 * 1024);
    expect(() => decodePayload(payload)).toThrow(); // today: 24 MiB inflated, then handed to JSON.parse
  });
});

describe('review R-07: blocked state stops reading friends too', () => {
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
    return { timers };
  }
  const report = (problems: SyncReport['problems']): SyncReport => ({ own: null, friends: [], problems, ok: problems.length === 0, startedAt: 0, durationMs: 0 });

  it.fails('with my storage credentials rejected, opening the app still refreshes friends (only writes stop)', async () => {
    const ft = fakeTimers();
    const runs: string[] = [];
    const s = new SyncScheduler({
      timers: ft.timers,
      run: async (reason) => {
        runs.push(reason);
        return report([{ about: 'own', problem: classifyError(new AuthError('401'), 'own') }]);
      },
    });
    await s.appForeground('launch');
    expect(s.getStatus().state).toBe('blocked');
    await s.appBackground();
    await s.appForeground('foreground');
    // Spec "Error cases": credentials rejected → writes stop, queue kept; friends are refreshed "on opening".
    expect(runs.filter((r) => r === 'foreground').length).toBe(1);
  });
});
