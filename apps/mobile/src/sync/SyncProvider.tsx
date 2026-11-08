/**
 * React side of the sync (T-210): one `SyncController` per identity and database, driven by the
 * app's life cycle (launch, foreground, background: a last pass, then nothing), the network status,
 * and my edits (`onLocalEdit`, debounced publication). Registers the storage screens' move hooks,
 * shows "This device was removed" after a remote wipe, and gives the screens the status, the people
 * I follow and What's new.
 *
 * The invitation and contacts screens (T-208/T-209) use this controller's engine: the provider
 * registers `controller.port()` with `registerSyncPort` (and again after each new engine), reads
 * every friend with the invitation keys of links I answered (`invitations-received`, until they
 * accept), and names contacts and invitations from the ContactsService.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import type { DeviceCert, SharingCert, SharingKey } from '@triangulair/crypto';
import { SqliteStateStore, type DeviceEntry } from '@triangulair/sync';

import { onLocalEdit, useMaybeData } from '../data/DataProvider';
import { clearSettings } from '../data/deviceSettings';
import { useIdentity } from '../identity/IdentityProvider';
import { SECRET_KEYS } from '../identity/secretStore.types';
import { parseReceived } from '../contacts/local';
import { registerSyncPort, registeredContactsService } from '../contacts/registry';
import { receivedKeysFor } from '../contacts/service';
import { registerStorageMoveHooks } from '../storage/interfaces';
import { useStorage } from '../storage/StorageProvider';
import { parseConfig } from '../storage/config';
import type { OpenInvitationSummary } from '../storage/interfaces';
import type { JournalEntry } from '../devices/journal';
import { deviceName, staleSync } from '../devices/local';
import { staleSyncAction } from '../identity/lock';
import { StaleSyncLock } from './StaleSyncLock';
import { SyncController, type ControllerSnapshot } from './controller';
import { DeviceRemoved } from './DeviceRemoved';
import { openSyncKeys, sealForThisDevice, serializeSyncKeys } from './keys';
import type { WhatsNewEntry } from './whatsNew';

export interface SyncApi {
  snapshot: ControllerSnapshot | null;
  /** Pull to refresh / "Sync now". */
  refresh(): Promise<void>;
  /** After reconnecting the storage. */
  resume(): Promise<void>;
  whatsNew(): WhatsNewEntry[];
  lastVisit(): number;
  markVisited(): void;
  log(): string[];
  /** A name given on the contacts screens: their person row. */
  nameContact(owner: string, name: string): void;
  /** Settings › Devices (T-206): my devices listed in the vault. */
  devices(): DeviceEntry[];
  addDevice(cert: DeviceCert, name: string): Promise<void>;
  renameDevice(id: string, name: string): Promise<void>;
  /** A transfer slot (adding a device) whose files are deleted at expiry. */
  trackSlot(slot: string, expiresAt: number): void;
  /** T-207: after the master key issued the new certificate. */
  declareLost(r: { sharing: SharingKey; vaultCopy: Uint8Array; previous: SharingCert }, opts: { cancelInvitations: boolean }): Promise<{ cancelled: OpenInvitationSummary[]; delivered: string[] }>;
  /** What my other devices changed in my places (changes since a theft). */
  journal(): JournalEntry[];
  revert(entryAt: number, placeId: string): void;
  /** Before switching to a new identity (theft of the primary device). */
  prepareIdentityMove(next: { owner: string; deviceCert: DeviceCert; deviceName: string; added: number }): Promise<void>;
}

const SyncContext = createContext<SyncApi | null>(null);

