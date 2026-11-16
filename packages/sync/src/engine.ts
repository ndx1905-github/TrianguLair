// SPDX-License-Identifier: MPL-2.0
/**
 * SyncEngine: one sync pass = pull my storage (my other devices' changes,
 * the vault), read the people I follow, then publish what changed. The
 * scheduler decides when to run it.
 *
 * Remote wipe (spec "Loss and theft"): when my own index says this device
 * was declared lost, the pass stops right there (nothing more is read or
 * decrypted) and the engine erases everything it can reach: the in-memory
 * keys, its sync state, the local database (`DataStore.wipe`, or the app's
 * `wipe.data`), and, through `wipe.secrets`, the keys in the system vault.
 * Every later `sync()` returns at once with the same problem.
 */
import type { DeviceSigner, KeyPair, OwnerInvitation, SharingKey, SignedIndex, VaultRecords } from '@triangulair/crypto';
import type { DataStore } from '@triangulair/data';
import { HttpsReadOnlyAdapter, type StorageAdapter } from '@triangulair/storage';
import { ContactBook, type Contact, type SharePolicy } from './contacts.ts';
import { DeviceRevokedError, classifyError, type SyncProblem } from './errors.ts';
import type { SyncLimits } from './limits.ts';
import { OwnSync, type OwnSyncOptions, type PreviousVaultKey, type PublishReport } from './own.ts';
import { FriendReader, type FriendReport } from './reader.ts';
import { ListReader, type FollowedListInfo, type ListPreview, type ListReport } from './followed.ts';
import { followIdOf, isFollowId, parseListLinkFragment } from './lists.ts';
import type { SyncStateStore } from './state.ts';

/** What the app erases on a remote wipe (both may be async). */
export interface WipeHooks {
  /** Erase this device's keys from the system vault: sharing keys, vault data keys, device key, storage credentials, database key. */
  secrets?: () => void | Promise<void>;
  /** Erase the local database (default: `DataStore.wipe()`, every row, then the store is closed). */
  data?: () => void | Promise<void>;
}

export interface SyncEngineOptions
  extends Pick<OwnSyncOptions, 'capacity' | 'maxOwnDeltas' | 'blur' | 'author' | 'onSharingKey' | 'newId' | 'random' | 'fullCheckMs'> {
  store: DataStore;
  state: SyncStateStore;
  /** My current sharing key (friends wrap their packs to it), with its certificate and the vault data key. */
  sharing: SharingKey;
  previousSharingKeys?: KeyPair[];
  /** Earlier vault data keys (`engine.own.previousVaultKeys`, persisted by the app with the sharing keys). */
  previousVaultKeys?: PreviousVaultKey[];
  /** Size limits (downloads before verification, decompression, per friend and per pass). */
  limits?: Partial<SyncLimits>;
  /** Remote wipe: called once this device finds itself declared lost (see the module comment). */
  wipe?: WipeHooks;
  /** This device's keys and certificate: needed to publish. */
  device?: DeviceSigner;
  /** My storage (write access). Without it the app is local only, but can still read friends. */
  storage?: StorageAdapter;
  /** Read adapter for a friend's HTTPS read address (default HttpsReadOnlyAdapter). */
  readAdapter?: (location: string) => StorageAdapter;
  concurrency?: number;
  /** Friends read in parallel (default 8). */
  friendConcurrency?: number;
  now?: () => Date;
  /** Whether the device has network (from the app's network status); used to classify failures. */
  online?: () => boolean;
  /**
   * Extra keys to read one friend with at every pass (`FriendTarget.extraKeys`): the invitation key
   * pair of a link I answered, until my answer is accepted. Without it a regular pass reads that
   * friend with my keys only, finds nothing wrapped to me yet and erases what the invitation showed.
   */
  friendKeys?: (owner: string) => KeyPair[];
}

export interface SyncReport {
  own: PublishReport | null;
  friends: FriendReport[];
  /** Lists I follow by link (absent in reports made by older code). */
  lists?: ListReport[];
  problems: { about: 'own' | string; problem: SyncProblem }[];
  /** Everything worked (friends' failures included). */
  ok: boolean;
  /** This device was declared lost: the pass stopped and the local content was erased. */
  wiped?: boolean;
  startedAt: number;
  durationMs: number;
}

const BOOK_KEY = 'vault:records';

export class SyncEngine {
  readonly book: ContactBook;
  readonly own: OwnSync | null;
  readonly reader: FriendReader;
  /** Lists followed by link (no contact needed). */
  readonly lists: ListReader;
  private readonly o: SyncEngineOptions;
  private running: Promise<SyncReport> | null = null;
  private wiped = false;

