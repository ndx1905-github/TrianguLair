// SPDX-License-Identifier: MPL-2.0
/**
 * The spec's "Error cases" table, one test per row (T-213), on real engines and in-memory storages
 * with injected faults. docs/error-cases.md maps every row to its code and to this file (or to the
 * app's src/errorCases.test.ts for the rows that are about links, keys and messages).
 */
import {
  createInvitation,
  generateVaultDataKey,
  generateX25519KeyPair,
  invitationStatus,
  issueSharingCert,
  type SharingKey,
} from '@triangulair/crypto';
import { AuthError, MemoryAdapter, NetworkError, ProtocolError, type StorageAdapter } from '@triangulair/storage';
import { describe, expect, it } from 'vitest';
import { SyncEngine } from '../src/engine.ts';
import { SyncScheduler, type Timers } from '../src/scheduler.ts';
import { MemoryStateStore } from '../src/state.ts';
import { addDevice, befriend, friendSaves, makeUser, point, World, type Device, type User } from './helpers.ts';

const DAY = 86_400_000;

type Op = 'get' | 'head' | 'put' | 'delete' | 'list';
/** A storage whose requests fail while `fault` returns an error for them. */
function faulty(inner: StorageAdapter): StorageAdapter & { fault: ((op: Op, path: string) => Error | null) | null } {
  const s = {
    fault: null as ((op: Op, path: string) => Error | null) | null,
    capabilities: inner.capabilities,
    check(op: Op, path: string) {
      const e = s.fault?.(op, path);
      if (e) throw e;
    },
    get: async (p: string, o?: Parameters<StorageAdapter['get']>[1]) => (s.check('get', p), inner.get(p, o)),
    head: async (p: string) => (s.check('head', p), inner.head(p)),
    put: async (p: string, d: Uint8Array, o?: Parameters<StorageAdapter['put']>[2]) => (s.check('put', p), inner.put(p, d, o)),
    delete: async (p: string, o?: Parameters<StorageAdapter['delete']>[1]) => (s.check('delete', p), inner.delete(p, o)),
    list: async (p: string) => (s.check('list', p), inner.list(p)),
  };
  return s;
}

/** Alice (storage with faults) shares one place with Bob, who follows her. */
async function pair(opts: { aliceOnline?: () => boolean } = {}) {
  const w = new World();
  const storage = faulty(new MemoryAdapter());
  const aliceUser = makeUser(w, 'alice', { storage });
  const alice = addDevice(w, aliceUser, { ...(opts.aliceOnline && { online: opts.aliceOnline }) });
  const bob = addDevice(w, makeUser(w, 'bob'));
  alice.store.putSave({ place: point(1, 'Le Comptoir') });
  await alice.engine.sync();
  await bob.engine.sync();
  await befriend(w, alice, bob);
  await alice.engine.sync();
  await bob.engine.sync();
  expect(friendSaves(bob, aliceUser.owner).size).toBe(1);
  return { w, storage, alice, bob, owner: aliceUser.owner };
}

/** Timers that never fire on their own: passes are triggered by the test, the clock is moved by hand. */
function clock() {
  let now = 0;
  const timers: Timers = { setTimeout: () => 0, clearTimeout: () => {}, now: () => now };
  return { timers, set: (ms: number) => (now = ms) };
}

const ownProblem = (r: Awaited<ReturnType<SyncEngine['sync']>>) => r.problems.find((p) => p.about === 'own')?.problem;

