/**
 * Makes the ContactsService available to the invitation and contacts screens, once my identity,
 * the local database and the storage settings are loaded. The sync engine comes from the app's
 * SyncProvider when it registered one (`registerSyncPort`), otherwise from `localEngine.ts`.
 * Rebuilt when the storage changes (a new sharing certificate, a new write adapter).
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useMaybeData } from '../data/DataProvider';
import { getSetting, setSetting } from '../data/deviceSettings';
import { useIdentity } from '../identity/IdentityProvider';
import { useStorage } from '../storage/StorageProvider';
import { createLocalSyncPort, onSyncPortChange, registeredSyncPort } from './localEngine';
import type { SecretKV } from './local';
import { createContactsService, type ContactsService } from './service';

type Status = { kind: 'loading' } | { kind: 'ready'; service: ContactsService } | { kind: 'error'; error: unknown };

const Ctx = createContext<Status>({ kind: 'loading' });

const settingsKV = { get: getSetting, set: setSetting };

export function ContactsProvider({ children }: { children: ReactNode }) {
  const identity = useIdentity();
  const storage = useStorage();
  const data = useMaybeData();
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [portVersion, setPortVersion] = useState(0);
  useEffect(() => onSyncPortChange(() => setPortVersion((v) => v + 1)), []);

  const ready = identity.state.kind === 'ready' ? identity.state : null;
  const record = ready?.record ?? null;
  const name = ready?.profile.name ?? '';
  const store = data?.store ?? null;
  const mutate = data?.mutate ?? null;
  const secrets = identity.secrets;
  const storageKey = storage.loaded ? JSON.stringify({ cur: storage.state.current?.readUrl ?? null, w: storage.state.current ? JSON.stringify(storage.state.current) : null }) : null;

  useEffect(() => {
    if (!record || !store || !secrets || storageKey === null) return;
    let cancelled = false;
    (async () => {
      const external = registeredSyncPort();
      const local = external ? null : await createLocalSyncPort({ record, secrets, store, storage: storage.access.writeAdapter(), ...(name && { author: name }) });
      const port = external ?? local!.port;
      const secretKV: SecretKV = { get: (k) => secrets.get(k), set: (k, v) => secrets.set(k, v) };
      const service = await createContactsService({
        port,
        local: settingsKV,
        secrets: secretKV,
        onName: (owner, n) => {
          try {
            mutate?.((s) => s.repo.upsertPerson({ id: owner, displayName: n, publicKey: owner }));
          } catch {
            // The name stays in the contacts list.
          }
        },
      });
      if (cancelled) return;
      setStatus({ kind: 'ready', service });
      // My storage's vault (invitations and answers from my other devices) once pulled.
      void local?.pulled.then(() => {
        service.changed();
        mutate?.(() => undefined);
      });
    })().catch((error: unknown) => {
      console.warn('Contacts could not be opened', error);
      if (!cancelled) setStatus({ kind: 'error', error });
    });
    return () => {
      cancelled = true;
    };
    // storage.access is stable per storage state; storageKey tracks the state itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, store, secrets, storageKey, portVersion]);

  return <Ctx.Provider value={status}>{children}</Ctx.Provider>;
}

export function useContactsStatus(): Status {
  return useContext(Ctx);
}

/** The service, re-rendering on each of its changes; null while loading. */
export function useContacts(): ContactsService | null {
  const status = useContext(Ctx);
  const service = status.kind === 'ready' ? status.service : null;
  const subscribe = useMemo(() => (l: () => void) => (service ? service.subscribe(l) : () => {}), [service]);
  useSyncExternalStore(subscribe, () => service?.version() ?? -1, () => -1);
  return service;
}
