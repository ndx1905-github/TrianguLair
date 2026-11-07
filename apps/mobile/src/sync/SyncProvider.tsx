/**
 * React side of the sync (T-210): one `SyncController` per identity and database, driven by the
 * app's life cycle (launch, foreground, background: a last pass, then nothing), the network status,
 * and my edits (`onLocalEdit`, debounced publication). Registers the storage screens' move hooks,
 * shows "This device was removed" after a remote wipe, and gives the screens the status, the people
 * I follow and What's new.
 *
 * Fixture mode on the web (test builds only) exposes `window.__tlSync` for the end-to-end tests:
 * adding a contact from a read address stands in for the invitation flow (T-208/T-209).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { SqliteStateStore } from '@triangulair/sync';

import { OSM_FIXTURES } from '../config';
import { onLocalEdit, useMaybeData } from '../data/DataProvider';
import { clearSettings } from '../data/deviceSettings';
import { useIdentity } from '../identity/IdentityProvider';
import { SECRET_KEYS } from '../identity/secretStore.types';
import { registerStorageMoveHooks } from '../storage/interfaces';
import { useStorage } from '../storage/StorageProvider';
import { SyncController, type AddContactInput, type ControllerSnapshot } from './controller';
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
  addContact(input: AddContactInput): Promise<string>;
  setPolicy(owner: string, patch: { share?: boolean; follow?: boolean }): Promise<void>;
  removeContact(owner: string): Promise<void>;
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
      addContact: async (input) => {
        if (!ctl.current) throw new Error('sync not ready');
        return ctl.current.addContact(input);
      },
      setPolicy: async (owner, patch) => ctl.current?.setPolicy(owner, patch),
      removeContact: async (owner) => ctl.current?.removeContact(owner),
    }),
    [snapshot, refresh],
  );

  // End-to-end tests (fixture mode, web only): stand-in for the invitation screens.
  useEffect(() => {
    if (!OSM_FIXTURES || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const w = window as unknown as { __tlSync?: unknown };
    w.__tlSync = {
      owner: () => ctl.current?.owner() ?? null,
      addContact: (input: AddContactInput) => api.addContact(input),
      setPolicy: (owner: string, patch: { share?: boolean; follow?: boolean }) => api.setPolicy(owner, patch),
      removeContact: (owner: string) => api.removeContact(owner),
      sync: () => api.refresh(),
      snapshot: () => ctl.current?.snapshot() ?? null,
      whatsNew: () => api.whatsNew(),
    };
  }, [api]);

  if (wiped) return <DeviceRemoved />;
  return <SyncContext.Provider value={api}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncApi {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync() outside SyncProvider');
  return ctx;
}

export function useMaybeSync(): SyncApi | null {
  return useContext(SyncContext);
}
