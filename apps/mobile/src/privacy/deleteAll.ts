/**
 * "Delete all my content" (gap #6; spec "Editing and deleting" and "Store rules": there is no account on a project
 * server, so this covers Apple's account-deletion rule).
 *
 * Steps, each one idempotent so a failed run can simply be started again:
 *  1. my document is emptied: every place, zone, tag, list and tag mapping goes to the trash and is purged at once
 *     (tombstones only), so my other devices empty themselves at their next sync instead of publishing it back;
 *  2. every contact is removed (their wraps go, they lose all access), every open invitation is cancelled, every
 *     followed list is unfollowed;
 *  3. with a storage: a publication. The index it writes lists nothing for anyone: it is the signed "content deleted"
 *     marker (friends' apps verify it and empty their cache of my places, spec "Mechanics"). Then every other file of
 *     my folder is deleted: packs, photos, the public lists file, the recovery vault, `keys/` (so the recovery kit no
 *     longer restores anything) and transfer files. Only the index and the few files it lists (my own emptied
 *     document, sealed to my key) are left;
 *  4. this device is erased like a remote wipe: secrets first (with the database key, so the database is unreadable
 *     at once), then the database and the device settings.
 * A storage failure in step 3 stops before step 4: nothing local is erased and the error is shown with "Try again".
 */
import { savePlaceIds, type DataStore } from '@triangulair/data';
import type { StorageAdapter } from '@triangulair/storage';

export type DeleteStep = 'content' | 'contacts' | 'publish' | 'files' | 'device';

export interface DeleteAllSummary {
  places: number;
  zones: number;
  tags: number;
  lists: number;
  contacts: number;
  invitations: number;
  followedLists: number;
  /** A storage was connected (else: local only, nothing to delete there). */
  storage: boolean;
  filesDeleted: number;
  /** Files that could not be deleted (path only). */
  filesFailed: string[];
  /** Files left on purpose: the signed marker (index) and what it lists. */
  filesKept: number;
  /** The storage cannot list its files (HTTPS-only, or a server without listing). */
  listingUnsupported: boolean;
}

export interface DeleteAllDeps {
  store: DataStore;
  contacts(): string[];
  removeContact(owner: string): void;
  /** Cancels every open invitation; returns how many. */
  cancelInvitations(): number;
  followedLists(): string[];
  unfollowList(id: string): void;
  /** Publishes (null in local-only mode); returns the paths the new index lists. Throws on failure. */
  publish: (() => Promise<{ listed: string[] }>) | null;
  storage: StorageAdapter | null;
  /** Erases this device (secrets first). */
  wipe(): Promise<void>;
  onStep?(step: DeleteStep): void;
}

const INDEX_FILE = /^index(\.v[0-9]+)?\.json$/;

/** Empties my document (step 1). Returns what it held. */
export function emptyDocument(store: DataStore): Pick<DeleteAllSummary, 'places' | 'zones' | 'tags' | 'lists'> {
  const repo = store.repo;
  const placeIds = savePlaceIds(store.doc);
  let zones = 0;
  for (const id of placeIds) if (repo.getPlace(id)?.kind === 'zone') zones++;
  const tags = repo.tags().map((t) => t.id);
  const lists = repo.lists({ includeDeleted: true }).map((l) => l.id);
  const mappings = repo.tagMappings();
  store.change((tx) => {
    for (const m of mappings) tx.setTagMapping(m.personId, m.theirTag, null);
    for (const id of placeIds) tx.deleteSave(id);
    for (const id of tags) tx.deleteTag(id);
    for (const id of lists) tx.deleteList(id);
    for (const id of placeIds) tx.purgeTrash({ kind: 'save', id });
    for (const id of tags) tx.purgeTrash({ kind: 'tag', id });
    for (const id of lists) tx.purgeTrash({ kind: 'list', id });
  });
  return { places: placeIds.length - zones, zones, tags: tags.length, lists: lists.length };
}

/** Deletes every file of my folder but the index and what it lists (step 3). */
export async function deleteStorageFiles(storage: StorageAdapter, listed: readonly string[]): Promise<Pick<DeleteAllSummary, 'filesDeleted' | 'filesFailed' | 'filesKept' | 'listingUnsupported'>> {
  const keep = new Set(listed);
  let entries: { path: string }[];
  try {
    entries = storage.capabilities.list ? await storage.list('') : [];
  } catch {
    entries = [];
  }
  if (!storage.capabilities.list) return { filesDeleted: 0, filesFailed: [], filesKept: 0, listingUnsupported: true };
  let filesDeleted = 0;
  let filesKept = 0;
  const filesFailed: string[] = [];
  for (const e of entries) {
    if (INDEX_FILE.test(e.path) || keep.has(e.path)) {
      filesKept++;
      continue;
    }
    try {
      await storage.delete(e.path);
      filesDeleted++;
    } catch {
      filesFailed.push(e.path);
    }
  }
  return { filesDeleted, filesFailed, filesKept, listingUnsupported: false };
}

export async function deleteAllContent(d: DeleteAllDeps): Promise<DeleteAllSummary> {
  d.onStep?.('content');
  const content = emptyDocument(d.store);
  d.onStep?.('contacts');
  const contacts = d.contacts();
  for (const o of contacts) d.removeContact(o);
  const invitations = d.cancelInvitations();
  const followed = d.followedLists();
  for (const id of followed) d.unfollowList(id);
  let files: Pick<DeleteAllSummary, 'filesDeleted' | 'filesFailed' | 'filesKept' | 'listingUnsupported'> = { filesDeleted: 0, filesFailed: [], filesKept: 0, listingUnsupported: false };
  if (d.publish && d.storage) {
    d.onStep?.('publish');
    const { listed } = await d.publish();
    d.onStep?.('files');
    files = await deleteStorageFiles(d.storage, listed);
  }
  d.onStep?.('device');
  await d.wipe();
  return { ...content, contacts: contacts.length, invitations, followedLists: followed.length, storage: !!(d.publish && d.storage), ...files };
}
