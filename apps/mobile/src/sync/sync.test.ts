import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import {
  devicePublicKeys,
  generateDeviceKeys,
  generateVaultDataKey,
  generateX25519KeyPair,
  issueSharingCert,
  identityFromPhrase,
  issueDeviceCert,
  ready,
  verifyIndex,
  type SharingCert,
} from '@triangulair/crypto';
import { DataStore } from '@triangulair/data';
import { MemoryAdapter, StorageError, type StorageAdapter } from '@triangulair/storage';
import { MemoryStateStore, SqliteStateStore, SyncEngine, classifyError, type SyncProblem, type SyncStatus } from '@triangulair/sync';

import { SqlJsDriver } from '../data/sqljsDriver';
import { createIdentity, type CreatedIdentity } from '../identity/create';
import { rotateStoredSharingKey } from '../storage/certify';
import type { StorageConfig } from '../storage/config';
import type { StorageAccess } from '../storage/interfaces';
import { ForeignIndexError, SyncController, clearStaleIndex } from './controller';
import { ALL_FRIENDS, isShown, parseSelection, serializeSelection, toggleFriend } from './friendsSelection';
import { openSyncKeys, parseSyncKeys, serializeSyncKeys } from './keys';
import { ageParts, friendNote, ownNote, sinceParts } from './problems';
import { WhatsNewLog, filterEntries, groupByDay, placesOf, type WhatsNewEntry } from './whatsNew';

await ready();
const SQL = await initSqlJs();

let ids = 0;
function openStore(meId: string) {
  const driver = new SqlJsDriver(new SQL.Database());
  const store = DataStore.open({ driver, meId, actor: (++ids).toString(16).padStart(32, '0'), newId: () => `id${++ids}` });
  return { driver, store };
}

/** Friends' read addresses → storages (what HTTPS reaches). */
const world = new Map<string, StorageAdapter>();
const readAdapter = (loc: string) => {
  const a = world.get(loc);
  if (!a) throw new StorageError('NETWORK', `no server at ${loc}`);
  return a;
};

interface User {
  name: string;
  created: CreatedIdentity;
  sharingKey: string;
  syncKeys: string | null;
  location: string;
  storage: MemoryAdapter;
  config: StorageConfig;
  redirects: { config: StorageConfig; adapter: StorageAdapter; keepUntil: number }[];
  republishPending: boolean;
  store: DataStore;
  ctl: SyncController;
  wiped: string[];
  data: number;
}

function cfg(location: string): StorageConfig {
  return { kind: 'webdav', flavor: 'generic', url: `${location}dav/`, username: 'u', password: 'p', readUrl: location, conditionalWrites: true } as StorageConfig;
}

function makeUser(name: string): User {
  const created = createIdentity({ primary: true });
  const location = `https://${name}.example/tl/`;
  // Connecting a storage certifies its read address (rotation 1).
  const rot = rotateStoredSharingKey(created.record, created.secrets, { location }, { kind: 'primary' });
  const storage = new MemoryAdapter();
  world.set(location, storage);
  const { driver, store } = openStore(created.record.owner);
  const u = {
    name, created, sharingKey: rot.sealedForThisDevice, syncKeys: null, location, storage, config: cfg(location), redirects: [], republishPending: false, store, wiped: [], data: 0,
  } as unknown as User;
  const access: StorageAccess = {
    config: () => u.config,
    writeAdapter: () => u.storage,
    readAdapter: () => u.storage,
    readAddress: () => u.location,
    redirects: () => u.redirects,
    republishPending: () => u.republishPending,
    markRepublished: async () => {
      u.republishPending = false;
    },
  };
  u.ctl = new SyncController({
    store,
    state: new SqliteStateStore(driver),
    loadKeys: async () => openSyncKeys(created.record, { deviceKeys: created.secrets.deviceKeys, sharingKey: u.sharingKey, syncKeys: u.syncKeys }),
    saveKeys: async () => {},
    access,
    readAdapter,
    wipe: {
      secrets: async () => void u.wiped.push('secrets'),
      data: async () => {
        u.wiped.push('data');
        store.wipe();
      },
    },
    onData: () => void u.data++,
    onChange: () => {},
    author: () => name,
  });
  return u;
}

const place = (id: number, name: string) => ({
  osm: { type: 'node' as const, id },
  name,
  category: 'amenity=restaurant',
  geometry: { type: 'Point' as const, coordinates: [2.35 + id * 1e-4, 48.85 + id * 1e-4] },
});

