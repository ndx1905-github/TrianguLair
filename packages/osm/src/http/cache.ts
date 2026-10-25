/**
 * Response cache. The interface is async-capable so the app can back it with
 * SQLite (place cards must survive restarts and work offline); the in-memory
 * implementation is the default and the reference for tests.
 *
 * Values are JSON-serializable (parsed response bodies), keys are opaque
 * strings built by the HTTP client (method, URL and body).
 */

export interface CacheEntry {
  value: unknown;
  /** ms since epoch */
  storedAt: number;
  /** ms since epoch; after this the entry is stale (still usable if the network fails). */
  expiresAt: number;
}

export interface OsmCache {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

export interface MemoryCacheOptions {
  /** Maximum number of entries (least recently used are evicted). Default 500. */
  maxEntries?: number;
  /** How long a stale entry is kept for offline fallback, in ms. Default 30 days. */
  keepStaleMs?: number;
  now?: () => number;
}

export class MemoryCache implements OsmCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly keepStaleMs: number;
  private readonly now: () => number;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.keepStaleMs = options.keepStaleMs ?? 30 * 24 * 3600_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt + this.keepStaleMs) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
