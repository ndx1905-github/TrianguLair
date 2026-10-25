// SPDX-License-Identifier: MPL-2.0
/** Node driver on better-sqlite3 (tests, tools). Not for the app bundle. */
import Database from 'better-sqlite3';
import type { RunResult, Row, SqlDriver, SqlParams } from './types.ts';

type Statement = Database.Statement<unknown[], unknown>;

export class NodeSqliteDriver implements SqlDriver {
  readonly raw: Database.Database;
  private readonly cache = new Map<string, Statement>();
  private depth = 0;

  constructor(filename = ':memory:', options?: Database.Options) {
    this.raw = new Database(filename, options);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
  }

  private stmt(sql: string): Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  private static bind(params: SqlParams): unknown[] {
    // better-sqlite3 binds Buffers, not plain Uint8Arrays.
    return params.map((p) =>
      p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p,
    );
  }

  run(sql: string, params: SqlParams = []): RunResult {
    const r = this.stmt(sql).run(...NodeSqliteDriver.bind(params));
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  }

  all<T extends Row = Row>(sql: string, params: SqlParams = []): T[] {
    return this.stmt(sql).all(...NodeSqliteDriver.bind(params)) as T[];
  }

  get<T extends Row = Row>(sql: string, params: SqlParams = []): T | undefined {
    return this.stmt(sql).get(...NodeSqliteDriver.bind(params)) as T | undefined;
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    try {
      this.raw.exec('BEGIN');
      try {
        const out = fn();
        this.raw.exec('COMMIT');
        return out;
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw e;
      }
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export function openNodeDriver(filename = ':memory:'): NodeSqliteDriver {
  return new NodeSqliteDriver(filename);
}
