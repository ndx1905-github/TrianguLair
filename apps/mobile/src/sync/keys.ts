/**
 * The keys the sync engine needs, from the secret store entries made by the identity
 * (`device-keys`, `sharing-key`) plus `sync-keys`: my earlier sharing key pairs (friends may still
 * wrap to them until they read my new certificate) and earlier vault data keys
 * (`OwnSync.previousVaultKeys`). Pure (no React, no secret store); unit-tested.
 */
import { fromB64Url, openSharingKey, sealSharingKey, toB64Url, type DeviceSigner, type IdentityMove, type KeyPair, type SharingKey } from '@triangulair/crypto';
import type { PreviousVaultKey } from '@triangulair/sync';

import { parseDeviceKeys, type IdentityRecord } from '../identity/create';

export interface SyncKeys {
  sharing: SharingKey;
  device: DeviceSigner;
  previousSharingKeys: KeyPair[];
  previousVaultKeys: PreviousVaultKey[];
  /** After an identity change: the move, written in every index (IdentityRecord.move). */
  move?: IdentityMove;
}

export interface StoredSyncSecrets {
  deviceKeys: string;
  sharingKey: string;
  /** `sync-keys` entry (null before the first rotation). */
  syncKeys: string | null;
}

const MAX_KEPT = 4;

export function serializeSyncKeys(k: Pick<SyncKeys, 'previousSharingKeys' | 'previousVaultKeys'>): string {
  return JSON.stringify({
    v: 1,
    sharing: k.previousSharingKeys.slice(0, MAX_KEPT).map((p) => ({ pk: toB64Url(p.publicKey), sk: toB64Url(p.secretKey) })),
    vault: k.previousVaultKeys.slice(0, MAX_KEPT).map((p) => ({ key: toB64Url(p.key), rotation: p.rotation, revoked: [...p.revoked] })),
  });
}

/** Defensive: a broken entry gives no previous keys (only older friends' packs stay unreadable for a while). */
export function parseSyncKeys(s: string | null): Pick<SyncKeys, 'previousSharingKeys' | 'previousVaultKeys'> {
  const none = { previousSharingKeys: [], previousVaultKeys: [] };
  if (!s) return none;
  try {
    const o = JSON.parse(s) as { v?: number; sharing?: { pk: string; sk: string }[]; vault?: { key: string; rotation: number; revoked: string[] }[] };
    if (o.v !== 1) return none;
    return {
      previousSharingKeys: (o.sharing ?? []).slice(0, MAX_KEPT).map((p) => ({ publicKey: fromB64Url(p.pk, 'pk', 32), secretKey: fromB64Url(p.sk, 'sk', 32) })),
      previousVaultKeys: (o.vault ?? [])
        .slice(0, MAX_KEPT)
        .filter((p) => Number.isSafeInteger(p.rotation) && Array.isArray(p.revoked))
        .map((p) => ({ key: fromB64Url(p.key, 'key', 32), rotation: p.rotation, revoked: p.revoked.filter((x) => typeof x === 'string') })),
    };
  } catch {
    return none;
  }
}

/** Opens the stored secrets. Call `await ready()` (crypto) first. */
export function openSyncKeys(record: IdentityRecord, s: StoredSyncSecrets): SyncKeys {
  const keys = parseDeviceKeys(s.deviceKeys);
  const sharing = openSharingKey(fromB64Url(s.sharingKey, 'sharingKey'), keys, { expectedOwner: record.owner });
  return { sharing, device: { keys, cert: record.deviceCert }, ...parseSyncKeys(s.syncKeys), ...(record.move && { move: record.move }) };
}

/** A sharing key adopted by the engine (rotation from another device) → the `sharing-key` entry. */
export function sealForThisDevice(k: SharingKey, record: IdentityRecord): string {
  return toB64Url(sealSharingKey(k, record.deviceCert));
}
