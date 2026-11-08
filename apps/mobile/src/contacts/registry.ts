/**
 * Hand-over between the SyncProvider and the contacts screens (T-208/T-209 ↔ T-210).
 *
 * - The SyncProvider registers the `SyncPort` over its own engine (`SyncController.port()`), and a
 *   new one whenever it builds a new engine; the ContactsProvider builds the ContactsService on it.
 *   There is no other engine: the screens wait (loading) until the port is registered.
 * - The ContactsProvider registers the service back, so the SyncProvider can name contacts and
 *   invitations (`contactName`, `invitationName`).
 */
import type { SyncPort } from './port';
import type { ContactsService } from './service';

let port: SyncPort | null = null;
let service: ContactsService | null = null;
const listeners = new Set<() => void>();

/** The SyncProvider hands its engine's port over here (null when it stops). */
export function registerSyncPort(p: SyncPort | null): void {
  if (p === port) return;
  port = p;
  for (const l of [...listeners]) l();
}

export function registeredSyncPort(): SyncPort | null {
  return port;
}

export function onSyncPortChange(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The ContactsProvider's current service (null while none is built). */
export function registerContactsService(s: ContactsService | null): void {
  service = s;
}

export function registeredContactsService(): ContactsService | null {
  return service;
}
