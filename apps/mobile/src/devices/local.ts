/**
 * Small per-device settings of T-206 / T-207 (plain device settings, nothing secret): this
 * device's name, the identities this database moved away from (theft of the primary device), and
 * the "lock if no sync for N days" option.
 */
import { Platform } from 'react-native';

import { getSetting, setSetting } from '../data/deviceSettings';
import { nextClockMark, parseClockMark, parseStaleSync, type ClockMark, type StaleSyncSettings } from '../identity/lock';

export const DEVICE_NAME_KEY = 'device-name';
export const MOVED_FROM_KEY = 'identity-moved-from';
export const STALE_SYNC_KEY = 'stale-sync';
export const CLOCK_MARK_KEY = 'clock-mark';

/** A first guess for this device's name (the user can rename it in Settings › Devices). */
export function defaultDeviceName(): string {
  if (Platform.OS === 'ios') return (Platform as { isPad?: boolean }).isPad ? 'iPad' : 'iPhone';
  if (Platform.OS === 'android') return 'Android';
  if (typeof navigator !== 'undefined' && /Mobi/i.test(navigator.userAgent ?? '')) return 'Phone (web)';
  return 'Web browser';
}

export function deviceName(): string {
  return getSetting(DEVICE_NAME_KEY) || defaultDeviceName();
}

export function setDeviceName(name: string): void {
  setSetting(DEVICE_NAME_KEY, name);
}

/** Owner ids this device's database belonged to before an identity change (oldest first). */
export function movedFrom(): string[] {
  try {
    const v = JSON.parse(getSetting(MOVED_FROM_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.startsWith('ed25519:')) : [];
  } catch {
    return [];
  }
}

export function staleSync(): StaleSyncSettings | null {
  return parseStaleSync(getSetting(STALE_SYNC_KEY));
}

export function setStaleSync(s: StaleSyncSettings | null): void {
  setSetting(STALE_SYNC_KEY, s ? JSON.stringify(s) : '');
}

/** The latest time this device saw, moved forward now (and reset by a new successful sync): see lock.ts. */
export function touchClockMark(lastSuccess: number | null, now = Date.now()): ClockMark {
  const next = nextClockMark(parseClockMark(getSetting(CLOCK_MARK_KEY)), lastSuccess, now);
  setSetting(CLOCK_MARK_KEY, JSON.stringify(next));
  return next;
}
