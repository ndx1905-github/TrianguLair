/**
 * T-206 / T-207 end to end at the controller level (in-memory storages, real SQLite, real
 * crypto): Anna adds a second device by link + code, both converge on the same places, the new
 * device is listed in Settings › Devices on both; Anna declares it lost from the first device: the
 * key goes to no one else, open invitations are cancelled, the lost device erases itself at its next
 * pass, Ben keeps reading Anna with her new key and is told; the changes the lost device made can be
 * reverted. Then the theft of the primary device: an identity move that Ben follows.
 */
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { fromB64Url, issueDeviceCert, ready, toB64Url, verifyIndex } from '@triangulair/crypto';
import { DataStore, reassignOwner } from '@triangulair/data';
import { MemoryAdapter, ReadOnly, StorageError, type StorageAdapter } from '@triangulair/storage';
import { SqliteStateStore, keyPath } from '@triangulair/sync';

import { SqlJsDriver } from '../data/sqljsDriver';
import { createIdentity, parseDeviceKeys, type IdentityRecord } from '../identity/create';
import { masterIdentity, rotateStoredSharingKey } from '../storage/certify';
import type { StorageConfig } from '../storage/config';
import type { StorageAccess } from '../storage/interfaces';
import { encodeRecoveryCopy, recoveryCopyFor } from '../identity/recovery';
import { SyncController } from '../sync/controller';
import { openSyncKeys, sealForThisDevice, serializeSyncKeys } from '../sync/keys';
import { decodePendingMove, encodePendingMove, joinedIdentity, moveIdentity } from './identity';
import { changesSince } from './journal';
import { LinkReceiver, LinkSender, lastDigits } from './sessions';

await ready();
const SQL = await initSqlJs();

const world = new Map<string, StorageAdapter>();
function readOnly(a: StorageAdapter): StorageAdapter {
  return {
    capabilities: { ...a.capabilities, readOnly: true },
    get: (p, o) => a.get(p, o),
    head: (p) => a.head(p),
    put: async (p) => {
      throw new ReadOnly(p);
    },
    delete: async (p) => {
      throw new ReadOnly(p);
    },
    list: (p) => a.list(p),
  };
}
const readAdapter = (loc: string) => {
  const a = world.get(loc);
  if (!a) throw new StorageError('NETWORK', `no server at ${loc}`);
  return readOnly(a);
};

let ids = 0;
interface Dev {
  name: string;
  record: IdentityRecord;
  deviceKeys: string;
  sharingKey: string;
  syncKeys: string | null;
  primaryIdentity: string | null;
  recoveryCopy: string | null;
  store: DataStore;
  driver: SqlJsDriver;
  ctl: SyncController;
  wiped: string[];
}

function cfg(location: string): StorageConfig {
  return { kind: 'webdav', flavor: 'generic', url: `${location}dav/`, username: 'u', password: 'p', readUrl: location, conditionalWrites: true };
}

function device(name: string, init: Omit<Dev, 'store' | 'ctl' | 'wiped' | 'name' | 'driver'>, storage: MemoryAdapter, location: string, reuse?: SqlJsDriver): Dev {
  const driver = reuse ?? new SqlJsDriver(new SQL.Database());
  const store = DataStore.open({ driver, meId: init.record.owner, actor: (++ids).toString(16).padStart(32, '0'), newId: () => `id${++ids}` });
  const d = { name, ...init, store, driver, wiped: [] as string[] } as Dev;
  const config = cfg(location);
  const access: StorageAccess = {
    config: () => config,
    writeAdapter: () => storage,
    readAdapter: () => readOnly(storage),
    readAddress: () => location,
    redirects: () => [],
    republishPending: () => false,
    markRepublished: async () => {},
  };
  d.ctl = new SyncController({
    store,
    state: new SqliteStateStore(driver),
    loadKeys: async () => openSyncKeys(d.record, { deviceKeys: d.deviceKeys, sharingKey: d.sharingKey, syncKeys: d.syncKeys }),
    saveKeys: async (k) => {
      d.syncKeys = serializeSyncKeys(k);
      d.sharingKey = sealForThisDevice(k.sharing, d.record);
    },
    access,
    readAdapter,
    wipe: {
      secrets: async () => void d.wiped.push('secrets'),
      data: async () => {
        d.wiped.push('data');
        store.wipe();
      },
    },
    onData: () => {},
    onChange: () => {},
    author: () => name,
    device: () => ({ name, added: d.record.createdAt, primary: !!d.primaryIdentity }),
    recoveryCopy: async (sharing) => {
      const r = recoveryCopyFor(sharing, { stored: d.recoveryCopy, primaryIdentity: d.primaryIdentity });
      if (r?.store) d.recoveryCopy = r.store;
      return r?.copy ?? null;
    },
  });
  return d;
}