describe('spec "Error cases", one test per row', () => {
  it('No network: everything works locally, changes wait and go out when the network is back', async () => {
    let online = true;
    const { storage, alice, bob, owner } = await pair({ aliceOnline: () => online });
    online = false;
    storage.fault = () => new NetworkError('offline');
    alice.store.updateSave('osm:node/1', { comment: 'written offline' });
    alice.store.putSave({ place: point(2, 'Café Pendule') });
    const r = await alice.engine.sync();
    expect(ownProblem(r)).toMatchObject({ kind: 'offline', situation: 'No network', retryable: true, blocksWrites: false });
    // Nothing is lost on the device.
    expect(alice.store.repo.db.all(`SELECT place_id FROM saves WHERE owner_id = ? ORDER BY place_id`, [owner]).length).toBe(2);
    // The scheduler: nothing attempted offline, the changes counted, a pass as soon as it is back.
    const runs: string[] = [];
    const s = new SyncScheduler({ run: async (reason, o) => (runs.push(reason), alice.engine.sync(o)), timers: clock().timers });
    await s.appForeground('launch');
    s.setOnline(false);
    s.localChange();
    expect(s.getStatus()).toMatchObject({ state: 'offline', pending: 1 });
    online = true;
    storage.fault = null;
    s.setOnline(true);
    await s.pullToRefresh();
    expect(runs).toContain('online');
    expect(s.getStatus()).toMatchObject({ state: 'idle', pending: 0, problem: null });
    await bob.engine.sync();
    expect(friendSaves(bob, owner).get('osm:node/1')!.comment).toBe('written offline');
  });

  it('My storage unreachable: retried, nothing lost; the banner only after 24 h', async () => {
    const { storage, alice, bob, owner } = await pair();
    const c = clock();
    const s = new SyncScheduler({ run: (_r, o) => alice.engine.sync(o), timers: c.timers, backoffMs: [30_000] });
    await s.appForeground('launch');
    storage.fault = () => new NetworkError('connection refused');
    alice.store.updateSave('osm:node/1', { comment: 'while it was down' });
    s.localChange();
    await s.pullToRefresh();
    expect(s.getStatus()).toMatchObject({ state: 'idle', failingSince: 0, banner: false, pending: 1 });
    expect(s.getStatus().problem).toMatchObject({ kind: 'unreachable', situation: 'My storage unreachable', retryable: true });
    c.set(23 * 3_600_000);
    await s.pullToRefresh();
    expect(s.getStatus().banner).toBe(false);
    c.set(25 * 3_600_000);
    await s.pullToRefresh();
    expect(s.getStatus()).toMatchObject({ banner: true, pending: 1 });
    storage.fault = null;
    await s.pullToRefresh();
    expect(s.getStatus()).toMatchObject({ banner: false, failingSince: null, problem: null, pending: 0 });
    await bob.engine.sync();
    expect(friendSaves(bob, owner).get('osm:node/1')!.comment).toBe('while it was down');
  });

  it('Credentials rejected: writes stop, the queue is kept, friends are still read; reconnecting sends it', async () => {
    const { storage, alice, bob, owner } = await pair();
    // Bob shares with Alice too, so that she has someone to read while her writes are stopped.
    alice.engine.addContact((await bob.engine.own!.pull()).index!, { follow: true });
    bob.engine.setPolicy(owner, { share: true });
    bob.store.putSave({ place: point(9, 'Chez Bob') });
    await bob.engine.sync();
    const c = clock();
    const runs: boolean[] = [];
    const s = new SyncScheduler({ run: (_r, o) => (runs.push(o.publish), alice.engine.sync(o)), timers: c.timers });
    storage.fault = (op) => (op === 'put' || op === 'get' || op === 'head' ? new AuthError('401 Unauthorized') : null);
    alice.store.updateSave('osm:node/1', { comment: 'queued' });
    s.localChange();
    await s.appForeground('launch');
    expect(s.getStatus()).toMatchObject({ state: 'blocked', pending: 1 });
    expect(s.getStatus().problem).toMatchObject({ kind: 'auth', situation: 'Credentials rejected', blocksWrites: true, message: 'Reconnect your storage' });
    // Coming back to the app: a read-only pass (friends refreshed), no write attempted.
    await s.appBackground();
    await s.appForeground('foreground');
    expect(runs.at(-1)).toBe(false);
    expect(friendSaves(alice, bob.user.owner).size).toBe(1);
    expect(s.getStatus()).toMatchObject({ state: 'blocked', pending: 1 });
    // The user reconnects (new password): the queue goes out.
    storage.fault = null;
    await s.resume();
    expect(s.getStatus()).toMatchObject({ state: 'idle', pending: 0, problem: null });
    await bob.engine.sync();
    expect(friendSaves(bob, owner).get('osm:node/1')!.comment).toBe('queued');
  });

  it('Quota full: text is kept and retried; space used by content type for the suggestions', async () => {
    const { storage, alice, bob, owner } = await pair();
    const space = await alice.engine.own!.spaceUsed();
    expect(space).not.toBeNull();
    expect(space!.places).toBeGreaterThan(0);
    expect(space!.document).toBeGreaterThan(0);
    expect(space!.keys).toBeGreaterThan(0);
    expect(space!.photos).toBe(0); // no personal photos are published yet (they would wait behind the text)
    expect(space!.total).toBe(space!.places + space!.document + space!.lists + space!.public + space!.photos + space!.keys + space!.other);
    storage.fault = (op) => (op === 'put' ? new ProtocolError('507 Insufficient Storage', { status: 507 }) : null);
    alice.store.updateSave('osm:node/1', { comment: 'when space is back' });
    const r = await alice.engine.sync();
    expect(ownProblem(r)).toMatchObject({ kind: 'quota', situation: 'Quota full', retryable: true, blocksWrites: false });
    // Space used is still readable while writes fail.
    expect((await alice.engine.own!.spaceUsed())!.total).toBe(space!.total);
    storage.fault = null;
    expect((await alice.engine.sync()).ok).toBe(true);
    await bob.engine.sync();
    expect(friendSaves(bob, owner).get('osm:node/1')!.comment).toBe('when space is back');
  });

  it('Interrupted write: packs first, the index last, so an index always points to complete packs', async () => {
    const { storage, alice, bob, owner } = await pair();
    const writes: string[] = [];
    storage.fault = (op, path) => {
      if (op !== 'put') return null;
      writes.push(path);
      return path === 'index.json' ? new NetworkError('connection reset') : null;
    };
    alice.store.updateSave('osm:node/1', { comment: 'cut in the middle' });
    alice.store.putSave({ place: point(2, 'Café Pendule') });
    const r = await alice.engine.sync();
    expect(r.ok).toBe(false);
    expect(writes.filter((p) => p.startsWith('packs/')).length).toBeGreaterThan(0);
    expect(writes.indexOf('index.json')).toBe(writes.length - 1);
    // Bob still reads the previous index, whose packs are all there.
    const rb = await bob.engine.sync();
    expect(rb.ok).toBe(true);
    expect(friendSaves(bob, owner).get('osm:node/1')!.comment).toBe('');
    // The next pass completes; the packs written for nothing are counted as "other", then deleted.
    expect((await alice.engine.own!.spaceUsed())!.other).toBeGreaterThan(0);
    storage.fault = null;
    expect((await alice.engine.sync()).ok).toBe(true);
    expect((await alice.engine.own!.spaceUsed())!.other).toBe(0);
    await bob.engine.sync();
    expect(friendSaves(bob, owner).size).toBe(2);
  });

  it('Two of my devices write at the same time: conditional write, re-read, merge, retry', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const b = addDevice(w, user);
    a.store.putSave({ place: point(1, 'On the phone') });
    await a.engine.sync();
    await b.engine.sync();
    a.store.putSave({ place: point(2, 'Phone again') });
    b.store.putSave({ place: point(3, 'On the tablet') });
    const [ra, rb] = await Promise.all([a.engine.sync(), b.engine.sync()]);
    expect(ra.ok && rb.ok).toBe(true);
    expect((ra.own?.conflicts ?? 0) + (rb.own?.conflicts ?? 0)).toBeGreaterThan(0);
    await a.engine.sync();
    await b.engine.sync();
    const ids = (d: Device) => d.store.repo.db.all<{ place_id: string }>(`SELECT place_id FROM saves WHERE owner_id = ? ORDER BY place_id`, [user.owner]).map((x) => x.place_id);
    expect(ids(a)).toEqual(['osm:node/1', 'osm:node/2', 'osm:node/3']);
    expect(ids(b)).toEqual(ids(a));
  });

  it('A friend\'s storage unreachable: their content stays displayed from the cache, with its age', async () => {
    const { storage, bob, owner } = await pair();
    const before = bob.engine.reader.lastSuccess(owner);
    expect(before).not.toBeNull();
    storage.fault = () => new NetworkError('their server is down');
    const r = await bob.engine.sync();
    const p = r.problems.find((x) => x.about === owner)?.problem;
    expect(p).toMatchObject({ kind: 'unreachable', situation: 'A friend\'s storage unreachable', message: 'Updated {age} ago', retryable: true });
    expect(friendSaves(bob, owner).size).toBe(1);
    expect(bob.engine.reader.lastSuccess(owner)).toBe(before);
  });

  it('A friend changes storage: the signed redirect is followed to the address their master key certified', async () => {
    const { w, alice, bob, owner } = await pair();
    const user = alice.user;
    // The move: a new sharing certificate (their 12 words or primary device) naming the new address.
    const to = new MemoryAdapter();
    const location = 'https://alice-new.example/tl/';
    w.storages.set(location, to);
    const kp = generateX25519KeyPair();
    const moved: SharingKey = { keyPair: kp, cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location }), vaultDataKey: generateVaultDataKey() };
    const there = new SyncEngine({ store: alice.store, state: new MemoryStateStore(), sharing: moved, device: alice.signer, storage: to, readAdapter: w.readAdapter, fullCheckMs: 0 });
    there.book.records = { ...alice.engine.book.records };
    there.own!.touchVault();
    expect((await there.sync()).ok).toBe(true);
    // The old storage keeps the newest index: the redirect.
    await user.storage.put('index.json', (await to.get('index.json'))!.data);
    const r = await bob.engine.sync();
    expect(r.ok).toBe(true);
    expect(r.friends[0]).toMatchObject({ movedTo: location, keyChanged: true });
    expect(bob.engine.book.contact(owner)!.sharingCert.location).toBe(location);
    expect(friendSaves(bob, owner).size).toBe(1);
  });

  it('Tampered content (invalid signature): rejected, the last valid version kept', async () => {
    const { alice, bob, owner } = await pair();
    // Alice publishes a change; the storage host then alters every file it lists.
    alice.store.updateSave('osm:node/1', { comment: 'genuine' });
    await alice.engine.sync();
    for (const { file } of alice.engine.own!.index!.packs) {
      const g = await alice.user.storage.get(file);
      const bad = g!.data.slice();
      bad[bad.length - 1]! ^= 1;
      await alice.user.storage.put(file, bad);
    }
    const r = await bob.engine.sync();
    const p = r.problems.find((x) => x.about === owner)?.problem;
    expect(p).toMatchObject({ kind: 'tampered', situation: 'Tampered content (invalid signature)', message: '{name}\'s content could not be verified', retryable: false });
    expect(p!.message).not.toMatch(/signature|decrypt|pack/i);
    expect(friendSaves(bob, owner).get('osm:node/1')!.comment).toBe('');
  });

  it('Unsupported format version: content ignored, "Update the app to see {name}\'s places"', async () => {
    const { alice, bob, owner } = await pair();
    const g = await alice.user.storage.get('index.json');
    const text = new TextDecoder().decode(g!.data).replace(/"version":4/, '"version":99');
    await alice.user.storage.put('index.json', new TextEncoder().encode(text));
    const r = await bob.engine.sync();
    const p = r.problems.find((x) => x.about === owner)?.problem;
    expect(p).toMatchObject({ kind: 'unsupported', situation: 'Unsupported format version', message: 'Update the app to see {name}\'s places' });
    expect(friendSaves(bob, owner).size).toBe(1); // the last version read stays
  });

  it('I change storage or my sharing key changes: open invitations are no longer listed, records kept until expiry', async () => {
    const w = new World();
    const user: User = makeUser(w, 'alice');
    const a = addDevice(w, user);
    await a.engine.sync();
    const { invitation } = createInvitation(a.signer, user.sharing.cert);
    a.engine.addInvitation(invitation);
    await a.engine.sync();
    expect(invitationStatus(invitation, a.engine.own!.sharing.cert)).toBe('listed');
    const kp = generateX25519KeyPair();
    const next: SharingKey = { keyPair: kp, cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location }), vaultDataKey: generateVaultDataKey() };
    await a.engine.rotateKey(next);
    expect((await a.engine.sync()).ok).toBe(true);
    expect(invitationStatus(invitation, next.cert)).toBe('superseded');
    // Kept in the vault so that answers already sent can still be read.
    expect(a.engine.book.invitations().map((i) => i.invitation.id)).toEqual([invitation.id]);
  });

  it('An invitation record in the vault is invalid (unsigned, by a device declared lost, past its grace period): dropped, the index still published', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const lost = addDevice(w, user);
    await a.engine.sync();
    const now = Date.now();
    const forged = createInvitation(a.signer, user.sharing.cert).invitation;
    const byLost = createInvitation(lost.signer, user.sharing.cert).invitation;
    const old = createInvitation(a.signer, user.sharing.cert, { now: new Date(now - 15 * DAY), ttlMs: 7 * DAY }).invitation;
    const inGrace = createInvitation(a.signer, user.sharing.cert, { now: new Date(now - 9 * DAY), ttlMs: 7 * DAY }).invitation;
    for (const i of [forged, byLost, old, inGrace]) a.engine.addInvitation(i);
    a.engine.book.records = {
      ...a.engine.book.records,
      invitations: a.engine.book.records.invitations.map((r) => (r.id === forged.id ? { ...r, signature: r.signature.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')) } : r)),
    };
    // The lost device is revoked by the current certificate (declared lost without cancelling here).
    const kp = generateX25519KeyPair();
    await a.engine.rotateKey({ keyPair: kp, cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location, revokedDevices: [lost.signer.keys.id] }), vaultDataKey: generateVaultDataKey() });
    const r = await a.engine.sync();
    expect(r.ok).toBe(true);
    expect(r.own!.published).toBe(true);
    expect(r.invitationsDropped).toEqual({ invalid: [forged.id], revoked: [byLost.id], expired: [old.id] });
    expect(a.engine.book.records.invitations.map((x) => x.id)).toEqual([inGrace.id]);
    // The vault on the storage no longer holds them either: another device of mine sees the same.
    const b = addDevice(w, user, { sharing: a.engine.own!.sharing });
    await b.engine.sync();
    expect(b.engine.book.records.invitations.map((x) => x.id)).toEqual([inGrace.id]);
    // Nothing more to drop at the next pass.
    expect((await a.engine.sync()).invitationsDropped).toBeUndefined();
  });

  it('An invitation record cannot be listed yet (clock ahead, newer certificate): not listed, kept, listed later', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    let now = Date.now();
    const a = addDevice(w, user, { now: () => new Date(now) });
    await a.engine.sync();
    const ahead = createInvitation(a.signer, user.sharing.cert, { now: new Date(now + 60 * 60_000) }).invitation;
    const kp = generateX25519KeyPair();
    const newer = issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location });
    const underNewer = createInvitation(a.signer, newer).invitation;
    a.engine.addInvitation(ahead);
    a.engine.addInvitation(underNewer);
    const r = await a.engine.sync();
    expect(r.ok).toBe(true);
    expect(r.invitationsDropped).toBeUndefined();
    expect(invitationStatus(ahead, user.sharing.cert, new Date(now))).toBe('not-yet');
    expect(invitationStatus(underNewer, user.sharing.cert, new Date(now))).toBe('not-yet');
    expect(a.engine.book.records.invitations).toHaveLength(2);
    // The clock catches up: listed.
    now += 2 * 60 * 60_000;
    expect((await a.engine.sync()).ok).toBe(true);
    expect(invitationStatus(ahead, a.engine.own!.sharing.cert, new Date(now))).toBe('listed');
    expect(a.engine.book.records.invitations).toHaveLength(2);
  });

  it('App not opened for a long time: a sync at each opening, nothing in between', async () => {
    const { alice, bob, owner } = await pair();
    const c = clock();
    const runs: string[] = [];
    let armed = 0;
    const timers: Timers = { ...c.timers, setTimeout: () => ++armed, clearTimeout: () => {} };
    const s = new SyncScheduler({ run: async (reason, o) => (runs.push(reason), bob.engine.sync(o)), timers });
    await s.appForeground('launch');
    await s.appBackground();
    const closedAt = runs.length;
    // Months later Alice changed things; nothing ran while the app was closed.
    alice.store.updateSave('osm:node/1', { comment: 'three months later' });
    await alice.engine.sync();
    c.set(100 * DAY);
    expect(runs.length).toBe(closedAt);
    await s.appForeground('launch');
    expect(runs.at(-1)).toBe('launch');
    expect(friendSaves(bob, owner).get('osm:node/1')!.comment).toBe('three months later');
    expect(s.getStatus()).toMatchObject({ state: 'idle', problem: null, banner: false });
  });

  it('Key missing from the phone\'s vault: blocked before any write, the recovery kit is asked', async () => {
    const w = new World();
    const user = makeUser(w, 'alice');
    const a = addDevice(w, user);
    const restored = addDevice(w, user); // still holds rotation 0 only
    await a.engine.sync();
    await restored.engine.sync();
    // A newer key, never delivered to this device (it was not listed when the key changed).
    const kp = generateX25519KeyPair();
    const next: SharingKey = { keyPair: kp, cert: issueSharingCert(user.identity, kp.publicKey, { rotation: 1, location: user.location }), vaultDataKey: generateVaultDataKey() };
    await a.engine.rotateKey(next);
    await a.engine.sync();
    await user.storage.delete(`keys/${restored.signer.keys.id.replace(/^ed25519:/, '')}.bin`);
    const index = (await user.storage.get('index.json'))!.data;
    restored.store.putSave({ place: point(5, 'Not to be published with the old key') });
    const r = await restored.engine.sync();
    expect(ownProblem(r)).toMatchObject({ kind: 'needs-key', situation: 'Key missing from the phone\'s vault', blocksWrites: true, message: 'Enter your recovery kit to keep syncing.' });
    expect(r.own).toBeNull();
    expect((await user.storage.get('index.json'))!.data).toEqual(index); // nothing written
  });
});
