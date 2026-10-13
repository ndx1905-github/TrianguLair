import { deriveSharingKeyPair, generateRecoveryPhrase, identityFromPhrase, issueSharingCert, type Identity, type KeyPair, type SharingCert } from '../src/index';

export interface Person {
  id: Identity;
  sharing: KeyPair;
  cert: SharingCert;
}

export function person(rotation = 0): Person {
  const id = identityFromPhrase(generateRecoveryPhrase());
  const sharing = deriveSharingKeyPair(id, rotation);
  return { id, sharing, cert: issueSharingCert(id, sharing.publicKey, { rotation }) };
}

export const te = new TextEncoder();
export const td = new TextDecoder();

/** True if `needle` occurs anywhere in `hay`. */
export function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Rebuild a pack with a mutated header JSON (keeps ciphertext). */
export function mutateHeader(pack: Uint8Array, f: (h: Record<string, unknown>) => void): Uint8Array {
  const n = new DataView(pack.buffer, pack.byteOffset).getUint32(5, false);
  const h = JSON.parse(td.decode(pack.subarray(9, 9 + n)));
  f(h);
  const hb = te.encode(JSON.stringify(h));
  const out = new Uint8Array(9 + hb.length + pack.length - 9 - n);
  out.set(pack.subarray(0, 5));
  new DataView(out.buffer).setUint32(5, hb.length, false);
  out.set(hb, 9);
  out.set(pack.subarray(9 + n), 9 + hb.length);
  return out;
}
