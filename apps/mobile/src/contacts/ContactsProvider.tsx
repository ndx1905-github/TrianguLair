/**
 * Makes the ContactsService available to the invitation and contacts screens, once my identity,
 * the local database and the SyncProvider's engine are ready. The service sits on the `SyncPort`
 * the SyncProvider registers over its own engine (`registerSyncPort`, registry.ts): there is no
 * other engine, so exactly one publishes from this database. Rebuilt when that port changes (a
 * new engine: storage connected, moved, new certificate).
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useMaybeData } from '../data/DataProvider';
import { getSetting, setSetting } from '../data/deviceSettings';
import { useIdentity } from '../identity/IdentityProvider';
import { useMaybeSync } from '../sync/SyncProvider';
import type { SecretKV } from './local';
import { onSyncPortChange, registerContactsService, registeredSyncPort } from './registry';
import { createContactsService, type ContactsService } from './service';

type Status = { kind: 'loading' } | { kind: 'ready'; service: ContactsService } | { kind: 'error'; error: unknown };

const Ctx = createContext<Status>({ kind: 'loading' });

const settingsKV = { get: getSetting, set: setSetting };

export function ContactsProvider({ children }: { children: ReactNode }) {
  const identity = useIdentity();
  const data = useMaybeData();
  const sync = useMaybeSync();
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [port, setPort] = useState(registeredSyncPort);
  useEffect(() => {
    setPort(registeredSyncPort());
    return onSyncPortChange(() => setPort(registeredSyncPort()));
  }, []);

  const ready = identity.state.kind === 'ready';
  const store = data?.store ?? null;
  const secrets = identity.secrets;
  const nameContact = sync?.nameContact;

  useEffect(() => {
    if (!ready || !store || !secrets || !port) {
      setStatus({ kind: 'loading' });
      return;
    }
    let cancelled = false;
    (async () => {
      const secretKV: SecretKV = { get: (k) => secrets.get(k), set: (k, v) => secrets.set(k, v) };
      const service = await createContactsService({
        port,
        local: settingsKV,
        secrets: secretKV,
        // The name typed in the invitation flow goes to their person row (places, What's new, sync status).
        onName: (owner, n) => nameContact?.(owner, n),
      });
      if (cancelled) return;
      registerContactsService(service);
      setStatus({ kind: 'ready', service });
    })().catch((error: unknown) => {
      console.warn('Contacts could not be opened', error);
      if (!cancelled) setStatus({ kind: 'error', error });
    });
    return () => {
      cancelled = true;
      registerContactsService(null);
    };
    // nameContact is stable (SyncProvider callback).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, store, secrets, port]);

  // A sync pass may have changed the vault (my other devices' invitations and answers, key changes).
  const service = status.kind === 'ready' ? status.service : null;
  const lastPass = sync?.snapshot?.lastPassAt ?? null;
  useEffect(() => {
    if (service && lastPass !== null) service.changed();
  }, [service, lastPass]);

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
