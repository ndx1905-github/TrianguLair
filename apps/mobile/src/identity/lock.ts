/**
 * App lock (spec "Protections on the device"): by code or biometrics,
 * offered at installation and on by default when the phone has no screen
 * lock; automatic lock after a few minutes in the background. Pure rules,
 * unit-tested; the gate is `LockGate.tsx`.
 *
 * "Lock, or even wipe, if there has been no successful sync for a chosen number of days"
 * (`staleSyncAction`): a phone kept away from the network never reads its revocation, so after
 * N days without reaching my storage the app locks until a sync succeeds (which wipes it if it
 * was declared lost meanwhile), or erases itself when the wipe option is on. Off by default.
 */
import _sodium from 'libsodium-wrappers-sumo';
import { fromB64Url, ready, toB64Url } from '@triangulair/crypto';

/** What the phone offers, from expo-local-authentication's enrolled level. */
export type DeviceSecurity = 'none' | 'passcode' | 'biometric' | 'unknown';

export interface LockSettings {
  enabled: boolean;
  /** `device`: Face ID / fingerprint / the phone's own code (system prompt). `code`: the app's own code. */
  method: 'device' | 'code';
  /** Lock after this long in the background. 0 = as soon as the app leaves the screen. */
  delayMs: number;
}

export const LOCK_DELAYS_MS = [0, 60_000, 5 * 60_000, 15 * 60_000] as const;
export const DEFAULT_LOCK_DELAY_MS = 5 * 60_000;

/** Defaults (spec): on when the phone has no screen lock, with the app's own code (no system prompt is possible then). */
export function defaultLockSettings(security: DeviceSecurity): LockSettings {
  return {
    enabled: security === 'none',
    method: security === 'passcode' || security === 'biometric' ? 'device' : 'code',
    delayMs: DEFAULT_LOCK_DELAY_MS,
  };
}

export function parseLockSettings(s: string | null): LockSettings | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s) as Partial<LockSettings>;
    if (typeof o.enabled !== 'boolean' || (o.method !== 'device' && o.method !== 'code') || typeof o.delayMs !== 'number') return null;
    return { enabled: o.enabled, method: o.method, delayMs: Math.max(0, o.delayMs) };
  } catch {
    return null;
  }
}

/** Lock on return when the app stayed in the background at least the chosen delay. */
export function shouldLockOnReturn(settings: LockSettings, backgroundSince: number | null, now: number): boolean {
  if (!settings.enabled || backgroundSince === null) return false;
  return now - backgroundSince >= settings.delayMs;
}

export const MIN_CODE_LENGTH = 4;
export const MAX_CODE_LENGTH = 12;

export function isValidCode(code: string): boolean {
  return new RegExp(`^\\d{${MIN_CODE_LENGTH},${MAX_CODE_LENGTH}}$`).test(code);
}

/** Wait before the next try after `failures` wrong codes: none for 4, then 30 s doubling, at most 15 min. */
export function lockoutMs(failures: number): number {
  if (failures < 5) return 0;
  return Math.min(15 * 60_000, 30_000 * 2 ** (failures - 5));
}

/**
 * The code is kept as a salted BLAKE2b hash in the secret store, next to the
 * keys it protects: whoever can read that store already holds the keys, so a
 * slow hash would add nothing. The code only guards the screen; the lockout
 * above slows guessing on the device.
 */
export async function hashCode(code: string, salt?: Uint8Array): Promise<string> {
  await ready();
  const s = salt ?? _sodium.randombytes_buf(16);
  const h = _sodium.crypto_generichash(32, new TextEncoder().encode(`TrianguLair-app-lock-v1\n${code}`), s);
  return JSON.stringify({ v: 1, salt: toB64Url(s), hash: toB64Url(h) });
}

export async function verifyCode(code: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  try {
    const o = JSON.parse(stored) as { v: number; salt: string; hash: string };
    if (o.v !== 1) return false;
    await ready();
    const again = JSON.parse(await hashCode(code, fromB64Url(o.salt, 'salt', 16))) as { hash: string };
    return _sodium.memcmp(fromB64Url(again.hash, 'hash'), fromB64Url(o.hash, 'hash'));
  } catch {
    return false;
  }
}

/** "Lock if no sync for N days" (spec "Protections on the device"). */
export interface StaleSyncSettings {
  days: number;
  /** Erase the device instead of locking it. */
  wipe: boolean;
  /** When the option was turned on (ms): the count starts there if nothing synced since. */
  since: number;
}

export const STALE_SYNC_DAYS = [3, 7, 14, 30] as const;
const DAY_MS = 86_400_000;

export function parseStaleSync(s: string | null): StaleSyncSettings | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s) as Partial<StaleSyncSettings>;
    if (typeof o.days !== 'number' || !Number.isInteger(o.days) || o.days < 1 || o.days > 365 || typeof o.since !== 'number') return null;
    return { days: o.days, wipe: o.wipe === true, since: o.since };
  } catch {
    return null;
  }
}

/**
 * What the app must do now. `lastSuccess`: the last pass where my storage worked (null: never).
 * Only for a device that syncs with a storage (`syncs`); a local-only device has nothing to wait for.
 */
export function staleSyncAction(s: StaleSyncSettings | null, lastSuccess: number | null, now: number, syncs: boolean): 'none' | 'lock' | 'wipe' {
  if (!s || !syncs) return 'none';
  const from = Math.max(lastSuccess ?? 0, s.since);
  if (now - from < s.days * DAY_MS) return 'none';
  return s.wipe ? 'wipe' : 'lock';
}

/** Days left before the lock (for the settings line), at least 0. */
export function staleDaysLeft(s: StaleSyncSettings, lastSuccess: number | null, now: number): number {
  const from = Math.max(lastSuccess ?? 0, s.since);
  return Math.max(0, Math.ceil((from + s.days * DAY_MS - now) / DAY_MS));
}