function person(name: string) {
  const created = createIdentity({ primary: true });
  const location = `https://${name}.example/tl/`;
  const rot = rotateStoredSharingKey(created.record, created.secrets, { location }, { kind: 'primary' });
  const storage = new MemoryAdapter();
  world.set(location, storage);
  const d = device(name, {
    record: created.record, deviceKeys: created.secrets.deviceKeys, sharingKey: rot.sealedForThisDevice, syncKeys: null,
    primaryIdentity: created.secrets.primaryIdentity, recoveryCopy: encodeRecoveryCopy(rot.vaultCopy, rot.cert),
  }, storage, location);
  return { created, location, storage, d };
}

const place = (id: number, name: string) => ({ osm: { type: 'node' as const, id }, name, category: 'amenity=restaurant', geometry: { type: 'Point' as const, coordinates: [2.35 + id * 1e-4, 48.85 + id * 1e-4] } });
const mine = (d: Dev) => d.store.repo.db.all<{ place_id: string; comment: string }>(`SELECT place_id, comment FROM saves WHERE owner_id = ? AND deleted_at IS NULL ORDER BY place_id`, [d.record.owner]);
const theirs = (d: Dev, owner: string) => d.store.repo.db.all<{ place_id: string; comment: string }>(`SELECT place_id, comment FROM saves WHERE owner_id = ? ORDER BY place_id`, [owner]);

