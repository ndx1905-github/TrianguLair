// SPDX-License-Identifier: MPL-2.0
/**
 * App-level signatures over the free-form parts of my vault (devices.ts): the device list's
 * display entries and the app values (storage settings, profile). Spec "Recovery kit": "A vault
 * field that a future version gives a security meaning must [...] be signed by the device that
 * wrote it, with its device certificate (as invitation records are)".
 *
 * Ed25519 (libsodium, the same library and instance the crypto package uses; `ready()` from
 * `@triangulair/crypto` must have been awaited). Every signature covers
 *   UTF-8("TrianguLair-app-signature-v1\n" + domain + "\n") || canonicalJSON(body)
 * The prefix differs from the crypto package's ("TrianguLair-signature-v1\n"), so a signature made
 * here can never be replayed as an index, a certificate or an invitation record, and the domain
 * separates the kinds below. Not a crypto format: the crypto package is unchanged.
 */
import _sodium from 'libsodium-wrappers-sumo';
import { canonicalize, fromB64Url, parseKey, toB64Url } from '@triangulair/crypto';

export type AppSignatureDomain = 'vault-device-info' | 'vault-value';

/** Who signs: a device of mine (its id and Ed25519 secret key) or my master key (owner id). */
export interface EntrySigner {
  /** Device id (`ed25519:…`, the device's signing public key) or my owner id (master key). */
  id: string;
  /** Ed25519 secret key (64 bytes, libsodium format). */
  secretKey: Uint8Array;
}

const PREFIX = 'TrianguLair-app-signature-v1\n';
const enc = new TextEncoder();

function message(domain: AppSignatureDomain, body: unknown): Uint8Array {
  const head = enc.encode(`${PREFIX}${domain}\n`);
  const json = enc.encode(canonicalize(body as never));
  const out = new Uint8Array(head.length + json.length);
  out.set(head, 0);
  out.set(json, head.length);
  return out;
}

export function signEntry(domain: AppSignatureDomain, body: unknown, signer: EntrySigner): string {
  return toB64Url(_sodium.crypto_sign_detached(message(domain, body), signer.secretKey));
}

/** True when `sig` is `by`'s signature over `body` (`by`: a device id or an owner id, both Ed25519 keys). */
export function verifyEntry(domain: AppSignatureDomain, body: unknown, by: string, sig: unknown): boolean {
  try {
    const s = fromB64Url(sig, 'signature', 64);
    return _sodium.crypto_sign_verify_detached(s, message(domain, body), parseKey('ed25519', by, 'signer'));
  } catch {
    return false;
  }
}
