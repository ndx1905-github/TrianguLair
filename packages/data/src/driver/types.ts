// SPDX-License-Identifier: MPL-2.0
/**
 * Minimal synchronous SQLite driver. Both better-sqlite3 (Node, tests) and
 * expo-sqlite (`*Sync` methods, JSI) are synchronous, which keeps the
 * repository simple and lets a whole projection run in one transaction.
 */

export type SqlValue = string | number | null | Uint8Array;
export type SqlParams = readonly SqlValue[];
export type Row = Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqlDriver {
  /** Runs one or more statements without parameters (DDL, PRAGMA). */
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): RunResult;
  all<T extends Row = Row>(sql: string, params?: SqlParams): T[];
  get<T extends Row = Row>(sql: string, params?: SqlParams): T | undefined;
  /**
   * Runs `fn` in a transaction (committed on return, rolled back on throw).
   * Nested calls join the outer transaction.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}
