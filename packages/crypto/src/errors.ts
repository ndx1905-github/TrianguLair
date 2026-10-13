/**
 * Error codes are for LOCAL handling only (UI messages, retries). Never reflect them to a
 * remote party: e.g. DECRYPT vs NO_MATCHING_KEY tells whether a wrap was addressed to you.
 */
export type ErrorCode =
  | 'NOT_READY'
  | 'FORMAT'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_KEY'
  | 'DECRYPT'
  | 'NO_MATCHING_KEY'
  | 'NOT_INDEXED'
  | 'SIGNATURE'
  | 'OWNER_MISMATCH'
  | 'REVOKED'
  | 'IDENTITY_MOVED'
  | 'EXPIRED'
  | 'ROLLBACK'
  | 'INVALID_PHRASE'
  | 'INVALID_CODE';

/** Base class of every error thrown by @triangulair/crypto. Switch on `code`. */
export class TLCryptoError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

/** Malformed input (bad magic, bad or non-canonical JSON, missing/extra fields, bad lengths...). */
export class FormatError extends TLCryptoError {
  constructor(message: string) {
    super('FORMAT', message);
  }
}

/** A structure declares a format version this library does not read. */
export class UnsupportedVersionError extends TLCryptoError {
  readonly structure: string;
  readonly found: number;
  readonly supported: number;
  constructor(structure: string, found: number, supported: number) {
    super('UNSUPPORTED_VERSION', `${structure}: format version ${found} is not supported (this library reads version ${supported})`);
    this.structure = structure;
    this.found = found;
    this.supported = supported;
  }
}

/** A public key is malformed or unusable (e.g. a low-order / all-zero X25519 point). */
export class InvalidKeyError extends TLCryptoError {
  constructor(message: string) {
    super('INVALID_KEY', message);
  }
}

/**
 * AEAD/sealed-box failure (code DECRYPT), no key could open any wrap (code NO_MATCHING_KEY),
 * or the pack bytes are not listed in the verified index they were opened against (code NOT_INDEXED).
 */
export class DecryptionError extends TLCryptoError {
  constructor(message: string, code: 'DECRYPT' | 'NO_MATCHING_KEY' | 'NOT_INDEXED' = 'DECRYPT') {
    super(code, message);
  }
}

/**
 * Bad signature (SIGNATURE), signed by someone else than expected (OWNER_MISMATCH), or signed by a
 * key that is revoked: a revoked device, or a master key whose identity moved away (REVOKED).
 */
export class SignatureError extends TLCryptoError {
  constructor(message: string, code: 'SIGNATURE' | 'OWNER_MISMATCH' | 'REVOKED' = 'SIGNATURE') {
    super(code, message);
  }
}

/**
 * The index at a contact's address is signed by a NEW identity that carries a valid move statement
 * from the expected (old) identity. Nothing is accepted automatically: show "X changed their
 * identity", drop the "verified" mark, then call verifyIndex again with `expectedOwner: err.to` and
 * `retiredOwners` including `err.from`.
 */
export class IdentityMovedError extends TLCryptoError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super('IDENTITY_MOVED', `identity moved from ${from} to ${to}`);
    this.from = from;
    this.to = to;
  }
}

export class ExpiredError extends TLCryptoError {
  constructor(message: string) {
    super('EXPIRED', message);
  }
}

/** Older data than already seen. `fork` is true for "same seq/rotation, different content" (report it). */
export class RollbackError extends TLCryptoError {
  readonly fork: boolean;
  constructor(message: string, fork = false) {
    super('ROLLBACK', message);
    this.fork = fork;
  }
}