function webOnline(): boolean {
  return Platform.OS !== 'web' || typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const identity = useIdentity();
  const storage = useStorage();
  const data = useMaybeData();
  const [snapshot, setSnapshot] = useState<ControllerSnapshot | null>(null);
  const [wiped, setWiped] = useState(false);
  const ctl = useRef<SyncController | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const accessRef = useRef(storage.access);
  accessRef.current = storage.access;
  const storageRef = useRef(storage);
  storageRef.current = storage;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const profileName = identity.state.kind === 'ready' ? identity.state.profile.name : '';
  const nameRef = useRef(profileName);
  nameRef.current = profileName;

  const record = identity.state.kind === 'ready' ? identity.state.record : null;
  const secrets = identity.secrets;
  const store = data?.store ?? null;
  const ready = !!record && !!secrets && !!store && storage.loaded;

  useEffect(() => {
    if (!ready || !record || !secrets || !store) return;
    let alive = true;
    const c = new SyncController({
      store,
      state: new SqliteStateStore(store.repo.db),
      access: accessRef.current,
      loadKeys: async () => {
        const [deviceKeys, sharingKey, syncKeys] = await Promise.all([secrets.get('device-keys'), secrets.get('sharing-key'), secrets.get('sync-keys')]);
        if (!deviceKeys || !sharingKey) throw new Error('sync: device keys are missing');
        return openSyncKeys(record, { deviceKeys, sharingKey, syncKeys });
      },
      saveKeys: async (k) => {
        await secrets.set('sync-keys', serializeSyncKeys(k));
        await secrets.set('sharing-key', sealForThisDevice(k.sharing, record));
      },
      wipe: {
        secrets: async () => {
          for (const k of SECRET_KEYS) await secrets.remove(k).catch(() => {});
        },
        data: async () => {
          try {
            store.wipe();
          } finally {
            await dataRef.current?.erase().catch(() => {});
            clearSettings();
          }
        },
      },
      onData: () => dataRef.current?.refresh(),
      onChange: () => {
        if (!alive) return;
        const s = c.snapshot();
        setSnapshot(s);
        if (s.wiped) setWiped(true);
      },
      author: () => nameRef.current || undefined,
      invitationName: (id) => registeredContactsService()?.invitationName(id),
      contactName: (owner) => registeredContactsService()?.contact(owner)?.name,
      friendKeys: async () => {
        const now = Date.now();
        const received = parseReceived(await secrets.get('invitations-received'), now);
        return (owner) => receivedKeysFor(received, owner, now);
      },
      onEngine: () => {
        if (alive) registerSyncPort(c.port());
      },
      device: () => ({ name: deviceName(), added: record.createdAt, primary: identityRef.current.state.kind === 'ready' && identityRef.current.state.record.primary }),
      recoveryCopy: () => secrets.get('recovery-copy'),
      onStorageValue: async (v) => {
        await storageRef.current.updateCurrent(parseConfig(v));
      },
    });
    ctl.current = c;
    registerStorageMoveHooks(c);
    c.setOnline(webOnline());
    setSnapshot(c.snapshot());
    void c.foreground('launch');

    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void c.foreground('foreground');
      else if (s === 'background') void c.background();
    });
    const offEdit = onLocalEdit(() => c.localChange());
    const net = () => c.setOnline(webOnline());
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.addEventListener('online', net);
      window.addEventListener('offline', net);
    }
    return () => {
      alive = false;
      sub.remove();
      offEdit();
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('online', net);
        window.removeEventListener('offline', net);
      }
      registerStorageMoveHooks(null);
      registerSyncPort(null);
      c.stop();
      if (ctl.current === c) ctl.current = null;
    };
    // One controller per identity and database.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, record?.owner, secrets, store]);

  // A connect, a move or a new certificate: rebuild the engine on the new settings.
  const storageKey = `${storage.state.current?.readUrl ?? ''} ${storage.state.current ? JSON.stringify(storage.state.current) : ''} ${storage.state.republishPending}`;
  const firstKey = useRef<string | null>(null);
  useEffect(() => {
    const c = ctl.current;
    if (!c) return;
    if (firstKey.current === null) {
      firstKey.current = storageKey;
      return;
    }
    if (firstKey.current === storageKey) return;
    firstKey.current = storageKey;
    void c.rebuild().then(() => c.refresh()).catch((e: unknown) => console.warn('Could not rebuild the sync engine', e));
  }, [storageKey, snapshot?.ready]);

  const refresh = useCallback(async () => ctl.current?.refresh(), []);
  const nameContact = useCallback((owner: string, name: string) => ctl.current?.nameContact(owner, name), []);
  const api = useMemo<SyncApi>(
    () => ({
      snapshot,
      refresh,
      resume: async () => ctl.current?.resume(),
      whatsNew: () => ctl.current?.whatsNew.entries() ?? [],
      lastVisit: () => ctl.current?.whatsNew.lastVisit() ?? 0,
      markVisited: () => {
        const c = ctl.current;
        if (!c) return;
        c.whatsNew.markVisited(Date.now());
        setSnapshot(c.snapshot());
      },
      log: () => ctl.current?.log() ?? [],
      nameContact,
      devices: () => ctl.current?.devices() ?? [],
      addDevice: async (cert, name) => {
        if (!ctl.current) throw new Error('sync not ready');
        await ctl.current.addDevice(cert, name);
      },
      renameDevice: async (id, name) => ctl.current?.renameDevice(id, name),
      trackSlot: (slot, expiresAt) => ctl.current?.trackSlot(slot, expiresAt),
      declareLost: async (r, opts) => {
        if (!ctl.current) throw new Error('sync not ready');
        return ctl.current.declareLost(r, opts);
      },
      journal: () => ctl.current?.journal() ?? [],
      revert: (at, placeId) => ctl.current?.revert(at, placeId),
      prepareIdentityMove: async (next) => {
        if (!ctl.current) throw new Error('sync not ready');
        await ctl.current.prepareIdentityMove(next);
      },
    }),
    [snapshot, refresh, nameContact],
  );

  // "Lock, or even wipe, if no successful sync for N days" (spec "Protections on the device").
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const stale = useMemo(
    () => staleSyncAction(staleSync(), snapshot?.lastOwnSuccess ?? null, Date.now(), !!snapshot?.publishes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, tick],
  );
  useEffect(() => {
    if (stale === 'wipe') void ctl.current?.wipeNow().catch((e: unknown) => console.warn('Could not wipe this device', e));
  }, [stale]);

  useEffect(() => {
    if (wiped) registerSyncPort(null);
  }, [wiped]);

  if (wiped) return <DeviceRemoved />;
  return (
    <SyncContext.Provider value={api}>
      {children}
      {stale === 'lock' && <StaleSyncLock days={staleSync()?.days ?? 0} onSync={refresh} />}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncApi {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync() outside SyncProvider');
  return ctx;
}

export function useMaybeSync(): SyncApi | null {
  return useContext(SyncContext);
}
