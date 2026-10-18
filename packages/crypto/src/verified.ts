/**
 * Runtime registry of index objects returned by verifyIndex / signIndex, with what was checked.
 * Opening a pack requires one of them, verified FOR its owner (V3-11), so content can only be
 * decrypted after checking it against that owner's verified signed index. Registered objects are
 * deep-frozen, so they cannot be altered after verification.
 * @internal
 */
export interface VerifiedInfo {
  /** Verified with `expectedOwner` (or produced by signIndex): the index is attributed to a known owner. */
  ownerBound: boolean;
  /** Checked against a `lastSeen` anchor (rollback protection). */
  lastSeenChecked: boolean;
  /** Address the reader declared it read the index from (`location` option); equal to the certified address. */
  readFrom?: string;
}

const verified = new WeakMap<object, VerifiedInfo>();

export function markVerified<T extends object>(o: T, info: VerifiedInfo): T {
  verified.set(o, info);
  return o;
}

export function isVerified(o: unknown): boolean {
  return typeof o === 'object' && o !== null && verified.has(o);
}

export function verifiedInfo(o: unknown): VerifiedInfo | undefined {
  return typeof o === 'object' && o !== null ? verified.get(o) : undefined;
}
