// SPDX-License-Identifier: MPL-2.0
/**
 * @triangulair/sync — publishing and reading packs (T-204). Pure JavaScript
 * (no WebAssembly): libsodium (crypto), Yjs (data), fflate (compression).
 * Call `ready()` from @triangulair/crypto once before use.
 */
export { SyncEngine, type SyncEngineOptions, type SyncReport } from './engine.ts';
export { OwnSync, VAULT_PATH, keyPath, type OwnSyncOptions, type PublishReport, type PullResult } from './own.ts';
export { FriendReader, READ_MAJORS, type ReaderOptions, type FriendTarget, type FriendReport, type WhatsNew, type ChangedItem } from './reader.ts';
export { SyncScheduler, type SchedulerOptions, type SyncStatus, type SyncReason, type Timers } from './scheduler.ts';
export { ContactBook, mergeBooks, type Contact, type ContactPolicy, type SharePolicy } from './contacts.ts';
export { computeAudiences, audienceOf, fingerprint, type Audience } from './audience.ts';
export { planPacks, type ExistingPack, type DesiredItem, type PackPlan, type PackWrite, type PlanOptions } from './planner.ts';
export {
  featureFor,
  featureHash,
  parsePlaces,
  placesCollection,
  readOwnItems,
  toForeignSave,
  PLACES_VERSION,
  PLACES_MINOR,
  type PlaceFeature,
  type OwnItem,
  type TagOut,
} from './features.ts';
export { encodePayload, decodePayload, inflateBounded, PAYLOAD_VERSION, MAX_PAYLOAD_BYTES, type PayloadKind } from './payload.ts';
export { buildPublicLists, ODBL_ATTRIBUTION, ODBL_URL, PUBLIC_LISTS_NAME } from './public-lists.ts';
export { MemoryStateStore, SqliteStateStore, type SyncStateStore } from './state.ts';
export {
  classifyError,
  PayloadError,
  DeviceRevokedError,
  NeedsKeyError,
  TooManyRecipientsError,
  type SyncProblem,
  type SyncProblemKind,
} from './errors.ts';
