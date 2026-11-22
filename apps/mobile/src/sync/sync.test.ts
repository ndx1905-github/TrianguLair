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
import { memoryKV, memorySecrets } from '../contacts/local';
import { createContactsService, type ContactsService } from '../contacts/service';
import { ForeignIndexError, SyncController, clearStaleIndex, vaultContactNames, type ControllerDeps } from './controller';
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

function makeUser(name: string, extra: Partial<ControllerDeps> = {}): User {
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
    ...extra,
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
  it('gives the contacts screens a port over its own engine: invitation, names, invitation keys at every pass', async () => {
    const services = new Map<string, ContactsService>();
    const engines: string[] = [];
    const hooks = (who: string): Partial<ControllerDeps> => ({
      contactName: (owner) => services.get(who)?.contact(owner)?.name,
      invitationName: (id) => services.get(who)?.invitationName(id),
      friendKeys: async () => (owner) => services.get(who)?.invitationKeysFor(owner) ?? [],
      onEngine: () => engines.push(who),
    });
    const a = makeUser('ines', hooks('ines'));
    const b = makeUser('jules', hooks('jules'));
    expect(a.ctl.port()).toBeNull();
    a.store.putSave({ place: place(41, 'Chez Ines'), comment: 'shared' });
    await a.ctl.refresh();
    await b.ctl.refresh();
    expect(engines).toEqual(['ines', 'jules']);
    for (const u of [a, b]) {
      const port = u.ctl.port()!;
      expect(port.owner).toBe(u.created.record.owner);
      expect(u.ctl.port()).toBe(port);
      // onName goes to the controller, as the ContactsProvider wires it.
      services.set(u.name, await createContactsService({ port, local: memoryKV(), secrets: memorySecrets(), onName: (o, n) => u.ctl.nameContact(o, n) }));
    }
    const ines = services.get('ines')!;
    const jules = services.get('jules')!;
    const inv = await ines.createInvitation({ name: 'Jules' });
    expect(await a.ctl.openInvitations(a.ctl.port()!.sharingCert())).toEqual([{ name: 'Jules', createdAt: expect.any(Number) }]);
    const opened = await jules.openInvitation(inv.link);
    const { link } = await jules.answerInvitation(opened.token, { name: 'Inès', shareBack: true });
    expect(theirPlaces(b, a.created.record.owner)).toEqual([{ name: 'Chez Ines', comment: 'shared' }]);
    // Regular passes before Inès accepts: still read with the invitation key.
    a.store.putSave({ place: place(42, 'Second') });
    await a.ctl.refresh();
    await b.ctl.refresh();
    expect(theirPlaces(b, a.created.record.owner).map((p) => p.name)).toEqual(['Chez Ines', 'Second']);
    expect(b.ctl.snapshot().friends).toMatchObject([{ name: 'Inès', follow: true, places: 2 }]);
    // Her first place, read right after answering (not in a pass), is in What's new too.
    expect(b.ctl.whatsNew.entries().map((e) => [e.kind, e.name])).toEqual(expect.arrayContaining([['added', 'Chez Ines'], ['added', 'Second']]));

    await ines.receiveAnswer(link);
    const answer = ines.answers(inv.id)!;
    await ines.acceptAnswer(inv.id, b.created.record.owner, { name: answer.names[b.created.record.owner]!, share: { kind: 'all' }, follow: true });
    await a.ctl.refresh();
    await b.ctl.refresh();
    // The name typed when inviting is the contact's name (not "A friend").
    expect(a.ctl.snapshot().friends).toMatchObject([{ name: 'Jules', follow: true, share: true }]);
    expect(theirPlaces(b, a.created.record.owner)).toHaveLength(2);
    // Her storage holds one index, published by her one engine.
    const idx = verifyIndex((await a.storage.get('index.json'))!.data, { expectedOwner: a.created.record.owner });
    expect(idx.sharing_cert.location).toBe(a.location);
  });

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

  it('a friend unreachable for 3 months: keep their places (asked again 3 months later) or remove them', async () => {
    let now = Date.now();
    const a = makeUser('ivy');
    const b = makeUser('jon', { now: () => now });
    a.store.putSave({ place: place(40, 'Chez Ivy') });
    await friends(a, b);
    const line = () => b.ctl.snapshot().friends.find((f) => f.owner === a.created.record.owner)!;
    expect(line().places).toBe(1);
    // Her storage stops answering; months pass.
    world.delete(a.location);
    await b.ctl.refresh();
    const l = line();
    expect(l.problem).toMatchObject({ kind: 'unreachable', retryable: true });
    expect(l.places).toBe(1); // still shown from the cache
    now = l.lastSuccess! + 91 * 86_400_000;
    expect(friendNote(l.problem, l.lastSuccess, now, l.keptAt)).toMatchObject({ id: 'stale', action: 'keep-or-remove' });
    // Keep: the offer is gone until 3 more months pass.
    b.ctl.keepFriend(a.created.record.owner);
    expect(line().keptAt).toBe(now);
    expect(friendNote(l.problem, l.lastSuccess, now + 86_400_000, line().keptAt).id).toBe('updated-ago');
    expect(friendNote(l.problem, l.lastSuccess, now + 91 * 86_400_000, line().keptAt).id).toBe('stale');
    // Remove: I stop following her, her places leave my cache (she is still a contact).
    await b.ctl.setPolicy(a.created.record.owner, { follow: false });
    expect(line()).toMatchObject({ follow: false, places: 0 });
    world.set(a.location, a.storage);
  });

  it('space used on my storage by content type (sync status screen)', async () => {
    const a = makeUser('kim');
    a.store.putSave({ place: place(50, 'Chez Kim') });
    await a.ctl.refresh();
    const s = await a.ctl.spaceUsed();
    expect(s).not.toBeNull();
    expect(s!.document).toBeGreaterThan(0);
    expect(s!.keys).toBeGreaterThan(0);
    expect(s!.total).toBe(s!.places + s!.document + s!.lists + s!.public + s!.photos + s!.keys + s!.other);
    expect(await makeUser('lou').ctl.spaceUsed()).toBeNull(); // not built yet: nothing listed
  });
});

