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
  | 'NOT_LISTED'
  | 'IDENTITY_MOVED'
  | 'MOVED'
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

/**
 * A structure declares a major format version this library does not read, or lists in `crit` a
 * security-relevant field this library does not understand (`critical` names it).
 */
export class UnsupportedVersionError extends TLCryptoError {
  readonly structure: string;
  readonly found: number;
  readonly supported: number;
  readonly critical: string | undefined;
  constructor(structure: string, found: number, supported: number, critical?: string) {
    super(
      'UNSUPPORTED_VERSION',
      critical !== undefined
        ? `${structure}: critical field "${critical}" is not understood by this library (update the app)`
        : `${structure}: format version ${found} is not supported (this library reads version ${supported})`,
    );
    this.structure = structure;
    this.found = found;
    this.supported = supported;
    this.critical = critical;
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
 * Bad signature (SIGNATURE), signed by someone else than expected (OWNER_MISMATCH), signed by a
 * key that is revoked: a revoked device, or a master key whose identity moved away (REVOKED), or
 * an invitation link that the owner's signed index does not vouch for (NOT_LISTED).
 */
export class SignatureError extends TLCryptoError {
  constructor(message: string, code: 'SIGNATURE' | 'OWNER_MISMATCH' | 'REVOKED' | 'NOT_LISTED' = 'SIGNATURE') {
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
  /**
   * True when `from` is an identity the reader already left for ANOTHER successor: two different
   * moves of the same old identity exist, so its master key is compromised. Warn, keep the current
   * contact, and require a safety-code comparison before following anything.
   */
  readonly conflict: boolean;
  constructor(from: string, to: string, conflict = false) {
    super('IDENTITY_MOVED', conflict ? `conflicting identity move from ${from} to ${to}` : `identity moved from ${from} to ${to}`);
    this.from = from;
    this.to = to;
    this.conflict = conflict;
  }
}

/**
 * The index is valid, but its master-signed sharing certificate puts the owner's read address
 * elsewhere than where it was read (`location`): the owner moved storage, and the old address keeps
 * the newer index as a redirect. Fetch the index again at `location` (and only there).
 */
export class StorageMovedError extends TLCryptoError {
  readonly location: string;
  constructor(location: string) {
    super('MOVED', `the owner's content moved to ${location}`);
    this.location = location;
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
