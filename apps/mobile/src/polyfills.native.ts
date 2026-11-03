/**
 * Native: libsodium (crypto package) and the id generators need
 * `crypto.getRandomValues`, which Hermes does not provide. expo-crypto's is
 * backed by the system's secure random generator. Imported first by the root layout.
 */
import { getRandomValues } from 'expo-crypto';

const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues: getRandomValues as unknown };
}
