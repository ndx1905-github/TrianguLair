/**
 * Typed storage errors. Every adapter maps protocol-specific failures onto
 * these classes so callers can `instanceof`-check regardless of backend.
 */

export type StorageErrorCode =
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'AUTH'
  | 'NETWORK'
  | 'READ_ONLY'
  | 'UNSUPPORTED'
  | 'INVALID_PATH'
  | 'PROTOCOL';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  /** HTTP status (or SFTP status code) when known. */
  readonly status: number | undefined;
  readonly path: string | undefined;

  constructor(
    code: StorageErrorCode,
    message: string,
    opts: { status?: number; path?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = opts.status;
    this.path = opts.path;
  }
}

/** The object does not exist (only thrown where `null` is not the natural answer). */
export class NotFound extends StorageError {
  constructor(path: string, opts: { status?: number; cause?: unknown } = {}) {
    super('NOT_FOUND', `Not found: ${path}`, { ...opts, path });
  }
}

/** Conditional write/delete rejected: the ETag did not match (someone else wrote first). */
export class PreconditionFailed extends StorageError {
  constructor(path: string, opts: { status?: number; cause?: unknown; detail?: string } = {}) {
    super('PRECONDITION_FAILED', `Precondition failed: ${path}${opts.detail ? ` (${opts.detail})` : ''}`, {
      ...opts,
      path,
    });
  }
}

/** Credentials missing, wrong, or insufficient (HTTP 401/403, SSH auth failure). */
export class AuthError extends StorageError {
  constructor(message: string, opts: { status?: number; path?: string; cause?: unknown } = {}) {
    super('AUTH', message, opts);
  }
}

/** Transport failure or server-side 5xx; generally retryable. */
export class NetworkError extends StorageError {
  constructor(message: string, opts: { status?: number; path?: string; cause?: unknown } = {}) {
    super('NETWORK', message, opts);
  }
}

/** Write attempted on a read-only adapter (HTTPS). */
export class ReadOnly extends StorageError {
  constructor(path: string) {
    super('READ_ONLY', `Adapter is read-only: cannot write ${path}`, { path });
  }
}

/** Operation not supported by this adapter (e.g. `list` over plain HTTPS). */
export class Unsupported extends StorageError {
  constructor(message: string) {
    super('UNSUPPORTED', message);
  }
}

export class InvalidPath extends StorageError {
  constructor(path: string, reason: string) {
    super('INVALID_PATH', `Invalid storage path ${JSON.stringify(path)}: ${reason}`, { path });
  }
}

/** Unexpected protocol response (unparseable XML, unexpected status, ...). */
export class ProtocolError extends StorageError {
  constructor(message: string, opts: { status?: number; path?: string; cause?: unknown } = {}) {
    super('PROTOCOL', message, opts);
  }
}