const theirPlaces = (u: User, owner: string) =>
  u.store.repo.db.all<{ name: string; comment: string }>(
    `SELECT p.name, s.comment FROM saves s JOIN places p ON p.id = s.place_id WHERE s.owner_id = ? ORDER BY p.name`,
    [owner],
  );

async function friends(a: User, b: User) {
  await a.ctl.refresh();
  await b.ctl.refresh();
  // B follows A; A shares with B (the invitation flows do this, T-208).
  await b.ctl.addContact({ location: a.location, owner: a.created.record.owner, name: a.name, follow: true, share: false });
  await a.ctl.addContact({ location: b.location, name: b.name, follow: false, share: true });
  await a.ctl.refresh();
  await b.ctl.refresh();
}

describe('SyncController', () => {
  it('publishes, a friend reads the shared places only, edits reach What\'s new, revocation drops them', async () => {
    const a = makeUser('anna');
    const b = makeUser('ben');
    a.store.putSave({ place: place(1, 'Chez Lili'), comment: 'Great pizza' });
    a.store.putSave({ place: place(2, 'Secret bar'), sharing: 'private' });
    a.store.putSave({ place: place(3, 'Café Nuit'), commentVisibility: 'private', comment: 'mine only' });
    await friends(a, b);

    const owner = a.created.record.owner;
    expect(theirPlaces(b, owner)).toEqual([
      { name: 'Café Nuit', comment: '' },
      { name: 'Chez Lili', comment: 'Great pizza' },
    ]);
    expect(b.store.repo.getPerson(owner)?.displayName).toBe('anna');
    // First read of someone: one grouped entry, not one per place.
    const first = b.ctl.whatsNew.entries();
    expect(first).toMatchObject([{ kind: 'followed', owner, count: 2 }]);
    const snap = b.ctl.snapshot();
    expect(snap.friends).toMatchObject([{ owner, name: 'anna', follow: true, places: 2, problem: null }]);
    expect(snap.friends[0]!.lastSuccess).not.toBeNull();
    expect(snap.status.lastSuccess).not.toBeNull();
    b.ctl.whatsNew.markVisited(Date.now());
    expect(b.ctl.snapshot().unseen).toBe(0);

    // A edits: a new comment and a new place.
    a.store.updateSave('osm:node/1', { comment: 'Best pizza in town', status: 'favorite' });
    a.store.putSave({ place: place(4, 'Le Marais Deli') });
    await new Promise((r) => setTimeout(r, 5));
    await a.ctl.refresh();
    await b.ctl.refresh();
    const news = b.ctl.whatsNew.entries().filter((e) => e.kind !== 'followed');
    expect(news.map((e) => [e.kind, e.name]).sort()).toEqual([['added', 'Le Marais Deli'], ['comment', 'Chez Lili'], ['status', 'Chez Lili']]);
    expect(news.find((e) => e.kind === 'comment')?.comment).toBe('Best pizza in town');
    expect(b.ctl.snapshot().unseen).toBe(3);
    expect(b.data).toBeGreaterThan(0);

    // A stops sharing with B: B's cache drops A's places, and their news.
    await a.ctl.setPolicy(b.created.record.owner, { share: false });
    await a.ctl.refresh();
    await b.ctl.refresh();
    expect(theirPlaces(b, owner)).toEqual([]);
    expect(b.ctl.whatsNew.entries().filter((e) => e.placeId)).toEqual([]);
  });

  it('storage move: publishes at the new storage, leaves the signed redirect, friends follow it', async () => {
    const a = makeUser('carla');
    const b = makeUser('dan');
    a.store.putSave({ place: place(10, 'Bistro') });
    await friends(a, b);

    // The move screen copied every file, then certified the new address (rotation + 1).
    const oldLoc = a.location;
    const old = a.storage;
    const next = new MemoryAdapter();
    for (const [path, e] of old.store) await next.put(path, e.data);
    const newLoc = 'https://carla-new.example/tl/';
    world.set(newLoc, next);
    const created = { ...a.created, secrets: { ...a.created.secrets, sharingKey: a.sharingKey } };
    const rot = rotateStoredSharingKey(created.record, created.secrets, { location: newLoc }, { kind: 'primary' });
    a.sharingKey = rot.sealedForThisDevice;
    a.location = newLoc;
    a.storage = next;
    a.config = cfg(newLoc);
    a.redirects = [{ config: cfg(oldLoc), adapter: old, keepUntil: Date.now() + 1e9 }];
    await a.ctl.publishAfterMove({ cert: rot.cert, to: next, redirects: [old] });

    const at = (s: MemoryAdapter) => verifyIndex(s.store.get('index.json')!.data, { expectedOwner: a.created.record.owner });
    expect(at(next).sharing_cert.location).toBe(newLoc);
    expect(at(next).sharing_cert.rotation).toBe(2);
    // The old storage holds the same index: the redirect.
    expect(new TextDecoder().decode(old.store.get('index.json')!.data)).toBe(new TextDecoder().decode(next.store.get('index.json')!.data));

    a.store.putSave({ place: place(11, 'After the move') });
    await a.ctl.refresh();
    await b.ctl.refresh();
    expect(theirPlaces(b, a.created.record.owner).map((p) => p.name)).toEqual(['After the move', 'Bistro']);
    expect(b.ctl.whatsNew.entries().map((e) => e.kind)).toContain('moved');
    expect(b.ctl.snapshot().friends[0]!.problem).toBeNull();
  });

  it('republishPending: the next pass publishes the index at the storage and every redirect', async () => {
    const a = makeUser('eva');
    a.store.putSave({ place: place(20, 'Somewhere') });
    await a.ctl.refresh();
    const old = a.storage;
    const next = new MemoryAdapter();
    for (const [path, e] of old.store) await next.put(path, e.data);
    const newLoc = 'https://eva-new.example/tl/';
    world.set(newLoc, next);
    const rot = rotateStoredSharingKey(a.created.record, { ...a.created.secrets, sharingKey: a.sharingKey }, { location: newLoc }, { kind: 'primary' });
    a.sharingKey = rot.sealedForThisDevice;
    a.storage = next;
    a.config = cfg(newLoc);
    a.redirects = [{ config: cfg(a.location), adapter: old, keepUntil: Date.now() + 1e9 }];
    a.republishPending = true;
    await a.ctl.rebuild();
    await a.ctl.refresh();
    expect(a.republishPending).toBe(false);
    const idx = (s: MemoryAdapter) => verifyIndex(s.store.get('index.json')!.data, { expectedOwner: a.created.record.owner });
    expect(idx(next).sharing_cert.location).toBe(newLoc);
    expect(idx(old).sharing_cert.location).toBe(newLoc);
    expect(a.ctl.snapshot().status.problem).toBeNull();
  });

  it('an index of someone else at the new storage is never overwritten', async () => {
    const a = makeUser('fay');
    const z = makeUser('zed');
    await z.ctl.refresh();
    const cert = openSyncKeys(a.created.record, { deviceKeys: a.created.secrets.deviceKeys, sharingKey: a.sharingKey, syncKeys: null }).sharing.cert;
    await expect(clearStaleIndex(z.storage, cert)).rejects.toBeInstanceOf(ForeignIndexError);
    expect(z.storage.store.has('index.json')).toBe(true);
  });

  it('remote wipe: a device declared lost erases its keys and database at its next sync', async () => {
    const a = makeUser('gus');
    a.store.putSave({ place: place(30, 'Mine') });
    await a.ctl.refresh();
    // My other device declares this one lost: new certificate revoking it, published on my storage.
    const identity = identityFromPhrase(a.created.phrase);
    const keys = generateDeviceKeys();
    const signer = { keys, cert: issueDeviceCert(identity, devicePublicKeys(keys)) };
    const kp = generateX25519KeyPair();
    const sharing = {
      keyPair: kp,
      cert: issueSharingCert(identity, kp.publicKey, { rotation: 2, location: a.location, revokedDevices: [a.created.record.deviceId] }),
      vaultDataKey: generateVaultDataKey(),
    };
    const other = openStore(a.created.record.owner);
    const engine2 = new SyncEngine({ store: other.store, state: new MemoryStateStore(), sharing, device: signer, storage: a.storage });
    const r2 = await engine2.sync();
    expect(r2.own?.published).toBe(true);

    await a.ctl.refresh();
    expect(a.wiped).toEqual(['secrets', 'data']);
    const snap = a.ctl.snapshot();
    expect(snap.wiped).toBe(true);
    expect(snap.status.state).toBe('wiped');
    // Nothing runs again.
    await a.ctl.refresh();
    expect(a.wiped).toEqual(['secrets', 'data']);
  });

  it('open invitations under the previous certificate are listed as cancelled', async () => {
    const a = makeUser('hal');
    await a.ctl.refresh();
    const prev = openSyncKeys(a.created.record, { deviceKeys: a.created.secrets.deviceKeys, sharingKey: a.sharingKey, syncKeys: null }).sharing.cert;
    expect(await a.ctl.openInvitations(prev as SharingCert)).toEqual([]);
  });
});