describe('adding a device and declaring it lost', () => {
  it('link + code, both see the same places, declared lost: wiped at its next pass, Ben follows the new key', async () => {
    const anna = person('anna');
    const ben = person('ben');
    const a1 = anna.d;
    a1.store.putSave({ place: place(1, 'Chez Lili'), comment: 'pizza' });
    a1.store.putSave({ place: place(2, 'Secret'), sharing: 'private' });
    await a1.ctl.refresh();
    await ben.d.ctl.refresh();
    await ben.d.ctl.addContact({ location: anna.location, owner: a1.record.owner, name: 'Anna', follow: true, share: false });
    await a1.ctl.addContact({ location: ben.location, name: 'Ben', follow: false, share: true });
    await a1.ctl.refresh();
    await ben.d.ctl.refresh();
    expect(theirs(ben.d, a1.record.owner).map((r) => r.place_id)).toEqual(['osm:node/1']);
    // The first device lists itself; the recovery copy is on the storage.
    expect(a1.ctl.devices().map((x) => [x.name, x.primary ?? false])).toEqual([['anna', true]]);
    expect(await anna.storage.get(keyPath(a1.record.owner))).not.toBeNull();

    // Link + code from a1 (primary).
    const sender = new LinkSender({
      storage: anna.storage,
      location: anna.location,
      sharing: async () => (await openSyncKeys(a1.record, { deviceKeys: a1.deviceKeys, sharingKey: a1.sharingKey, syncKeys: null })).sharing,
      certify: async (pub, master) => issueDeviceCert(masterIdentity(a1.record, { deviceKeys: a1.deviceKeys, sharingKey: a1.sharingKey, primaryIdentity: a1.primaryIdentity }, master), pub),
      register: (cert, name) => a1.ctl.addDevice(cert, name),
      trackSlot: (s, e) => a1.ctl.trackSlot(s, e),
    });
    await sender.start();
    const s = sender.state;
    if (s.phase !== 'waiting') throw new Error(s.phase);
    const receiver = new LinkReceiver({ readAdapter, writeAdapter: () => anna.storage }, 'tablet');
    await receiver.open(s.link, s.code);
    const w = receiver.state;
    if (w.phase !== 'waiting') throw new Error(w.phase);
    // The new device's request link comes back to a1; the user types the last 4 digits it shows.
    sender.received(w.requestLink);
    await sender.approve({ kind: 'primary' }, lastDigits(w.fingerprint));
    expect(sender.state.phase).toBe('sent');
    await receiver.poll();
    const r = receiver.state;
    if (r.phase !== 'approved') throw new Error(r.phase);
    await sender.poll();
    expect(sender.state.phase).toBe('done');
    // The storage settings came from the vault (written by a1's controller).
    expect(r.joined.storage).toEqual(cfg(anna.location));
    expect(r.joined.profileName).toBe('anna');
    const j = joinedIdentity(r.joined, Date.now());
    const a2 = device('tablet', { record: j.record, deviceKeys: j.secrets.deviceKeys, sharingKey: j.secrets.sharingKey, syncKeys: null, primaryIdentity: null, recoveryCopy: null }, anna.storage, anna.location);

    // Both see the same places (a2 pulls my document from the storage).
    await a2.ctl.refresh();
    expect(mine(a2)).toEqual(mine(a1));
    a2.store.putSave({ place: place(3, 'From the tablet') });
    await a2.ctl.refresh();
    await a1.ctl.refresh();
    expect(mine(a1).map((x) => x.place_id)).toEqual(['osm:node/1', 'osm:node/2', 'osm:node/3']);
    expect(a1.ctl.devices().map((x) => x.name)).toEqual(['anna', 'tablet']);
    expect(a2.ctl.devices().map((x) => x.name)).toEqual(['anna', 'tablet']);
    await a1.ctl.renameDevice(j.record.deviceId, 'Anna’s tablet');
    await a1.ctl.refresh();
    await a2.ctl.refresh();
    expect(a2.ctl.devices().map((x) => x.name)).toEqual(['anna', 'Anna’s tablet']);

    // The tablet is stolen: the thief edits a place, which a1 imports.
    a2.store.updateSave('osm:node/1', { comment: 'vandalised' });
    await a2.ctl.refresh();
    const theftAt = Date.now() - 1;
    await a1.ctl.refresh();
    expect(mine(a1).find((x) => x.place_id === 'osm:node/1')!.comment).toBe('vandalised');

    // A link-only list, whose key the stolen tablet holds (my document).
    const list = a1.store.createList({ name: 'Brunch', kind: 'manual', visibility: 'link', items: ['osm:node/1'] });
    const oldLink = await a1.ctl.newListLink(list);
    expect((await ben.d.ctl.previewList(oldLink)).count).toBe(1);

    // Declared lost from a1 with the master key.
    const rot = rotateStoredSharingKey(a1.record, { deviceKeys: a1.deviceKeys, sharingKey: a1.sharingKey, primaryIdentity: a1.primaryIdentity }, { revokeDevices: [j.record.deviceId], newKey: true }, { kind: 'primary' });
    a1.sharingKey = rot.sealedForThisDevice;
    const res = await a1.ctl.declareLost(rot, { cancelInvitations: true });
    expect(res.delivered).toEqual([]);
    // The link-only list got a new link: the old one (known to the thief) opens nothing any more.
    expect(res.renewedLinks).toEqual([{ id: list, name: 'Brunch' }]);
    const newLink = a1.ctl.listLink(list)!;
    expect(newLink).not.toBe(oldLink);
    await expect(ben.d.ctl.previewList(oldLink)).rejects.toMatchObject({ gone: 'link-dead' });
    expect((await ben.d.ctl.previewList(newLink)).count).toBe(1);
    const idx = verifyIndex((await anna.storage.get('index.json'))!.data, { expectedOwner: a1.record.owner });
    expect(idx.revoked_devices).toEqual([j.record.deviceId]);
    expect(idx.sharing_cert.rotation).toBe(2);
    expect(a1.ctl.devices().find((x) => x.cert.device === j.record.deviceId)!.removed).toBeDefined();
    // The phrase copy follows the new key.
    expect(fromB64Url(toB64Url((await anna.storage.get(keyPath(a1.record.owner)))!.data))).toEqual(rot.vaultCopy);

    // The lost device erases itself at its next pass.
    await a2.ctl.refresh();
    expect(a2.ctl.snapshot().wiped).toBe(true);
    expect(a2.wiped).toEqual(['secrets', 'data']);

    // Ben keeps reading Anna with her new key, and is told.
    a1.store.putSave({ place: place(4, 'After') });
    await a1.ctl.refresh();
    await ben.d.ctl.refresh();
    expect(theirs(ben.d, a1.record.owner).map((x) => x.place_id)).toEqual(['osm:node/1', 'osm:node/3', 'osm:node/4']);
    expect(ben.d.ctl.whatsNew.entries().some((e) => e.kind === 'key' && e.owner === a1.record.owner)).toBe(true);

    // What the lost device changed since the theft, reverted from the local copy.
    const lines = changesSince(a1.ctl.journal(), theftAt, [j.record.deviceId]);
    expect(lines.map((l) => [l.change.placeId, l.kind, l.revertible])).toEqual([['osm:node/1', 'edited', true]]);
    a1.ctl.revert(lines[0]!.entryAt, 'osm:node/1');
    expect(mine(a1).find((x) => x.place_id === 'osm:node/1')!.comment).toBe('pizza');
    expect(changesSince(a1.ctl.journal(), theftAt)[0]!.reverted).toBe(true);
  });

  it('theft of the primary device: identity move published, Ben follows it', async () => {
    const anna = person('anna2');
    const ben = person('ben2');
    const a1 = anna.d;
    a1.store.putSave({ place: place(1, 'Chez Lili'), comment: 'pizza' });
    await a1.ctl.refresh();
    await ben.d.ctl.refresh();
    await ben.d.ctl.addContact({ location: anna.location, owner: a1.record.owner, name: 'Anna', follow: true, share: false, verified: true });
    await a1.ctl.addContact({ location: ben.location, name: 'Ben', follow: false, share: true });
    await a1.ctl.refresh();
    await ben.d.ctl.refresh();
    const oldOwner = a1.record.owner;

    // On another device of hers (here: the same one, its master key considered stolen), the 12 words.
    const keys = openSyncKeys(a1.record, { deviceKeys: a1.deviceKeys, sharingKey: a1.sharingKey, syncKeys: null });
    const moved = moveIdentity(anna.created.phrase, a1.record, parseDeviceKeys(a1.deviceKeys), keys.sharing, Date.now());
    // Recorded first (resumable), then the old controller stops: the old index stays until the
    // new identity is stored and publishes (review F-08).
    const pending = decodePendingMove(encodePendingMove(moved, oldOwner))!;
    expect(pending.record.owner).toBe(moved.record.owner);
    expect(pending.previousSharing.secretKey).toEqual(moved.previousSharing.secretKey);
    const oldIndex = (await anna.storage.get('index.json'))!.data;
    await a1.ctl.prepareIdentityMove();
    expect(verifyIndex((await anna.storage.get('index.json'))!.data, { expectedOwner: oldOwner }).owner).toBe(oldOwner);
    // The app then switches this device to the new identity (new controller, database reassigned).
    a1.ctl.stop();
    reassignOwner(a1.driver, oldOwner, moved.record.owner);
    const a1b = device('anna', {
      record: moved.record, deviceKeys: moved.secrets.deviceKeys, sharingKey: moved.secrets.sharingKey,
      syncKeys: serializeSyncKeys({ previousSharingKeys: [moved.previousSharing], previousVaultKeys: [] }),
      primaryIdentity: moved.secrets.primaryIdentity, recoveryCopy: encodeRecoveryCopy(moved.vaultCopy, moved.sharing.cert),
    }, anna.storage, anna.location, a1.driver);
    expect(mine(a1b).map((x) => x.place_id)).toEqual(['osm:node/1']);
    // The vault records continued under the new owner.
    await a1b.ctl.refresh();
    const idx = verifyIndex((await anna.storage.get('index.json'))!.data, { expectedOwner: moved.record.owner, retiredOwners: [oldOwner] });
    expect(idx.move?.from).toBe(oldOwner);

    await ben.d.ctl.refresh();
    expect(ben.d.ctl.snapshot().friends.map((f) => [f.owner, f.name, f.verified])).toEqual([[moved.record.owner, 'Anna', false]]);
    expect(theirs(ben.d, oldOwner)).toEqual([]);
    expect(theirs(ben.d, moved.record.owner).map((x) => x.place_id)).toEqual(['osm:node/1']);
    expect(ben.d.ctl.whatsNew.entries().some((e) => e.kind === 'identity' && e.owner === moved.record.owner)).toBe(true);
    // Whoever still holds the storage access puts the old identity's index back: the next pass replaces it.
    await anna.storage.put('index.json', oldIndex);
    a1b.store.putSave({ place: place(5, 'After the move') });
    await a1b.ctl.refresh();
    expect(verifyIndex((await anna.storage.get('index.json'))!.data, { expectedOwner: moved.record.owner, retiredOwners: [oldOwner] }).move?.from).toBe(oldOwner);
  });
});
