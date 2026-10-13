import { canonicalize, fromB64Url, toB64Url, utf8, type JsonObject } from './encoding';
import { SignatureError } from './errors';
import { S } from './sodium';

/**
 * Every Ed25519 signature covers:
 *   UTF-8("TrianguLair-signature-v1\n" + domain + "\n" + canonicalJSON(body without "signature"))
 * The domain string separates structure kinds (index, sharing-cert, invitation, ...)
 * so a signature for one kind can never be replayed as another.
 */
const PREFIX = 'TrianguLair-signature-v1\n';

export type SignatureDomain = 'index' | 'sharing-cert' | 'invitation' | 'invitation-response';

export function signedBytes(domain: SignatureDomain, body: JsonObject): Uint8Array {
  const { signature: _ignored, ...rest } = body;
  return utf8(`${PREFIX}${domain}\n${canonicalize(rest)}`);
}

export function signBody<T extends JsonObject>(domain: SignatureDomain, body: T, masterSecretKey: Uint8Array): T & { signature: string } {
  const sig = S().crypto_sign_detached(signedBytes(domain, body), masterSecretKey);
  return { ...body, signature: toB64Url(sig) };
}

export function verifyBody(domain: SignatureDomain, doc: JsonObject, masterPublicKey: Uint8Array): void {
  const sig = fromB64Url(doc['signature'], `${domain}.signature`, 64);
  let ok = false;
  try {
    ok = S().crypto_sign_verify_detached(sig, signedBytes(domain, doc), masterPublicKey);
  } catch {
    ok = false;
  }
  if (!ok) throw new SignatureError(`${domain}: invalid signature`);
}