describe('error mapping (spec "Error cases")', () => {
  const base: SyncStatus = { state: 'idle', foreground: true, online: true, pending: 0, lastSuccess: 1, failingSince: null, problem: null, banner: false };
  const problem = (e: unknown, about: 'own' | 'friend' = 'own', online = true): SyncProblem => classifyError(e, about, online);

  it('my storage', () => {
    expect(ownNote(base, true)).toBeNull();
    expect(ownNote({ ...base, online: false, state: 'offline', pending: 3 }, true)).toMatchObject({ key: 'sync.note.offlinePending', params: { count: 3 } });
    expect(ownNote({ ...base, online: false, state: 'offline', pending: 3 }, false)).toMatchObject({ key: 'sync.note.offline' });
    // Unreachable: nothing at first, the banner after 24 h.
    const down = problem(new StorageError('NETWORK', 'x'));
    expect(ownNote({ ...base, problem: down, failingSince: 1 }, true)).toBeNull();
    expect(ownNote({ ...base, problem: down, failingSince: 1, banner: true }, true)).toMatchObject({ key: 'sync.note.banner', tone: 'warning' });
    // Credentials rejected: writes stop, "Reconnect your storage" leads to the storage settings.
    const auth = problem(new StorageError('AUTH', 'x', { status: 401 }));
    expect(ownNote({ ...base, state: 'blocked', problem: auth }, true)).toMatchObject({ key: 'sync.note.reconnect', action: 'storage', tone: 'error' });
    expect(ownNote({ ...base, problem: problem(new StorageError('PROTOCOL', 'x', { status: 507 })) }, true)).toMatchObject({ key: 'sync.note.quota' });
    expect(ownNote({ ...base, problem: { ...auth, kind: 'needs-key' }, state: 'blocked' }, true)).toMatchObject({ key: 'sync.note.needsKey' });
    expect(ownNote({ ...base, problem: { ...down, kind: 'tampered', retryable: false } }, true)).toMatchObject({ key: 'sync.note.ownTampered' });
    expect(ownNote({ ...base, problem: { ...down, kind: 'unsupported', retryable: false } }, true)).toMatchObject({ key: 'sync.note.ownUnsupported' });
    expect(ownNote({ ...base, problem: { ...down, kind: 'conflict' } }, true)).toBeNull();
    expect(ownNote({ ...base, state: 'wiped' }, true)).toBeNull();
  });

  it('a friend', () => {
    const now = 100 * 86_400_000;
    expect(friendNote(null, null, now)).toMatchObject({ key: 'sync.friend.waiting' });
    expect(friendNote(null, now - 60_000, now)).toMatchObject({ key: 'sync.friend.ok' });
    const down = problem(new StorageError('NETWORK', 'x'), 'friend');
    expect(friendNote(down, now - 12 * 86_400_000, now)).toMatchObject({ key: 'sync.friend.updatedAgo', params: { ageMs: 12 * 86_400_000 }, tone: 'warning' });
    expect(friendNote(down, null, now)).toMatchObject({ key: 'sync.friend.never' });
    expect(friendNote({ ...down, kind: 'tampered', retryable: false }, now, now)).toMatchObject({ key: 'sync.friend.tampered' });
    expect(friendNote({ ...down, kind: 'unsupported', retryable: false }, now, now)).toMatchObject({ key: 'sync.friend.unsupported' });
    expect(friendNote({ ...down, kind: 'identity-moved', retryable: false }, now, now)).toMatchObject({ key: 'sync.friend.identityMoved' });
    expect(friendNote({ ...down, kind: 'too-large', retryable: true }, now - 1, now)).toMatchObject({ key: 'sync.friend.updatedAgo' });
  });

  it('ages and days', () => {
    expect(ageParts(30_000)).toEqual({ key: 'age.now', count: 0 });
    expect(ageParts(5 * 60_000)).toEqual({ key: 'age.minutes', count: 5 });
    expect(ageParts(12 * 86_400_000)).toEqual({ key: 'age.days', count: 12 });
    expect(ageParts(70 * 86_400_000)).toEqual({ key: 'age.months', count: 2 });
    const now = new Date(2026, 9, 23, 18, 30).getTime();
    expect(sinceParts(new Date(2026, 9, 22, 9).getTime(), now).key).toBe('since.yesterday');
    expect(sinceParts(new Date(2026, 9, 23, 1).getTime(), now).key).toBe('since.today');
    expect(sinceParts(new Date(2026, 9, 18).getTime(), now).key).toBe('since.date');
  });
});

