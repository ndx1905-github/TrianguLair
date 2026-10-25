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
  MapPin,
  ForeignSaveInput,
  OpenRepositoryOptions,
} from './sqlite/repository.ts';
export {
  createDataDoc,
  loadDataDoc,
  healDoc,
  mergeDataDocs,
  DocTx,
  DOC_SCHEMA,
  TRASH_RETENTION_MS,
  TOMBSTONE_RETENTION_MS,
} from './crdt/doc.ts';
export type { DataDoc, EditContext, SaveInput, SavePatch, TagInput, ListInput, MediaInput } from './crdt/doc.ts';
export { projectAll, projectChanges, readSave, readTags, readList, readTagMappings } from './crdt/project.ts';
export { DataStore } from './store.ts';
export type { OpenStoreOptions } from './store.ts';
