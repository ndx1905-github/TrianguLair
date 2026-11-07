// SPDX-License-Identifier: MPL-2.0
/**
 * @triangulair/sync — publishing and reading packs (T-204). Pure JavaScript
 * (no WebAssembly): libsodium (crypto), Yjs (data), fflate (compression).
 * Call `ready()` from @triangulair/crypto once before use.
 */
export { SyncEngine, type SyncEngineOptions, type SyncReport, type WipeHooks } from './engine.ts';
export { OwnSync, VAULT_PATH, keyPath, type OwnSyncOptions, type PublishReport, type PullResult, type PreviousVaultKey } from './own.ts';
export { FriendReader, READ_MAJORS, type ReaderOptions, type FriendTarget, type FriendReport, type WhatsNew, type ChangedItem } from './reader.ts';
export { SyncScheduler, type SchedulerOptions, type SyncStatus, type SyncReason, type Timers, type RunOptions } from './scheduler.ts';
export { ContactBook, mergeBooks, laterAnchor, OWN_ANCHOR_STEP, type Contact, type ContactPolicy, type SharePolicy } from './contacts.ts';
export { DEFAULT_LIMITS, resolveLimits, type SyncLimits } from './limits.ts';
export { ByteBudget, LimitError, Semaphore } from './util.ts';
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
  MAX_FEATURES_PER_PACK,
  COLOR_RE,
  ICON_RE,
  type PlaceFeature,
  type OwnItem,
  type TagOut,
} from './features.ts';
export { encodePayload, decodePayload, inflateBounded, PAYLOAD_VERSION, MAX_PAYLOAD_BYTES, PAYLOAD_LIMITS, PAYLOAD_PAD_FLOOR, type PayloadKind } from './payload.ts';
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
