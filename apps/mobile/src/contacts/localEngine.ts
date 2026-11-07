/**
 * A SyncPort of our own, used only while the app's SyncProvider (T-210 wiring) does not provide
 * one (`registerSyncPort`). It builds a SyncEngine from what the app already has: my keys from the
 * secret store, the local database (its sync state in the same SQLite file, table `sync_state`)
 * and the storage's write adapter. It never runs on its own: the contacts service calls it to
 * publish (inviting, accepting, removing) and to read one friend right after answering.
 *
 * Once the SyncProvider exists, it calls `registerSyncPort(engineSyncPort({ engine, … }))` with
 * its own engine and this file can go: two engines must not publish from the same database.
 */
import type { DeviceSigner, SharingKey } from '@triangulair/crypto';
import type { DataStore } from '@triangulair/data';
import type { StorageAdapter } from '@triangulair/storage';
import { SqliteStateStore, SyncEngine } from '@triangulair/sync';

import { checkStoredIdentity, type IdentityRecord } from '../identity/create';
import type { SecretStore } from '../identity/secretStore';
import { engineSyncPort, type SyncPort } from './port';
import { defaultReadAdapter } from './verify';

export async function createLocalSyncPort(o: {
  record: IdentityRecord;
  secrets: SecretStore;
  store: DataStore;
  storage: StorageAdapter | null;
  author?: string;
}): Promise<SyncPort> {
  const [deviceKeys, sharingKey, primaryIdentity] = await Promise.all([o.secrets.get('device-keys'), o.secrets.get('sharing-key'), o.secrets.get('primary-identity')]);
  if (!deviceKeys || !sharingKey) throw new Error('contacts: device keys are missing');
  const { sharing, device } = checkStoredIdentity(o.record, { deviceKeys, sharingKey, primaryIdentity });
  const signer: DeviceSigner = { keys: device, cert: o.record.deviceCert };
  const state = new SqliteStateStore(o.store.repo.db);
  const current: SharingKey = sharing;
  const engine = new SyncEngine({
    store: o.store,
    state,
    sharing: current,
    device: signer,
    ...(o.storage && current.cert.location !== undefined && { storage: o.storage }),
    readAdapter: defaultReadAdapter,
    ...(o.author && { author: o.author }),
  });
  return engineSyncPort({ engine, state, sharing: () => current.cert, device: () => signer, readAdapter: defaultReadAdapter });
}

// ------------------------------------------------------------------ registry

let external: SyncPort | null = null;
const listeners = new Set<() => void>();

/** The SyncProvider hands its engine's port over here (null when it stops). */
export function registerSyncPort(port: SyncPort | null): void {
  external = port;
  for (const l of [...listeners]) l();
}

export function registeredSyncPort(): SyncPort | null {
  return external;
}

export function onSyncPortChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
