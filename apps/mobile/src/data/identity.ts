/**
 * Device identity used by the data store until identity creation exists
 * (first-launch flow, T-0xx): a fixed local owner id and a per-device
 * Automerge actor kept in the device settings.
 */
import { getSetting, setSetting } from './deviceSettings';

/** Owner of my data on this device until a key pair is created. */
export const LOCAL_ME_ID = 'local-me';

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: { getRandomValues?: (x: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable per device (random the first time). */
export function deviceActor(): string {
  const existing = getSetting('actor');
  if (existing && /^[0-9a-f]{32}$/.test(existing)) return existing;
  const actor = randomHex(16);
  setSetting('actor', actor);
  return actor;
}

/**
 * Id generator for tags, lists and manual places. Uses crypto.getRandomValues
 * when present (web, recent Hermes); otherwise Math.random (React Native
 * without a polyfill: ids only need to be unique, not secret).
 */
export function newId(): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const hex = randomHex(16);
  let bits = '';
  for (const ch of hex) bits += parseInt(ch, 16).toString(2).padStart(4, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
