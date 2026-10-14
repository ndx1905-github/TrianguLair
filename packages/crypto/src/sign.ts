import { canonicalize, concat, fromB64Url, toB64Url, utf8, type JsonObject } from './encoding';
import { SignatureError } from './errors';
import { S } from './sodium';

/**
 * Every Ed25519 signature covers
 *   UTF-8("TrianguLair-signature-v1\n" + domain + "\n") || message
 * where message is canonicalJSON(body without "signature") for JSON documents, or the raw
 * signed bytes for binary structures (invitation link, invitation response).
 * The domain string separates structure kinds so a signature for one kind can never be
 * replayed as another.
 */
const PREFIX = 'TrianguLair-signature-v1\n';

export type SignatureDomain =
  | 'index'
  | 'sharing-cert'
  | 'device-cert'
  | 'identity-move'
  | 'identity-move-to'
  | 'invitation'
  | 'invitation-response';

function prefixed(domain: SignatureDomain, message: Uint8Array): Uint8Array {
  return concat(utf8(`${PREFIX}${domain}\n`), message);
}

export function signedBytes(domain: SignatureDomain, body: JsonObject): Uint8Array {
  const { signature: _ignored, ...rest } = body;
  return prefixed(domain, utf8(canonicalize(rest)));
}

/** Signs a JSON body (every field except "signature") with an Ed25519 secret key (64 bytes). */
export function signBody<T extends JsonObject>(domain: SignatureDomain, body: T, secretKey: Uint8Array): T & { signature: string } {
  const sig = S().crypto_sign_detached(signedBytes(domain, body), secretKey);
  return { ...body, signature: toB64Url(sig) };
}

export function verifyBody(domain: SignatureDomain, doc: JsonObject, publicKey: Uint8Array, field = 'signature'): void {
  const sig = fromB64Url(doc[field], `${domain}.${field}`, 64);
  verifyDetached(domain, sig, signedBytesExcept(domain, doc, field), publicKey);
}

function signedBytesExcept(domain: SignatureDomain, doc: JsonObject, field: string): Uint8Array {
  if (field === 'signature') return signedBytes(domain, doc);
  const { [field]: _f, signature: _s, ...rest } = doc;
  return prefixed(domain, utf8(canonicalize(rest)));
}

/** Signs `doc` without its `signature` and `field` entries; returns the signature as base64url. */
export function signBodyField(domain: SignatureDomain, doc: JsonObject, field: string, secretKey: Uint8Array): string {
  return toB64Url(S().crypto_sign_detached(signedBytesExcept(domain, doc, field), secretKey));
}

export function signBinary(domain: SignatureDomain, message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return S().crypto_sign_detached(prefixed(domain, message), secretKey);
}

export function verifyBinary(domain: SignatureDomain, signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): void {
  verifyDetached(domain, signature, prefixed(domain, message), publicKey);
}

function verifyDetached(domain: SignatureDomain, sig: Uint8Array, bytes: Uint8Array, publicKey: Uint8Array): void {
  let ok = false;
  try {
    ok = S().crypto_sign_verify_detached(sig, bytes, publicKey);
  } catch {
    ok = false;
  }
  if (!ok) throw new SignatureError(`${domain}: invalid signature`);
}
