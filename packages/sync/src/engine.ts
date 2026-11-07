// SPDX-License-Identifier: MPL-2.0
/**
 * SyncEngine: one sync pass = pull my storage (my other devices' changes,
 * the vault), read the people I follow, then publish what changed. The
 * scheduler decides when to run it.
 */
import type { DeviceSigner, KeyPair, SharingKey, SignedIndex, VaultRecords } from '@triangulair/crypto';
import type { DataStore } from '@triangulair/data';
import { HttpsReadOnlyAdapter, type StorageAdapter } from '@triangulair/storage';
import { ContactBook, type Contact, type SharePolicy } from './contacts.ts';
import { classifyError, type SyncProblem } from './errors.ts';
import { OwnSync, type OwnSyncOptions, type PublishReport } from './own.ts';
import { FriendReader, type FriendReport } from './reader.ts';
import type { SyncStateStore } from './state.ts';

export interface SyncEngineOptions
  extends Pick<OwnSyncOptions, 'capacity' | 'maxOwnDeltas' | 'blur' | 'author' | 'onSharingKey' | 'newId' | 'random' | 'fullCheckMs'> {
  store: DataStore;
  state: SyncStateStore;
  /** My current sharing key (friends wrap their packs to it), with its certificate and the vault data key. */
  sharing: SharingKey;
  previousSharingKeys?: KeyPair[];
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
}

export interface SyncReport {
  own: PublishReport | null;
  friends: FriendReport[];
  problems: { about: 'own' | string; problem: SyncProblem }[];
  /** Everything worked (friends' failures included). */
  ok: boolean;
  startedAt: number;
  durationMs: number;
}

const BOOK_KEY = 'vault:records';

export class SyncEngine {
  readonly book: ContactBook;
  readonly own: OwnSync | null;
  readonly reader: FriendReader;
  private readonly o: SyncEngineOptions;
  private running: Promise<SyncReport> | null = null;

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
            state: o.state,
            book: this.book,
            saveBook,
            ...pick(o, ['capacity', 'maxOwnDeltas', 'blur', 'author', 'onSharingKey', 'newId', 'random', 'fullCheckMs', 'concurrency', 'now']),
          })
        : null;
    this.reader = new FriendReader({
      store: o.store,
      state: o.state,
      keys: () => this.keys(),
      readAdapter: o.readAdapter ?? ((location) => new HttpsReadOnlyAdapter({ baseUrl: location })),
      ...pick(o, ['concurrency', 'fullCheckMs', 'now']),
    });
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

  contacts(): Contact[] {
    return this.book.contacts();
  }

  private nowMs(): number {
    return (this.o.now?.() ?? new Date()).getTime();
  }

  // ------------------------------------------------------------------ sync

  /** One sync pass. Concurrent calls share the pass in progress. */
  sync(opts: { publish?: boolean; readFriends?: boolean } = {}): Promise<SyncReport> {
    if (this.running) return this.running;
    this.running = this.run(opts).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(opts: { publish?: boolean; readFriends?: boolean }): Promise<SyncReport> {
    const startedAt = Date.now();
    const report: SyncReport = { own: null, friends: [], problems: [], ok: true, startedAt, durationMs: 0 };
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
          ? [{ owner: c.owner, location: c.sharingCert.location, anchor: c.anchor, retiredOwners: this.book.retiredOwners() }]
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
      if (touched) this.saveBook();
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
