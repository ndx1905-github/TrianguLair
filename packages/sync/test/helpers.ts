// SPDX-License-Identifier: MPL-2.0
import {
  devicePublicKeys,
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateVaultDataKey,
  generateX25519KeyPair,
  identityFromPhrase,
  issueDeviceCert,
  issueSharingCert,
  verifyIndex,
  type DeviceSigner,
  type Identity,
  type SharingKey,
  type SignedIndex,
} from '@triangulair/crypto';
import { DataStore } from '@triangulair/data';
import { NodeSqliteDriver } from '@triangulair/data/node';
import { MemoryAdapter, ReadOnly, type StorageAdapter } from '@triangulair/storage';
import { SyncEngine, type SyncEngineOptions } from '../src/engine.ts';
import { MemoryStateStore, SqliteStateStore, type SyncStateStore } from '../src/state.ts';

/** Locations → storages: what friends reach over "HTTPS". */
export class World {
  readonly storages = new Map<string, StorageAdapter>();
  readAdapter = (location: string): StorageAdapter => {
    const s = this.storages.get(location);
    if (!s) throw new Error(`no storage at ${location}`);
    return readOnly(s);
  };
}

/** A read-only view (friends never write). */
export function readOnly(a: StorageAdapter): StorageAdapter {
  return {
    capabilities: { ...a.capabilities, readOnly: true, list: false },
    get: (p) => a.get(p),
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

export interface User {
  name: string;
  identity: Identity;
  owner: string;
  location: string;
  storage: StorageAdapter;
  sharing: SharingKey;
  devices: Device[];
}

export interface Device {
  user: User;
  signer: DeviceSigner;
  store: DataStore;
  state: SyncStateStore;
  engine: SyncEngine;
  driver: NodeSqliteDriver;
}

export function makeUser(world: World, name: string, opts: { storage?: StorageAdapter; location?: string } = {}): User {
  const identity = identityFromPhrase(generateRecoveryPhrase());
  const location = opts.location ?? `https://${name}.example/tl/`;
  const kp = generateX25519KeyPair();
  const sharing: SharingKey = { keyPair: kp, cert: issueSharingCert(identity, kp.publicKey, { rotation: 0, location }), vaultDataKey: generateVaultDataKey() };
  const storage = opts.storage ?? new MemoryAdapter();
  world.storages.set(location, storage);
  return { name, identity, owner: identity.owner, location, storage, sharing, devices: [] };
}

let actorN = 0;
export function addDevice(world: World, user: User, extra: Partial<SyncEngineOptions> & { sqliteState?: boolean } = {}): Device {
  const keys = generateDeviceKeys();
  const signer: DeviceSigner = { keys, cert: issueDeviceCert(user.identity, devicePublicKeys(keys)) };
  const driver = new NodeSqliteDriver(':memory:');
  const store = DataStore.open({ driver, meId: user.owner, actor: `actor-${user.name}-${++actorN}` });
  const state = extra.sqliteState ? new SqliteStateStore(driver) : new MemoryStateStore();
  const engine = new SyncEngine({
    store,
    state,
    sharing: user.sharing,
    device: signer,
    storage: user.storage,
    readAdapter: world.readAdapter,
    fullCheckMs: 0,
    ...extra,
  });
  const d: Device = { user, signer, store, state, engine, driver };
  user.devices.push(d);
  return d;
}

/** Reads `owner`'s current index at their address, as an invitation or return link would make a contact. */
export async function indexOf(world: World, user: User): Promise<SignedIndex> {
  const g = await world.readAdapter(user.location).get('index.json');
  if (!g) throw new Error(`${user.name} has not published`);
  return verifyIndex(g.data, { expectedOwner: user.owner, location: user.location });
}

/** Makes `a` share with `b` and `b` follow `a` (both must have published once). */
export async function befriend(world: World, a: Device, b: Device, opts: { mutual?: boolean } = {}): Promise<void> {
  b.engine.addContact(await indexOf(world, a.user), { follow: true, share: !!opts.mutual });
  a.engine.addContact(await indexOf(world, b.user), { follow: !!opts.mutual, share: true });
}

export function point(id: number, name: string, lat = 48.85 + id * 1e-4, lon = 2.35 + id * 1e-4) {
  return { osm: { type: 'node' as const, id }, name, category: 'amenity=restaurant', geometry: { type: 'Point' as const, coordinates: [lon, lat] } };
}

/** Friends' saves of `owner` in `d`'s cache, by place id. */
export function friendSaves(d: Device, owner: string): Map<string, { comment: string; status: string | null }> {
  const rows = d.store.repo.db.all<{ place_id: string; comment: string; status: string | null }>(
    `SELECT place_id, comment, status FROM saves WHERE owner_id = ? ORDER BY place_id`,
    [owner],
  );
  return new Map(rows.map((r) => [r.place_id, { comment: r.comment, status: r.status }]));
}

/** Storage adapter wrapper that counts requests. */
export function counting(a: StorageAdapter): StorageAdapter & { counts: Record<string, number> } {
  const counts: Record<string, number> = { get: 0, head: 0, put: 0, delete: 0, list: 0 };
  return {
    counts,
    capabilities: a.capabilities,
    get: (p) => (counts.get!++, a.get(p)),
    head: (p) => (counts.head!++, a.head(p)),
    put: (p, d, o) => (counts.put!++, a.put(p, d, o)),
    delete: (p, o) => (counts.delete!++, a.delete(p, o)),
    list: (p) => (counts.list!++, a.list(p)),
  };
}
