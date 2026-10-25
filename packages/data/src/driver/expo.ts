// SPDX-License-Identifier: MPL-2.0
/**
 * expo-sqlite driver (app). Thin adapter over the synchronous JSI API; the app
 * opens the database itself and passes it in:
 *
 *   import { openDatabaseSync } from 'expo-sqlite';
 *   const driver = new ExpoSqliteDriver(openDatabaseSync('triangulair.db'));
 *
 * expo-sqlite bundles its own SQLite. FTS5 is compiled in by default; R*Tree is
 * NOT, so the app must add it through the config plugin:
 *
 *   ["expo-sqlite", { "customBuildFlags": "-DSQLITE_ENABLE_RTREE=1" }]
 *
 * Without it (and on web, whose wa-sqlite build has neither), the schema falls
 * back to plain B-tree indexes (see `detectCapabilities`).
 *
 * Only the types of expo-sqlite are imported: this file adds no runtime
 * dependency and is type-checked, not run, in this package's tests.
 */
import type { SQLiteBindValue, SQLiteDatabase, SQLiteStatement } from 'expo-sqlite';
import type { RunResult, Row, SqlDriver, SqlParams } from './types.ts';

export class ExpoSqliteDriver implements SqlDriver {
  private readonly cache = new Map<string, SQLiteStatement>();
  private depth = 0;

  constructor(
    readonly db: SQLiteDatabase,
    options: { pragmas?: boolean } = {},
  ) {
    if (options.pragmas !== false) db.execSync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }

  private stmt(sql: string): SQLiteStatement {
    let s = this.cache.get(sql);
    if (!s) {
      if (this.cache.size > 200) this.clearCache();
      s = this.db.prepareSync(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private clearCache(): void {
    for (const s of this.cache.values()) s.finalizeSync();
    this.cache.clear();
  }

  private bind(params: SqlParams): SQLiteBindValue[] {
    return params as SQLiteBindValue[];
  }

  exec(sql: string): void {
    this.db.execSync(sql);
  }

  run(sql: string, params: SqlParams = []): RunResult {
    const res = this.stmt(sql).executeSync(this.bind(params));
    try {
      return { changes: res.changes, lastInsertRowid: res.lastInsertRowId };
    } finally {
      res.resetSync();
    }
  }

  all<T extends Row = Row>(sql: string, params: SqlParams = []): T[] {
    const res = this.stmt(sql).executeSync<T>(this.bind(params));
    try {
      return res.getAllSync();
    } finally {
      res.resetSync();
    }
  }

  get<T extends Row = Row>(sql: string, params: SqlParams = []): T | undefined {
    const res = this.stmt(sql).executeSync<T>(this.bind(params));
    try {
      return res.getFirstSync() ?? undefined;
    } finally {
      res.resetSync();
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    try {
      this.db.execSync('BEGIN');
      try {
        const out = fn();
        this.db.execSync('COMMIT');
        return out;
      } catch (e) {
        this.db.execSync('ROLLBACK');
        throw e;
      }
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.clearCache();
    this.db.closeSync();
  }
}
