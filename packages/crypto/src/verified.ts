/**
 * Runtime registry of index objects returned by verifyIndex / signIndex. Opening a pack requires
 * one of them, so content can only be decrypted after checking it against a verified signed index.
 * Registered objects are deep-frozen, so they cannot be altered after verification.
 * @internal
 */
const verified = new WeakSet<object>();

export function markVerified<T extends object>(o: T): T {
  verified.add(o);
  return o;
}

export function isVerified(o: unknown): boolean {
  return typeof o === 'object' && o !== null && verified.has(o);
}