describe('contact names in the vault (restore with the kit)', () => {
  const A = 'ed25519:' + 'A'.repeat(43);
  const B = 'ed25519:' + 'B'.repeat(43);
  const of = (value: unknown) => vaultContactNames({ value: <T,>() => (value === undefined ? undefined : { value: value as T, at: 0, by: A }) });
  it('reads the names given on my other devices, defensively', () => {
    expect(of({ [A]: ' Ben ', [B]: 'Léa' })).toEqual({ [A]: 'Ben', [B]: 'Léa' });
    expect(of(undefined)).toEqual({});
    expect(of(['Ben'])).toEqual({});
    expect(of('Ben')).toEqual({});
    expect(of({ [A]: 42, notAKey: 'x', [B]: '   ' })).toEqual({});
    expect(of({ [A]: 'x'.repeat(500) })[A]).toHaveLength(80);
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

describe('stored keys', () => {
  it('previous keys round trip; a broken entry gives none', () => {
    const k = { previousSharingKeys: [{ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) }], previousVaultKeys: [{ key: new Uint8Array(32).fill(3), rotation: 2, revoked: ['ed25519:x'] }] };
    expect(parseSyncKeys(serializeSyncKeys(k))).toEqual(k);
    expect(parseSyncKeys('nope')).toEqual({ previousSharingKeys: [], previousVaultKeys: [] });
  });
});

describe('SyncController: shared lists (T-211, T-212)', () => {
  it('Anna makes a link; Ben, not her contact, previews and follows it; a new link cuts him off', async () => {
    const anna = makeUser('anna-lists');
    const ben = makeUser('ben-lists');
    anna.store.putSave({ place: place(1, 'Chez Lili'), comment: 'Public', commentVisibility: 'public' });
    anna.store.putSave({ place: place(2, 'Bistro'), comment: 'Friends only' });
    anna.store.putSave({ place: place(3, 'Home'), sharing: 'private' });
    const list = anna.store.createList({ name: 'Brunch', kind: 'manual', visibility: 'link', items: ['osm:node/1', 'osm:node/2', 'osm:node/3'] });
    await anna.ctl.refresh();
    await ben.ctl.refresh();
    expect(anna.ctl.listLink(list)).toBeNull(); // no link before "Create the link"
    const fragment = await anna.ctl.newListLink(list);
    expect(anna.ctl.listLink(list)).toBe(fragment);

    const p = await ben.ctl.previewList(fragment);
    expect(p).toMatchObject({ name: 'Brunch', author: 'anna-lists', count: 2 });
    const r = await ben.ctl.followList(fragment);
    expect(r.status).toBe('updated');
    expect(ben.ctl.snapshot().friends).toEqual([]); // not a contact
    expect(theirPlaces(ben, r.id)).toEqual([{ name: 'Bistro', comment: '' }, { name: 'Chez Lili', comment: 'Public' }]);
    expect(ben.ctl.followedLists()).toMatchObject([{ id: r.id, name: 'Brunch', count: 2, gone: null }]);
    // Its first places are one What's new entry, named after the list.
    expect(ben.ctl.whatsNew.entries()).toMatchObject([{ owner: r.id, kind: 'followed', count: 2 }]);
    expect(ben.store.repo.getPerson(r.id)?.displayName).toBe('Brunch');

    // New link: Ben's next pass says the link no longer works, and the places leave.
    const fresh = await anna.ctl.newListLink(list);
    expect(fresh).not.toBe(fragment);
    await ben.ctl.refresh();
    expect(ben.ctl.followedLists()[0]).toMatchObject({ gone: 'link-dead', count: 0 });
    expect(theirPlaces(ben, r.id)).toEqual([]);
    await expect(ben.ctl.previewList(fragment)).rejects.toMatchObject({ gone: 'link-dead' });
    expect((await ben.ctl.previewList(fresh)).count).toBe(2);

    await ben.ctl.unfollowList(r.id);
    expect(ben.ctl.followedLists()).toEqual([]);
  });

  it('a link that could not be published is not shown (review Info 7); leaving link-only kills it (L-01)', async () => {
    const anna = makeUser('anna-offline');
    anna.store.putSave({ place: place(1, 'Open') });
    const list = anna.store.createList({ name: 'Weekend', kind: 'manual', visibility: 'link', items: ['osm:node/1'] });
    await anna.ctl.refresh();
    const put = anna.storage.put.bind(anna.storage);
    anna.storage.put = async () => {
      throw new Error('storage down');
    };
    await expect(anna.ctl.newListLink(list)).rejects.toThrow();
    expect(anna.ctl.listLink(list)).toBeNull();
    anna.storage.put = put;
    const fragment = await anna.ctl.newListLink(list);
    expect(anna.ctl.listLink(list)).toBe(fragment);
    await anna.ctl.setListVisibility(list, 'public');
    await anna.ctl.setListVisibility(list, 'link');
    expect(anna.ctl.listLink(list)).toBeNull(); // "Create the link" again: a new key
  });

  it('public: the file address and uMap; friends picked for a list see it', async () => {
    const anna = makeUser('anna-pub');
    const ben = makeUser('ben-pub');
    anna.store.putSave({ place: place(1, 'Open') });
    const list = anna.store.createList({ name: 'Weekend', kind: 'manual', visibility: 'link', items: ['osm:node/1'] });
    await friends(anna, ben);
    // Ben already sees everything Anna shares with friends; picking him gives him the list's name.
    expect(anna.ctl.listViewers(list)).toEqual([]);
    await anna.ctl.setListAccess(list, ben.created.record.owner, true);
    expect(anna.ctl.listViewers(list)).toEqual([ben.created.record.owner]);
    await ben.ctl.refresh();
    expect(ben.ctl.friendLists()).toMatchObject([{ owner: anna.created.record.owner, lists: [{ id: list, name: 'Weekend', items: ['osm:node/1'] }] }]);

    await anna.ctl.setListVisibility(list, 'public');
    const pub = anna.ctl.publicList(list)!;
    expect(pub.file).toBe(`${anna.location}public/lists.geojson`);
    const g = await anna.storage.get('public/lists.geojson');
    const geo = JSON.parse(new TextDecoder().decode(g!.data));
    expect(geo.features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual(['Open']);
    expect(geo.attribution).toContain('OpenStreetMap');
    // Ben can also follow it by its public link.
    const r = await ben.ctl.followList(pub.fragment);
    expect(theirPlaces(ben, r.id)).toEqual([{ name: 'Open', comment: '' }]);
  });
});
