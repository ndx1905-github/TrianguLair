// SPDX-License-Identifier: MPL-2.0
/**
 * Error classification, mapped to the rows of the spec's "Error cases" table.
 * Every sync failure becomes a `SyncProblem` the app can show in plain words;
 * codes and messages are local only (never sent to anyone).
 */
import { RollbackError, StorageMovedError, TLCryptoError } from '@triangulair/crypto';
import { StorageError } from '@triangulair/storage';

/** A payload inside a pack is malformed (`unsupported`: a newer version or kind). */
export class PayloadError extends Error {
  constructor(
    message: string,
    readonly unsupported = false,
  ) {
    super(message);
    this.name = 'PayloadError';
  }
}

/** This device is listed in `revoked_devices` of its owner's verified index: erase keys and content (remote wipe). */
export class DeviceRevokedError extends Error {
  constructor() {
    super('this device was declared lost');
    this.name = 'DeviceRevokedError';
  }
}

/** The owner's index has a newer sharing certificate than this device holds, and no sealed key for it was found. */
export class NeedsKeyError extends Error {
  constructor(readonly rotation: number) {
    super('a newer sharing key exists and was not sent to this device');
    this.name = 'NeedsKeyError';
  }
}

/** A pack would need more wraps than the format allows (MAX_WRAPS). */
export class TooManyRecipientsError extends Error {
  constructor(readonly count: number) {
    super(`a pack would have ${count} recipients (more than the format allows)`);
    this.name = 'TooManyRecipientsError';
  }
}

export type SyncProblemKind =
  | 'offline'
  | 'unreachable'
  | 'auth'
  | 'quota'
  | 'conflict'
  | 'not-found'
  | 'tampered'
  | 'rollback'
  | 'unsupported'
  | 'moved'
  | 'identity-moved'
  | 'device-revoked'
  | 'needs-key'
  | 'too-many-recipients'
  | 'bug';

export interface SyncProblem {
  kind: SyncProblemKind;
  /** Retried automatically (with backoff) by the scheduler. */
  retryable: boolean;
  /** Writes to my storage stop until the user acts (credentials, revoked device, missing key). */
  blocksWrites: boolean;
  /** The spec "Error cases" row this problem belongs to. */
  situation: string;
  /** Plain words for the user (`{name}` = the friend's display name when it is about a friend). */
  message: string;
  /** Technical detail for the local log (never content or keys). */
  detail: string;
}

const P = (
  kind: SyncProblemKind,
  retryable: boolean,
  blocksWrites: boolean,
  situation: string,
  message: string,
  detail: string,
): SyncProblem => ({ kind, retryable, blocksWrites, situation, message, detail });

/**
 * Maps an error to a problem. `about` tells whether the error came from my
 * own storage or from a friend's; `online` is what the device knows about
 * its network (the app's NetInfo), used to tell "no network" from "storage
 * unreachable".
 */
export function classifyError(e: unknown, about: 'own' | 'friend', online = true): SyncProblem {
  const detail = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : String(e).slice(0, 300);
  const friend = about === 'friend';
  if (e instanceof DeviceRevokedError) {
    return P('device-revoked', false, true, 'Remote wipe (Loss and theft)', 'This device was declared lost.', detail);
  }
  if (e instanceof NeedsKeyError) {
    return P('needs-key', false, true, 'Key missing from the phone\'s vault', 'Enter your recovery kit to keep syncing.', detail);
  }
  if (e instanceof TooManyRecipientsError) {
    return P('too-many-recipients', false, true, '—', 'Too many people for one shared batch.', detail);
  }
  if (e instanceof PayloadError) {
    return e.unsupported
      ? P('unsupported', false, false, 'Unsupported format version', 'Update the app to see {name}\'s places', detail)
      : P('tampered', false, false, 'Tampered content (invalid signature)', '{name}\'s content could not be verified', detail);
  }
  if (e instanceof StorageError) {
    switch (e.code) {
      case 'NETWORK':
        if (!online) return P('offline', true, false, 'No network', 'Offline', detail);
        return friend
          ? P('unreachable', true, false, 'A friend\'s storage unreachable', 'Updated {age} ago', detail)
          : P('unreachable', true, false, 'My storage unreachable', 'Your storage hasn\'t responded since {since}', detail);
      case 'AUTH':
        return friend
          ? P('unreachable', true, false, 'A friend\'s storage unreachable', 'Updated {age} ago', detail)
          : P('auth', false, true, 'Credentials rejected', 'Reconnect your storage', detail);
      case 'PRECONDITION_FAILED':
        return P('conflict', true, false, 'Two of my devices write at the same time', '', detail);
      case 'NOT_FOUND':
        return P('not-found', true, false, friend ? 'A friend\'s storage unreachable' : 'Interrupted write', friend ? 'Updated {age} ago' : '', detail);
      case 'PROTOCOL':
        if (e.status === 507 || e.status === 413) {
          return P('quota', true, false, 'Quota full', 'Your storage is full', detail);
        }
        return P('unreachable', true, false, friend ? 'A friend\'s storage unreachable' : 'My storage unreachable', '', detail);
      default:
        return P('bug', false, false, '—', 'Sync error', detail);
    }
  }
  if (e instanceof StorageMovedError) {
    return P('moved', true, false, 'A friend changes storage', '{name} moved her content', detail);
  }
  if (e instanceof RollbackError) {
    return P('rollback', false, false, 'Tampered content (invalid signature)', '{name}\'s content could not be verified', detail);
  }
  if (e instanceof TLCryptoError) {
    switch (e.code) {
      case 'UNSUPPORTED_VERSION':
        return P('unsupported', false, false, 'Unsupported format version', 'Update the app to see {name}\'s places', detail);
      case 'IDENTITY_MOVED':
        return P('identity-moved', false, false, 'Identity change (Loss and theft)', '{name} changed her identity', detail);
      case 'EXPIRED':
        return P('bug', false, false, '—', 'Sync error', detail);
      default:
        // FORMAT, SIGNATURE, OWNER_MISMATCH, REVOKED, DECRYPT, NOT_INDEXED, INVALID_KEY…
        return P('tampered', false, false, 'Tampered content (invalid signature)', '{name}\'s content could not be verified', detail);
    }
  }
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) {
    return online ? P('unreachable', true, false, 'My storage unreachable', '', detail) : P('offline', true, false, 'No network', 'Offline', detail);
  }
  return P('bug', false, false, '—', 'Sync error', detail);
}
