/**
 * `SyncPort`: everything the contacts service needs from the sync engine, and nothing more. The
 * app's SyncProvider (T-210 wiring) hands one over with `engineSyncPort(engine, …)`; until it
 * does, `localEngine.ts` builds a small engine of its own (see ContactsProvider).
 *
 * The first block is the sync package's contact API as it is (`addContact`, `setPolicy`,
 * `removeContact`, `addInvitation`, `contacts`). The second block covers what that API does not
 * offer yet; `engineSyncPort` implements it over `engine.book` (see "Gaps" below), so the service
 * never touches the engine directly.
 *
 * Gaps in @triangulair/sync (to move into the package, then drop the workarounds here):
 * - recording the answers received and the accepted responder of an invitation
 *   (`invitationRecord(inv, { answers, accepted })` in the vault), withdrawing one;
 * - adding a contact from a return link whose responder has no storage yet (no index to make a
 *   vault anchor from: `ContactBook.addContact` takes a SignedIndex);
 * - saving the book after such a change (`SyncEngine.saveBook` is private): done here by writing
 *   the same state key (`vault:records`) and `own.touchVault()`.
 */
import {
  StorageMovedError,
  verifyIndex,
  type DeviceSigner,
  type IndexAnchor,
  type KeyPair,
  type OwnerInvitation,
  type SharingCert,
  type SignedIndex,
  type VaultRecords,
} from '@triangulair/crypto';
import type { StorageAdapter } from '@triangulair/storage';
import type { Contact, FriendReport, FriendTarget, SharePolicy, SyncEngine, SyncStateStore } from '@triangulair/sync';

export interface SyncPort {
  /** My owner id ("ed25519:…"). */
  readonly owner: string;
  /** My current sharing certificate (its `location` is my certified read address, if any). */
  sharingCert(): SharingCert;
  /** This device's signer (invitations and answers are signed by the device, never the master key). */
  device(): DeviceSigner;
  /** A storage is connected: I can publish (and so invite). */
  canPublish(): boolean;

  // The sync package's contact API.
  addContact(index: SignedIndex, policy: { share?: SharePolicy; follow?: boolean; verified?: boolean }): void;
  setPolicy(owner: string, patch: { share?: SharePolicy; follow?: boolean }): void;
  removeContact(owner: string): void;
  addInvitation(invitation: OwnerInvitation): void;
  contacts(): Contact[];

  // Not in the sync package yet (see the module comment).
  /** My vault records (contacts, invitations with their answers, retired identities). */
  records(): VaultRecords;
  /** Changes the vault records and saves them (local copy now, the storage at the next publication). */
  updateRecords(fn: (r: VaultRecords) => VaultRecords): void;
  /**
   * Publishes now: the vault, then the index (which lists my open invitations), re-sealing every
   * pack whose recipients changed with new pack keys (acceptance, removal, expiry). Throws on
   * failure. Does not read friends.
   */
  publish(): Promise<void>;
  /**
   * Someone's signed index, read ONLY at `location` (following a master-certified move once), and
   * verified for `expectedOwner` with the address it was read from (what checkInvitationIndex needs).
   */
  fetchIndex(location: string, expectedOwner: string, lastSeen?: SignedIndex | IndexAnchor): Promise<SignedIndex>;
  /** Reads a friend's content into the local cache now (`extraKeys`: an invitation key before my answer is accepted). */
  readFriend(target: FriendTarget): Promise<FriendReport>;
  /** When the friend was last read successfully (ms), or null. */
  lastSuccess(owner: string): number | null;
}

export interface EngineSyncPortOptions {
  engine: SyncEngine;
  /** The engine's state store (the vault records are saved there, as the engine does). */
  state: SyncStateStore;
  sharing: () => SharingCert;
  device: () => DeviceSigner;
  /** Anonymous adapter for a read address (default: the engine's; HttpsReadOnlyAdapter). */
  readAdapter: (location: string) => StorageAdapter;
  /** Index size limit before verification (sync DEFAULT_LIMITS.indexBytes). */
  maxIndexBytes?: number;
}

/** Same key as SyncEngine's BOOK_KEY. */
const BOOK_KEY = 'vault:records';
const MAX_INDEX_BYTES = 4 * 1024 * 1024;

/** Reads and verifies `owner`'s index at `location` (and at most one certified redirect). */
export async function fetchVerifiedIndex(
  readAdapter: (location: string) => StorageAdapter,
  location: string,
  expectedOwner: string,
  lastSeen?: SignedIndex | IndexAnchor,
  maxBytes = MAX_INDEX_BYTES,
): Promise<SignedIndex> {
  let at = location;
  for (let hop = 0; hop < 2; hop++) {
    const g = await readAdapter(at).get('index.json', { maxBytes });
    if (!g) throw new IndexMissingError(at);
    try {
      return verifyIndex(g.data, { expectedOwner, location: at, ...(lastSeen && { lastSeen }) });
    } catch (e) {
      if (e instanceof StorageMovedError && hop === 0) {
        at = e.location;
        continue;
      }
      throw e;
    }
  }
  throw new IndexMissingError(at);
}

/** No index at the address (nothing published there, or a wrong address). */
export class IndexMissingError extends Error {
  constructor(readonly location: string) {
    super(`no index at ${location}`);
    this.name = 'IndexMissingError';
  }
}

/** The thin adapter from a SyncEngine to the port. */
export function engineSyncPort(o: EngineSyncPortOptions): SyncPort {
  const { engine } = o;
  const save = () => {
    o.state.set(BOOK_KEY, engine.book.records);
    engine.own?.touchVault();
  };
  return {
    get owner() {
      return engine.owner;
    },
    sharingCert: o.sharing,
    device: o.device,
    canPublish: () => engine.own !== null && o.sharing().location !== undefined,
    addContact: (index, policy) => engine.addContact(index, policy),
    setPolicy: (owner, patch) => engine.setPolicy(owner, patch),
    removeContact: (owner) => engine.removeContact(owner),
    addInvitation: (inv) => engine.addInvitation(inv),
    contacts: () => engine.contacts(),
    records: () => engine.book.records,
    updateRecords: (fn) => {
      engine.book.records = fn(engine.book.records);
      save();
    },
    publish: async () => {
      if (!engine.own) return;
      // One more pass after a lost race (another device, or a server with weak ETags).
      for (let attempt = 0; ; attempt++) {
        const r = await engine.sync({ publish: true, readFriends: false });
        const own = r.problems.find((p) => p.about === 'own');
        if (!own) return;
        if (attempt === 0 && own.problem.retryable) continue;
        throw new PublishError(own.problem.kind, own.problem.message);
      }
    },
    fetchIndex: (location, expectedOwner, lastSeen) => fetchVerifiedIndex(o.readAdapter, location, expectedOwner, lastSeen, o.maxIndexBytes),
    readFriend: async (target) => {
      const r = await engine.reader.read(target);
      if (r.index && engine.book.contact(target.owner)) {
        engine.book.noteIndex(r.index);
        save();
      }
      return r;
    },
    lastSuccess: (owner) => engine.reader.lastSuccess(owner),
  };
}

/** My publication failed (storage unreachable, credentials refused…): `kind` is the sync problem kind. */
export class PublishError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

export type { KeyPair };
