/**
 * Opens the local data store once and shares it with every screen. Reads go
 * straight to the repository (synchronous SQLite); every edit goes through
 * `mutate`, which bumps `version` so that derived data is recomputed.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DataStore, Repository } from '@triangulair/data';

import { OSM_FIXTURES } from '../config';
import { useI18n } from '../i18n';
import { seedDemoData } from './demo';
import { getSetting, setSetting } from './deviceSettings';
import { openAppStore, type AppStore } from './openStore';

export interface DataState {
  store: DataStore;
  repo: Repository;
  /** Incremented after every change. */
  version: number;
  persistence: AppStore['persistence'];
  /** Runs an edit and refreshes the screens. */
  mutate: <T>(fn: (store: DataStore) => T) => T;
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

  useEffect(() => {
    let cancelled = false;
    openAppStore()
      .then((app) => {
        if (cancelled) return;
        if (getSetting('demo-seeded') !== '1') {
          try {
            seedDemoData(app.store, {
              tagName: (id) => tRef.current(`demoTag.${id}`),
              subTagName: (id) => tRef.current(`demoTag.${id}`),
              fixtures: OSM_FIXTURES,
            });
          } catch (e) {
            console.warn('Demo data could not be seeded', e);
          }
          setSetting('demo-seeded', '1');
        }
        setStatus({ kind: 'ready', app });
      })
      .catch((error: unknown) => {
        console.error('Could not open the local database', error);
        if (!cancelled) setStatus({ kind: 'error', error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const app = status.kind === 'ready' ? status.app : null;
  const mutate = useCallback(
    <T,>(fn: (store: DataStore) => T): T => {
      if (!app) throw new Error('data store not ready');
      try {
        return fn(app.store);
      } finally {
        setVersion((v) => v + 1);
      }
    },
    [app],
  );

  const value = useMemo<DataState | null>(
    () => (app ? { store: app.store, repo: app.store.repo, version, persistence: app.persistence, mutate } : null),
    [app, version, mutate],
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
