/**
 * Contract between the storage settings (T-203, this folder) and the sync engine
 * (`packages/sync`, T-204). The sync engine never reads the storage config or the secret store
 * itself: the app hands it these objects.
 *
 * - `StorageAccess`  (app → sync): where to publish, with which adapter, at which certified
 *   read address, and which older storages still hold a redirect.
 * - `SharingCertRotation` (app → sync, certify.ts): issue rotation r + 1 with the master key
 *   (storage move here; declaration of loss / key change in T-207).
 * - `StorageMoveHooks` (sync → app): after a move is certified, publish the newest index signed
 *   with the new certificate at the new storage and replace the index of every previous storage
 *   with that same index (the signed redirect), and list the open invitations it cancelled.
 *   Until the sync engine provides them, the app sets `StorageState.republishPending` and the
 *   engine does it on its next run (`StorageAccess.republishPending` / `markRepublished`).
 */
import type { SharingCert } from '@triangulair/crypto';
import type { StorageAdapter } from '@triangulair/storage';

import type { StorageConfig } from './config';

export type { SharingCertRotation, CertChange, MasterKeySource, RotationResult } from './certify';

export interface StorageAccess {
  /** The current storage, or null (local only: publish nothing). */
  config(): StorageConfig | null;
  /** Adapter with my credentials for the current storage (read-only for HTTPS mode). */
  writeAdapter(): StorageAdapter | null;
  /** Anonymous HTTPS adapter at the read address (what friends see). */
  readAdapter(): StorageAdapter | null;
  /** The certified read address (`sharing_cert.location`); index.json is right under it. */
  readAddress(): string | null;
  /** Older storages still holding the signed redirect, newest first, with their adapters. */
  redirects(): { config: StorageConfig; adapter: StorageAdapter; keepUntil: number }[];
  /** The certificate changed and the index was not republished with it yet. */
  republishPending(): boolean;
  /** Called by the sync engine once the index is published at the current storage and every redirect. */
  markRepublished(): Promise<void>;
}

export interface OpenInvitationSummary {
  /** Name the owner gave to the person invited. */
  name: string;
  createdAt: number;
}

export interface StorageMoveHooks {
  /**
   * Publish the newest index, signed with `cert` (its `location` is the new read address), at
   * `to`, then put the same index at every `redirects` storage. Packs were already copied.
   */
  publishAfterMove(args: { cert: SharingCert; to: StorageAdapter; redirects: StorageAdapter[] }): Promise<void>;
  /** Invitations still open under `previous` (created before the move, not answered): now cancelled. */
  openInvitations(previous: SharingCert): Promise<OpenInvitationSummary[]>;
}

let hooks: StorageMoveHooks | null = null;

/** The sync engine registers its hooks on start (none in phase 1). */
export function registerStorageMoveHooks(h: StorageMoveHooks | null): void {
  hooks = h;
}

export function storageMoveHooks(): StorageMoveHooks | null {
  return hooks;
}