describe("What's new", () => {
  const kv = () => new MemoryStateStore();
  const report = (owner: string, wn: Partial<{ added: string[]; changed: { placeId: string; meaningful: boolean; fields: string[] }[]; removed: string[] }>, extra = {}) => ({
    owner, status: 'updated' as const, whatsNew: { added: [], changed: [], removed: [], ...wn }, downloaded: { packs: 0, bytes: 0 }, ...extra,
  });
  const ctx = (now: number, first: string[] = []) => ({
    now,
    firstRead: new Set(first),
    placeName: (id: string) => `Name ${id}`,
    theirSave: (_o: string, id: string) => ({ comment: id === 'p2' ? 'New comment' : '', status: id === 'p3' ? 'tried' : null }),
  });

  it('records meaningful changes only, groups by day, filters, forgets removed places', () => {
    const log = new WhatsNewLog(kv());
    const day1 = new Date(2026, 9, 22, 12).getTime();
    const day2 = new Date(2026, 9, 23, 12).getTime();
    log.record([report('lea', { added: ['p1', 'p9'] })], ctx(day1, ['lea']));
    expect(log.entries()).toMatchObject([{ kind: 'followed', count: 2, placeIds: ['p1', 'p9'] }]);
    log.markVisited(day1 + 1);
    log.record(
      [
        report('lea', {
          added: ['p4'],
          changed: [
            { placeId: 'p2', meaningful: true, fields: ['comment'] },
            { placeId: 'p3', meaningful: true, fields: ['status'] },
            { placeId: 'p5', meaningful: false, fields: ['details'] },
          ],
        }, { keyChanged: true }),
        report('sam', {}, { movedTo: 'https://new.example/' }),
        { ...report('max', { added: ['x'] }), status: 'error' as const },
      ],
      ctx(day2),
    );
    expect(log.entries().map((e) => e.kind).sort()).toEqual(['added', 'comment', 'followed', 'key', 'moved', 'status']);
    expect(log.unseen()).toBe(5);
    const groups = groupByDay(log.entries(), day2 + 3_600_000);
    expect(groups.map((g) => [g.daysAgo, g.entries.length])).toEqual([[0, 5], [1, 1]]);
    expect(filterEntries(log.entries(), { type: 'comments', owner: null }).map((e) => e.placeId)).toEqual(['p2']);
    expect(filterEntries(log.entries(), { type: 'people', owner: 'sam' }).map((e) => e.kind)).toEqual(['moved']);
    expect(placesOf(filterEntries(log.entries(), { type: 'places', owner: 'lea' })).sort()).toEqual(['p1', 'p4', 'p9']);
    // p2 left Léa's shared places: its comment goes.
    log.record([report('lea', { removed: ['p2'] })], ctx(day2 + 10));
    expect(log.entries().some((e: WhatsNewEntry) => e.placeId === 'p2')).toBe(false);
    log.forget('lea');
    expect(log.entries().map((e) => e.owner)).toEqual(['sam']);
  });
});

