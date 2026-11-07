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
export { Repository, parseTheirTags } from './sqlite/repository.ts';
export type {
  PlaceQuery,
  PlaceHit,
  PlaceSort,
  PlaceSource,
  MySaveSummary,
  MapPin,
  ForeignSaveInput,
  ForeignTag,
  SavePlaceSnapshot,
  FriendTagRow,
  OpenRepositoryOptions,
} from './sqlite/repository.ts';
export {
  createDataDoc,
  loadDataDoc,
  baseDocUpdate,
  clientIdFor,
  healDoc,
  mergeDataDocs,
  DocTx,
  DOC_SCHEMA,
  TRASH_RETENTION_MS,
  TOMBSTONE_RETENTION_MS,
  roots,
  saveEntry,
  saveEntryKeys,
  savePlaceIds,
  hasSave,
  tagIdsOf,
  listIdsOf,
  readTombstones,
  readDeletedAt,
  readSharing,
  updateText,
} from './crdt/doc.ts';
export type { DataDoc, EditContext, SaveInput, SavePatch, TagInput, ListInput, ListPatch, MediaInput, DocMedia } from './crdt/doc.ts';
export {
  projectAll,
  projectChanges,
  trackChanges,
  emptyTouched,
  readSave,
  readTags,
  readList,
  readTagMappings,
} from './crdt/project.ts';
export type { Touched, ProjectedSave } from './crdt/project.ts';
export { DataStore, DOC_FORMAT, PROJECTION_VERSION, snapshotOfUpdates } from './store.ts';
export { reassignOwner, databaseOwner } from './owner.ts';
export type { ReassignOwnerResult } from './owner.ts';
export type { OpenStoreOptions } from './store.ts';
