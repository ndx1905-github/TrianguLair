// SPDX-License-Identifier: MPL-2.0
/**
 * @triangulair/data — local data of the TrianguLair app.
 *
 * Storage-agnostic: bring a `SqlDriver` (`@triangulair/data/node` for
 * better-sqlite3, `@triangulair/data/expo` for expo-sqlite).
 */
export * from './types.ts';
export type { SqlDriver, SqlValue, SqlParams, Row, RunResult } from './driver/types.ts';
export * from './ids.ts';
export * from './geo.ts';
export * from './text.ts';
export * from './dedup.ts';
export * from './filter.ts';
export * from './place.ts';
export { migrate, detectCapabilities, readCapabilities, rebuildIndexes, SCHEMA_VERSION } from './sqlite/schema.ts';
export type { Capabilities, MigrateOptions } from './sqlite/schema.ts';
export { Repository } from './sqlite/repository.ts';
export type {
  PlaceQuery,
  PlaceHit,
  PlaceSort,
  PlaceSource,
  MySaveSummary,
  ForeignSaveInput,
  OpenRepositoryOptions,
} from './sqlite/repository.ts';