describe('friends shown and stored keys', () => {
  it('selection: all, none, some; remembered as versioned JSON', () => {
    expect(parseSelection(null)).toEqual(ALL_FRIENDS);
    expect(parseSelection('{bad')).toEqual(ALL_FRIENDS);
    expect(parseSelection(serializeSelection({ mode: 'some', ids: ['b', 'a', 'a'] }))).toEqual({ mode: 'some', ids: ['a', 'b'] });
    const all = ['a', 'b', 'c'];
    let s = toggleFriend(ALL_FRIENDS, 'b', all);
    expect(s).toEqual({ mode: 'some', ids: ['a', 'c'] });
    expect(isShown(s, 'b')).toBe(false);
    s = toggleFriend(s, 'b', all);
    expect(s).toEqual(ALL_FRIENDS);
    expect(toggleFriend({ mode: 'some', ids: ['a'] }, 'a', all)).toEqual({ mode: 'none' });
    expect(isShown({ mode: 'none' }, 'a')).toBe(false);
  });

  it('previous keys round trip; a broken entry gives none', () => {
    const k = { previousSharingKeys: [{ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) }], previousVaultKeys: [{ key: new Uint8Array(32).fill(3), rotation: 2, revoked: ['ed25519:x'] }] };
    expect(parseSyncKeys(serializeSyncKeys(k))).toEqual(k);
    expect(parseSyncKeys('nope')).toEqual({ previousSharingKeys: [], previousVaultKeys: [] });
  });
});
