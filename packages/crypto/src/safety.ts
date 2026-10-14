import { bytesEqual, compareBytes, concat, ownerString, parseKey, toB64Url, utf8 } from './encoding';
import { S } from './sodium';

/*
 * Safety code: compares two identities out of band (phone call, face to face).
 *
 *   h = BLAKE2b-512("TrianguLair-safety-v1" || min(pkA, pkB) || max(pkA, pkB))
 * over the two MASTER public keys (byte order, so both sides get the same value).
 * Displayed as 12 groups of 5 digits: group i = (big-endian u40 of h[5i .. 5i+5)) mod 100000.
 * That is about 199 bits: no short code that an interceptor could grind for a collision.
 * QR form: "tlsafe1:" + base64url(first 32 bytes of h); comparing it is equivalent.
 */

const CONTEXT = utf8('TrianguLair-safety-v1');

function pairHash(a: Uint8Array | string, b: Uint8Array | string): Uint8Array {
  const pa = parseKey('ed25519', ownerString(a));
  const pb = parseKey('ed25519', ownerString(b));
  const [lo, hi] = compareBytes(pa, pb) <= 0 ? [pa, pb] : [pb, pa];
  return S().crypto_generichash(64, concat(CONTEXT, lo, hi), null);
}

/** 12 groups of 5 digits, identical on both sides (argument order does not matter). */
export function safetyCode(ownerA: Uint8Array | string, ownerB: Uint8Array | string): string[] {
  const h = pairHash(ownerA, ownerB);
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    let v = 0;
    for (let j = 0; j < 5; j++) v = v * 256 + (h[5 * i + j] as number);
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  return groups;
}

/** Payload of the QR code to show; the other side scans it and calls matchSafetyQr. */
export function safetyQrPayload(myOwner: Uint8Array | string, theirOwner: Uint8Array | string): string {
  return `tlsafe1:${toB64Url(pairHash(myOwner, theirOwner).subarray(0, 32))}`;
}

/** True if a scanned safety QR matches the pair (my identity, their identity). */
export function matchSafetyQr(scanned: string, myOwner: Uint8Array | string, theirOwner: Uint8Array | string): boolean {
  const expected = utf8(safetyQrPayload(myOwner, theirOwner));
  return typeof scanned === 'string' && bytesEqual(utf8(scanned), expected);
}
