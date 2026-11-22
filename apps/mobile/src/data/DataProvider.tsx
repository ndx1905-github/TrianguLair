/**
 * Opens the local data store once and shares it with every screen. Reads go
 * straight to the repository (synchronous SQLite); every edit goes through
 * `mutate`, which bumps `version` so that derived data is recomputed.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DataStore, Repository } from '@triangulair/data';

import { DEMO_SEED, OSM_FIXTURES } from '../config';
import { useI18n } from '../i18n';
import { useIdentity } from '../identity/IdentityProvider';
import { movedFrom } from '../devices/local';
import { purgeExpired } from '../trash/model';
import { DEMO_FRIEND, seedDemoData, seedExamples, seedStarterTags } from './demo';
import { EXAMPLES_WANTED_KEY, exampleOptions } from './examples';
import { getSetting, setSetting } from './deviceSettings';
import { openAppStore, type AppStore } from './openStore';

export interface DataState {
  store: DataStore;
  repo: Repository;
  /** Incremented after every change. */
  version: number;
  persistence: AppStore['persistence'];
  /** Is the local database encrypted (gap #7)? */
  encryption: AppStore['encryption'];
  /** Runs an edit and refreshes the screens. */
  mutate: <T>(fn: (store: DataStore) => T) => T;
  /** Redraws after changes made outside `mutate` (the sync engine: friends' cache, my other devices). */
  refresh: () => void;
  /** Deletes the database file (remote wipe, after `store.wipe()`). */
  erase: () => Promise<void>;
  /** Saves pending changes now (web: before the page reloads on a new version). */
  flush: () => Promise<void>;
}

/** Listeners of my own edits (the sync scheduler publishes them, debounced). */
const editListeners = new Set<() => void>();
export function onLocalEdit(fn: () => void): () => void {
  editListeners.add(fn);
  return () => editListeners.delete(fn);
}

function lastChunk(store: DataStore): number {
  try {
    return store.repo.db.get<{ n: number | null }>(`SELECT max(rowid) AS n FROM doc_chunks`)?.n ?? 0;
  } catch {
    return -1;
  }
}

type Status = { kind: 'loading' } | { kind: 'ready'; app: AppStore } | { kind: 'error'; error: unknown };

const DataContext = createContext<DataState | null>(null);
const StatusContext = createContext<Status>({ kind: 'loading' });

export function DataProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [version, setVersion] = useState(0);
  const tRef = useRef(t);
  tRef.current = t;
  const { state: identity, secrets } = useIdentity();
  const meId = identity.kind === 'ready' ? identity.record.owner : null;
  const profile = identity.kind === 'ready' ? identity.profile : null;

  // The store opens once my identity exists (first launch creates it), under its owner id.
  // The secret store holds the database key (native, gap #7): wait for it too.
  const hasSecrets = !!secrets;
  useEffect(() => {
    if (!meId || !hasSecrets) return;
    let cancelled = false;
    openAppStore(meId, movedFrom(), secrets)
      .then((app) => {
        if (cancelled) return;
        // First launch: the starter tags only (beta feedback: no sample places in real users' data).
        // Test builds keep the former seed, which the end-to-end tests rely on.
        if (getSetting('demo-seeded') !== '1') {
          try {
            if (DEMO_SEED) {
              seedDemoData(app.store, {
                tagName: (id) => tRef.current(`demoTag.${id}`),
                subTagName: (id) => tRef.current(`demoTag.${id}`),
                fixtures: OSM_FIXTURES,
              });
            } else {
              seedStarterTags(app.store, (id) => tRef.current(`demoTag.${id}`));
            }
          } catch (e) {
            console.warn('Starter data could not be seeded', e);
          }
          setSetting('demo-seeded', '1');
        }
        try {
          // "Show me with examples" chosen before the store was open: local only (demo.ts).
          if (getSetting(EXAMPLES_WANTED_KEY) === '1') {
            seedExamples(app.store, exampleOptions(tRef.current));
            setSetting(EXAMPLES_WANTED_KEY, 'done');
          }
          // The example friend is marked as one (also for the 0.9.0-beta.1 seed, named "Léa").
          const friend = app.store.repo.getPerson(DEMO_FRIEND.id);
          const name = exampleOptions(tRef.current).friendName;
          if (friend && friend.displayName !== name) app.store.repo.upsertPerson({ id: DEMO_FRIEND.id, displayName: name });
        } catch (e) {
          console.warn('Example places could not be prepared', e);
        }
        // Items in the trash for more than 30 days leave for good (spec "Editing and deleting"; the launch pass
        // publishes the purge to my other devices).
        purgeExpired(app.store);
        setStatus({ kind: 'ready', app });
      })
      .catch((error: unknown) => {
        console.error('Could not open the local database', error);
        if (!cancelled) setStatus({ kind: 'error', error });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meId, hasSecrets]);

  const app = status.kind === 'ready' ? status.app : null;

  // My name and photo, as my friends will see them (people row of "me").
  useEffect(() => {
    if (!app || !profile) return;
    try {
      app.store.repo.upsertPerson({ id: app.store.meId, displayName: profile.name, avatar: profile.avatar, publicKey: app.store.meId });
      setVersion((v) => v + 1);
    } catch (e) {
      console.warn('Could not save the profile', e);
    }
  }, [app, profile?.name, profile?.avatar]);
  const mutate = useCallback(
    <T,>(fn: (store: DataStore) => T): T => {
      if (!app) throw new Error('data store not ready');
      const before = lastChunk(app.store);
      try {
        return fn(app.store);
      } finally {
        setVersion((v) => v + 1);
        // Only edits of my document (not OSM refreshes of the place cache) wait to be published.
        if (editListeners.size && lastChunk(app.store) !== before) for (const l of editListeners) l();
      }
    },
    [app],
  );
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const value = useMemo<DataState | null>(
    () => (app ? { store: app.store, repo: app.store.repo, version, persistence: app.persistence, encryption: app.encryption, mutate, refresh, erase: () => app.erase(), flush: () => app.flush() } : null),
    [app, version, mutate, refresh],
  );

  return (
    <StatusContext.Provider value={status}>
      <DataContext.Provider value={value}>{children}</DataContext.Provider>
    </StatusContext.Provider>
  );
}

export function useDataStatus(): Status {
  return useContext(StatusContext);
}

/** The data store; only call below a screen that checked `useDataStatus()`. */
export function useData(): DataState {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData() outside a ready DataProvider');
  return ctx;
}

export function useMaybeData(): DataState | null {
  return useContext(DataContext);
}
