export type ErrorCode =
  | 'NOT_READY'
  | 'FORMAT'
  | 'UNSUPPORTED_VERSION'
  | 'DECRYPT'
  | 'NO_MATCHING_KEY'
  | 'SIGNATURE'
  | 'OWNER_MISMATCH'
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

/** Malformed input (bad magic, bad JSON, missing/extra fields, bad lengths...). */
export class FormatError extends TLCryptoError {
  constructor(message: string) {
    super('FORMAT', message);
  }
}

/** A structure declares a format version newer than this library understands. */
export class UnsupportedVersionError extends TLCryptoError {
  readonly structure: string;
  readonly found: number;
  readonly supported: number;
  constructor(structure: string, found: number, supported: number) {
    super('UNSUPPORTED_VERSION', `${structure}: format version ${found} is not supported (this library supports up to ${supported})`);
    this.structure = structure;
    this.found = found;
    this.supported = supported;
  }
}

/** AEAD/sealed-box failure (code DECRYPT) or no key could open any wrap (code NO_MATCHING_KEY). */
export class DecryptionError extends TLCryptoError {
  constructor(message: string, code: 'DECRYPT' | 'NO_MATCHING_KEY' = 'DECRYPT') {
    super(code, message);
  }
}

/** Bad signature (code SIGNATURE) or signed by someone else than expected (code OWNER_MISMATCH). */
export class SignatureError extends TLCryptoError {
  constructor(message: string, code: 'SIGNATURE' | 'OWNER_MISMATCH' = 'SIGNATURE') {
    super(code, message);
  }
}

export class ExpiredError extends TLCryptoError {
  constructor(message: string) {
    super('EXPIRED', message);
  }
}

export class RollbackError extends TLCryptoError {
  constructor(message: string) {
    super('ROLLBACK', message);
  }
}