  constructor(o: SyncEngineOptions) {
    this.o = o;
    const saved = o.state.get<VaultRecords>(BOOK_KEY);
    this.book = saved ? new ContactBook(saved) : ContactBook.empty(o.sharing.cert.owner);
    const saveBook = () => o.state.set(BOOK_KEY, this.book.records);
    this.own =
      o.storage && o.device
        ? new OwnSync({
            store: o.store,
            storage: o.storage,
            device: o.device,
            sharing: o.sharing,
            ...(o.previousSharingKeys && { previousSharingKeys: o.previousSharingKeys }),
            ...(o.previousVaultKeys && { previousVaultKeys: o.previousVaultKeys }),
            state: o.state,
            book: this.book,
            saveBook,
            ...pick(o, ['capacity', 'maxOwnDeltas', 'blur', 'author', 'onSharingKey', 'newId', 'random', 'fullCheckMs', 'concurrency', 'now', 'limits']),
          })
        : null;
    this.reader = new FriendReader({
      store: o.store,
      state: o.state,
      keys: () => this.keys(),
      readAdapter: o.readAdapter ?? ((location) => new HttpsReadOnlyAdapter({ baseUrl: location })),
      ...pick(o, ['concurrency', 'fullCheckMs', 'now', 'limits']),
    });
    this.lists = new ListReader({
      store: o.store,
      state: o.state,
      readAdapter: o.readAdapter ?? ((location) => new HttpsReadOnlyAdapter({ baseUrl: location })),
      ...pick(o, ['concurrency', 'fullCheckMs', 'now', 'limits']),
    });
  }

  private friendKeys(owner: string): { extraKeys?: KeyPair[] } {
    const k = this.o.friendKeys?.(owner) ?? [];
    return k.length ? { extraKeys: k } : {};
  }

  /** This device was declared lost and has erased its content (see the module comment). */
  get isWiped(): boolean {
    return this.wiped;
  }

  /**
   * Remote wipe: erases the in-memory keys, the sync state (anchors, caches, the local vault copy),
   * the local database and, through the app's hook, the keys in the system vault. The engine is
   * unusable afterwards. Called by `sync()` when this device finds itself revoked; the app may also
   * call it itself ("lock and wipe after X days without sync").
   */
  async wipe(): Promise<void> {
    this.wiped = true;
    const errors: unknown[] = [];
    const step = async (fn: () => void | Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    };
    await step(() => this.o.wipe?.secrets?.());
    for (const k of [...this.keys(), ...(this.o.previousSharingKeys ?? [])]) k.secretKey.fill(0);
    this.o.sharing.vaultDataKey.fill(0);
    for (const v of this.own?.previousVaultKeys ?? []) v.key.fill(0);
    await step(() => {
      for (const k of this.o.state.keys('')) this.o.state.delete(k);
    });
    this.book.records = ContactBook.empty(this.owner).records;
    await step(() => (this.o.wipe?.data ? this.o.wipe.data() : this.o.store.wipe()));
    if (errors.length) throw errors[0];
  }

  get owner(): string {
    return this.o.sharing.cert.owner;
  }

  /** My key pairs that friends may wrap to (current first). */
  keys(): KeyPair[] {
    return this.own ? this.own.keys() : [this.o.sharing.keyPair, ...(this.o.previousSharingKeys ?? [])];
  }

  private saveBook(): void {
    this.o.state.set(BOOK_KEY, this.book.records);
    this.own?.touchVault();
  }

  // ------------------------------------------------------------------ contacts

  /** Adds a contact from their verified index (read at their certified address). */
  addContact(index: SignedIndex, policy: { share?: SharePolicy; follow?: boolean; verified?: boolean }): void {
    this.book.addContact(index, policy, this.nowMs());
    this.saveBook();
  }

  setPolicy(owner: string, patch: { share?: SharePolicy; follow?: boolean }): void {
    this.book.setPolicy(owner, patch, this.nowMs());
    this.saveBook();
    if (patch.follow === false) this.reader.forget(owner);
  }

  /** Removes a contact: their wraps disappear at the next publication, their content leaves my cache now. */
  removeContact(owner: string): void {
    this.book.remove(owner, this.nowMs());
    this.saveBook();
    this.reader.forget(owner);
  }

  /** Records an invitation I created (see ContactBook.addInvitation); publish before sending its link. */
  addInvitation(invitation: OwnerInvitation): void {
    this.book.addInvitation(invitation);
    this.saveBook();
  }

  contacts(): Contact[] {
    return this.book.contacts();
  }

  /** Gives or takes a contact's access to one of my lists (ContactBook.setListAccess); publish after. */
  setListAccess(owner: string, listId: string, on: boolean): void {
    this.book.setListAccess(owner, listId, on, this.nowMs());
    this.saveBook();
  }

  // ------------------------------------------------------------------ lists followed by link

