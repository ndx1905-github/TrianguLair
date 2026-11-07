// SPDX-License-Identifier: MPL-2.0
/**
 * Local sync state (ETags, anchors, pack caches, the local vault copy).
 * Synchronous, like the data package's SQLite driver; values are JSON or
 * bytes. It lives in the local database, itself protected by the phone's
 * encryption (spec "Protections on the device").
 */
import type { SqlDriver } from '@triangulair/data';

export interface SyncStateStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  getBytes(key: string): Uint8Array | undefined;
  setBytes(key: string, value: Uint8Array): void;
  delete(key: string): void;
  /** Keys starting with `prefix`. */
  keys(prefix: string): string[];
}

export class MemoryStateStore implements SyncStateStore {
  private readonly json = new Map<string, string>();
  private readonly bin = new Map<string, Uint8Array>();
  get<T>(key: string): T | undefined {
    const v = this.json.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  set(key: string, value: unknown): void {
    this.json.set(key, JSON.stringify(value));
  }
  getBytes(key: string): Uint8Array | undefined {
    const v = this.bin.get(key);
    return v && v.slice();
  }
  setBytes(key: string, value: Uint8Array): void {
    this.bin.set(key, value.slice());
  }
  delete(key: string): void {
    this.json.delete(key);
    this.bin.delete(key);
  }
  keys(prefix: string): string[] {
    return [...new Set([...this.json.keys(), ...this.bin.keys()])].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** State in the app's SQLite database (table `sync_state`, created if missing). */
export class SqliteStateStore implements SyncStateStore {
  constructor(private readonly db: SqlDriver) {
    db.exec(`CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, json TEXT, bytes BLOB) WITHOUT ROWID`);
  }
  get<T>(key: string): T | undefined {
    const r = this.db.get<{ json: string | null }>(`SELECT json FROM sync_state WHERE key = ?`, [key]);
    return r?.json == null ? undefined : (JSON.parse(r.json) as T);
  }
  set(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO sync_state (key, json, bytes) VALUES (?, ?, NULL) ON CONFLICT (key) DO UPDATE SET json = excluded.json, bytes = NULL`,
      [key, JSON.stringify(value)],
    );
  }
  getBytes(key: string): Uint8Array | undefined {
    const r = this.db.get<{ bytes: Uint8Array | null }>(`SELECT bytes FROM sync_state WHERE key = ?`, [key]);
    return r?.bytes == null ? undefined : new Uint8Array(r.bytes);
  }
  setBytes(key: string, value: Uint8Array): void {
    this.db.run(
      `INSERT INTO sync_state (key, json, bytes) VALUES (?, NULL, ?) ON CONFLICT (key) DO UPDATE SET json = NULL, bytes = excluded.bytes`,
      [key, value],
    );
  }
  delete(key: string): void {
    this.db.run(`DELETE FROM sync_state WHERE key = ?`, [key]);
  }
  keys(prefix: string): string[] {
    return this.db
      .all<{ key: string }>(`SELECT key FROM sync_state WHERE substr(key, 1, ?) = ? ORDER BY key`, [prefix.length, prefix])
      .map((r) => r.key);
  }
}
