import _sodium from 'libsodium-wrappers-sumo';
import { TLCryptoError } from './errors';

export type Sodium = typeof _sodium;

let initialized = false;

/** Must be awaited once before calling any other function of this package. */
export async function ready(): Promise<void> {
  await _sodium.ready;
  initialized = true;
}

/** @internal */
export function S(): Sodium {
  if (!initialized) throw new TLCryptoError('NOT_READY', 'libsodium not initialized: call `await ready()` first');
  return _sodium;
}
