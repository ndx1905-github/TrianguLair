/*
 * Test-only deterministic randomness for the known-answer vectors (docs/format/vectors/).
 *
 * Every random byte the library uses comes from libsodium (randombytes_buf, randombytes_uniform,
 * key generation, the ephemeral key of crypto_box_seal). In the WebAssembly build, libsodium's
 * randombytes implementation calls the JavaScript function `Module.getRandomValue()` once per
 * value, and libsodium-wrappers exposes that Module as `sodium.libsodium`. Swapping that function
 * for a seeded stream inside `seeded()` makes the whole library deterministic WITHOUT touching
 * src/ (no API change, no change of outputs outside the scope): the hook is restored in `finally`.
 */
import _sodium from 'libsodium-wrappers-sumo';

interface SodiumModule {
  getRandomValue: () => number;
}

const STREAM_BYTES = 4 * 1024 * 1024;

/** Runs `fn` with libsodium's randomness replaced by a stream seeded from `label` (not reentrant). */
export function seeded<T>(label: string, fn: () => T): T {
  const s = _sodium;
  const lib = (s as unknown as { libsodium: SodiumModule }).libsodium;
  // Seed and stream are computed BEFORE the hook is installed (no libsodium call inside the hook).
  const seed = s.crypto_generichash(32, s.from_string(`TrianguLair-test-vectors-v1\n${label}`), null);
  const stream = s.randombytes_buf_deterministic(STREAM_BYTES, seed);
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let i = 0;
  const original = lib.getRandomValue;
  lib.getRandomValue = () => {
    if (i + 4 > stream.length) throw new Error(`seeded(${label}): random stream exhausted`);
    const v = view.getUint32(i, false);
    i += 4;
    return v;
  };
  try {
    return fn();
  } finally {
    lib.getRandomValue = original;
  }
}
