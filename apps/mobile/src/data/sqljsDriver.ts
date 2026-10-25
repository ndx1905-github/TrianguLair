/**
 * SqlDriver (from @triangulair/data) on sql.js: SQLite compiled to
 * WebAssembly, fully in memory and synchronous once loaded. Used by the web
 * test build, where expo-sqlite's web backend needs cross-origin isolation
 * headers that a static export cannot rely on. Native builds use expo-sqlite.
 *
 * sql.js has no R*Tree and no FTS5: the data package detects this and uses
 * its fallback indexes (same results, slower).
 *
 * Persistence is the caller's job: `onWrite` fires after every write outside
 * a transaction (and once per committed transaction); `export()` returns the
 * whole database file.
 */
import type { Database, Statement } from 'sql.js';
import type { RunResult, Row, SqlDriver, SqlParams } from '@triangulair/data';

export class SqlJsDriver implements SqlDriver {
  private readonly cache = new Map<string, Statement>();
  private depth = 0;
  private dirtyInTx = false;

  constructor(
    readonly db: Database,
    private readonly onWrite: () => void = () => {},
  ) {
    db.exec('PRAGMA foreign_keys = ON;');
  }

  private stmt(sql: string): Statement {
    let s = this.cache.get(sql);
    if (!s) {
      if (this.cache.size > 200) this.clearCache();
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private clearCache(): void {
    for (const s of this.cache.values()) s.free();
    this.cache.clear();
  }

  private wrote(): void {
    if (this.depth > 0) this.dirtyInTx = true;
    else this.onWrite();
  }

  exec(sql: string): void {
    // DDL invalidates prepared statements' schema; sql.js re-prepares lazily,
    // but cached statements of dropped tables must go.
    this.clearCache();
    this.db.exec(sql);
    this.wrote();
  }

  run(sql: string, params: SqlParams = []): RunResult {
    const s = this.stmt(sql);
    try {
      s.bind(params as (string | number | null | Uint8Array)[]);
      while (s.step()) {
        /* drain (RETURNING clauses) */
      }
    } finally {
      s.reset();
    }
    const changes = this.db.getRowsModified();
    const last = this.db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0];
    this.wrote();
    return { changes, lastInsertRowid: typeof last === 'number' ? last : Number(last ?? 0) };
  }

  all<T extends Row = Row>(sql: string, params: SqlParams = []): T[] {
    const s = this.stmt(sql);
    const out: T[] = [];
    try {
      s.bind(params as (string | number | null | Uint8Array)[]);
      while (s.step()) out.push(s.getAsObject() as T);
    } finally {
      s.reset();
    }
    return out;
  }

  get<T extends Row = Row>(sql: string, params: SqlParams = []): T | undefined {
    const s = this.stmt(sql);
    try {
      s.bind(params as (string | number | null | Uint8Array)[]);
      return s.step() ? (s.getAsObject() as T) : undefined;
    } finally {
      s.reset();
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.dirtyInTx = false;
    let committed = false;
    try {
      this.db.exec('BEGIN');
      try {
        const out = fn();
        this.db.exec('COMMIT');
        committed = true;
        return out;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    } finally {
      this.depth--;
      if (committed && this.dirtyInTx) this.onWrite();
      this.dirtyInTx = false;
    }
  }

  /** The whole database file (for persistence). */
  export(): Uint8Array {
    // sql.js `export()` closes and reopens the database, which frees statements.
    this.clearCache();
    const bytes = this.db.export();
    this.db.exec('PRAGMA foreign_keys = ON;');
    return bytes;
  }

  close(): void {
    this.clearCache();
    this.db.close();
  }
}
