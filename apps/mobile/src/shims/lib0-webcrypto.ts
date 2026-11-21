/**
 * Native replacement for `lib0/webcrypto` (used by yjs through lib0/random).
 * lib0's react-native build requires `isomorphic-webcrypto`, which we do not ship.
 * This version reads `globalThis.crypto` at call time, so it works once
 * src/polyfills.native.ts has installed `getRandomValues` from expo-crypto.
 * yjs never uses `subtle`.
 */
type Crypto = { getRandomValues<T extends ArrayBufferView>(array: T): T; subtle?: unknown };
const current = (): Crypto => (globalThis as unknown as { crypto: Crypto }).crypto;

export const subtle = current()?.subtle;
export const getRandomValues = <T extends ArrayBufferView>(array: T): T =>
  current().getRandomValues(array);
