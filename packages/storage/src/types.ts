/**
 * Common storage interface implemented by every protocol adapter.
 *
 * Paths are relative to the adapter's root ("index.json", "packs/ab12.bin"),
 * use "/" as separator, never start with "/", and never contain "." / ".."
 * segments. Directories are implicit: `put` creates missing parents and
 * `list` only returns files.
 *
 * ETags are opaque strings. The only valid operations on them are equality
 * comparison and passing them back as `ifMatch`. They are normalised to the
 * quoted HTTP form (`"abc"`) by the HTTP-based adapters.
 */

export type ETag = string;

export interface GetResult {
  data: Uint8Array;
  etag: ETag;
}

export interface HeadResult {
  etag: ETag;
  size: number;
}

export interface ListEntry {
  /** Path relative to the adapter root. */
  path: string;
  etag: ETag;
  size: number;
}

export interface PutOptions {
  /** Only write if the current object has exactly this ETag. */
  ifMatch?: ETag;
  /** `'*'`: only write if the object does not exist yet. */
  ifNoneMatch?: '*';
  /** Content-Type sent to HTTP backends (default application/octet-stream). */
  contentType?: string;
}

export interface DeleteOptions {
  /** Only delete if the current object has exactly this ETag. */
  ifMatch?: ETag;
}

export interface Capabilities {
  /** All writes throw `ReadOnly`. */
  readonly readOnly: boolean;
  /**
   * `true` when `ifMatch` / `ifNoneMatch` are enforced atomically by the
   * server. `false` means they are emulated (check-then-write, racy) or
   * unavailable.
   */
  readonly conditionalWrites: boolean;
  /** `list()` is available (plain HTTPS cannot list). */
  readonly list: boolean;
  /**
   * URL a friend can GET anonymously over HTTPS for this path, or `null` if the
   * adapter has no public base URL configured.
   */
  publicUrl(path: string): string | null;
}

export interface StorageAdapter {
  readonly capabilities: Capabilities;
  /** `null` if the object does not exist. */
  get(path: string): Promise<GetResult | null>;
  /** `null` if the object does not exist. */
  head(path: string): Promise<HeadResult | null>;
  /** Throws `PreconditionFailed` when a condition does not hold. */
  put(path: string, data: Uint8Array, opts?: PutOptions): Promise<{ etag: ETag }>;
  /**
   * Idempotent without `ifMatch` (deleting a missing object resolves).
   * With `ifMatch`, a missing or different object throws `PreconditionFailed`.
   */
  delete(path: string, opts?: DeleteOptions): Promise<void>;
  /**
   * All files whose path starts with `prefix` (recursive), sorted by path.
   * Throws `Unsupported` when `capabilities.list` is false.
   */
  list(prefix: string): Promise<ListEntry[]>;
}

/** `fetch`-compatible function, injectable for React Native, tests, proxies. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