  /** Reads a list from its link fragment without following it. Throws ListGoneError, or the read's error. */
  previewList(fragment: string): Promise<ListPreview> {
    return this.lists.preview(fragment);
  }

  /**
   * Follows a list by its link (kept in the vault, so my other devices follow it too) and reads it
   * now. Following my own list is refused.
   */
  async followList(fragment: string): Promise<ListReport> {
    const link = parseListLinkFragment(fragment);
    if (link.owner === this.owner) throw new Error('this list is mine');
    const id = followIdOf(link);
    this.book.followList(id, fragment, this.nowMs());
    this.saveBook();
    return this.lists.read({ id, link: fragment });
  }

  /** Stops following a list: its places leave my cache now. */
  unfollowList(id: string): void {
    this.book.unfollowList(id, this.nowMs());
    this.saveBook();
    this.lists.forget(id);
  }

  followedLists(): FollowedListInfo[] {
    return this.book.followedLists().flatMap((e) => {
      try {
        return [this.lists.info(e.id, e.link)];
      } catch {
        return [];
      }
    });
  }

  private nowMs(): number {
    return (this.o.now?.() ?? new Date()).getTime();
  }

  // ------------------------------------------------------------------ sync

  /** One sync pass. Concurrent calls share the pass in progress. */
  sync(opts: { publish?: boolean; readFriends?: boolean } = {}): Promise<SyncReport> {
    if (this.wiped) {
      const problem = classifyError(new DeviceRevokedError(), 'own');
      return Promise.resolve({ own: null, friends: [], lists: [], problems: [{ about: 'own', problem }], ok: false, wiped: true, startedAt: Date.now(), durationMs: 0 });
    }
    if (this.running) return this.running;
    this.running = this.run(opts).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(opts: { publish?: boolean; readFriends?: boolean }): Promise<SyncReport> {
    const startedAt = Date.now();
    const report: SyncReport = { own: null, friends: [], lists: [], problems: [], ok: true, startedAt, durationMs: 0 };
    const online = this.o.online?.() ?? true;
    const fail = (about: string, e: unknown, kind: 'own' | 'friend') => {
      report.problems.push({ about, problem: classifyError(e, kind, online) });
      report.ok = false;
    };
    // 1. My storage first: my other devices may have added contacts (vault) or changed my keys.
    let ownOk = true;
    if (this.own) {
      try {
        await this.own.pull();
      } catch (e) {
        ownOk = false;
        fail('own', e, 'own');
        if (e instanceof DeviceRevokedError) {
          // Stop here: nothing more is read or decrypted on a device declared lost (R-05).
          try {
            await this.wipe();
          } catch (w) {
            fail('own', w, 'own');
          }
          report.wiped = true;
          report.durationMs = Date.now() - startedAt;
          return report;
        }
      }
    }
    // Contacts I stopped following or removed (possibly on another device): erase their content.
    for (const k of this.o.state.keys('friend:')) {
      const owner = k.slice('friend:'.length);
      const c = this.book.contact(owner);
      if (!c || !c.policy.follow) this.reader.forget(owner);
    }
    // 2. Friends.
    if (opts.readFriends !== false) {
      const targets = this.book.following().flatMap((c) =>
        c.sharingCert.location
          ? [{ owner: c.owner, location: c.sharingCert.location, anchor: c.anchor, retiredOwners: this.book.retiredOwners(), ...this.friendKeys(c.owner) }]
          : [],
      );
      report.friends = await this.reader.readAll(targets, this.o.friendConcurrency ?? 8);
      let touched = false;
      for (const f of report.friends) {
        if (f.index) {
          this.book.noteIndex(f.index);
          touched = true;
        }
        if (f.problem) {
          report.problems.push({ about: f.owner, problem: f.problem });
          report.ok = false;
        }
      }
      if (this.book.pruneFollowedLists(this.nowMs())) touched = true;
      if (touched) this.saveBook();
      // Lists followed by link (unfollowed on another device: their places leave).
      const followed = this.book.followedLists().filter((e) => isFollowId(e.id));
      const ids = new Set(followed.map((e) => e.id));
      for (const id of this.lists.known()) if (!ids.has(id)) this.lists.forget(id);
      report.lists = await this.lists.readAll(followed, this.o.friendConcurrency ?? 8);
      for (const l of report.lists ?? []) {
        if (l.problem) {
          report.problems.push({ about: l.id, problem: l.problem });
          report.ok = false;
        }
      }
    }
    // 3. Publish.
    if (this.own && ownOk && opts.publish !== false) {
      try {
        report.own = await this.own.publish();
      } catch (e) {
        fail('own', e, 'own');
      }
    }
    report.durationMs = Date.now() - startedAt;
    return report;
  }
}

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
