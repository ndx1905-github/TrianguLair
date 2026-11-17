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
import {
  cancelAllInvitations,
  verifyIndex,
  type CancelledInvitation,
  type DeviceCert,
  type DeviceSigner,
  type KeyPair,
  type OwnerInvitation,
  type SharingKey,
  type SignedIndex,
  type VaultRecords,
} from '@triangulair/crypto';
import type { DataStore } from '@triangulair/data';
import { HttpsReadOnlyAdapter, fetchHighestIndex, type StorageAdapter } from '@triangulair/storage';
import { ContactBook, type Contact, type SharePolicy } from './contacts.ts';
import type { DeviceEntry, EntrySigner, TrustContext } from './devices.ts';
import { DeviceRevokedError, classifyError, type SyncProblem } from './errors.ts';
import type { SyncLimits } from './limits.ts';
import { OwnSync, keyPath, type OwnSyncOptions, type PreviousVaultKey, type PublishReport, type PullResult } from './own.ts';
import { FriendReader, READ_MAJORS, type FriendReport } from './reader.ts';
import { ListReader, type FollowedListInfo, type ListPreview, type ListReport } from './followed.ts';
import { followIdOf, isFollowId, parseListLinkFragment } from './lists.ts';
import type { SyncStateStore } from './state.ts';
import { ByteBudget } from './util.ts';

/** What the app erases on a remote wipe (both may be async). */
export interface WipeHooks {
  /** Erase this device's keys from the system vault: sharing keys, vault data keys, device key, storage credentials, database key. */
  secrets?: () => void | Promise<void>;
  /** Erase the local database (default: `DataStore.wipe()`, every row, then the store is closed). */
  data?: () => void | Promise<void>;
}

export interface SyncEngineOptions
  extends Pick<OwnSyncOptions, 'capacity' | 'maxOwnDeltas' | 'blur' | 'author' | 'onSharingKey' | 'newId' | 'random' | 'fullCheckMs' | 'move'> {
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
  /** The pull that starts the pass (my other devices' changes are imported there). */
  pulled?: PullResult;
  friends: FriendReport[];
  /** Lists I follow by link (absent in reports made by older code). */
  lists?: ListReport[];
  problems: { about: 'own' | string; problem: SyncProblem }[];
  /** Everything worked (friends' failures included). */
  ok: boolean;
  /** This device was declared lost: the pass stopped and the local content was erased. */
  wiped?: boolean;
  /**
   * Invitation records dropped from my vault before this pass published (ContactBook.sweepInvitations):
   * `invalid` and `revoked` ones could not be verified ("An invitation could not be verified and was
   * removed"); `expired` ones ended their answer grace period. Absent when none was dropped.
   */
  invitationsDropped?: { invalid: string[]; revoked: string[]; expired: string[] };
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
            ...pick(o, ['capacity', 'maxOwnDeltas', 'blur', 'author', 'onSharingKey', 'newId', 'random', 'fullCheckMs', 'concurrency', 'now', 'limits', 'move']),
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

  /** Opt-in: link-only lists and the public file carry my tag names (kept in the vault: all my devices); publish after. */
  setPublicTagNames(on: boolean): void {
    this.book.setPublicTagNames(on, this.nowMs());
    this.saveBook();
  }

  // ------------------------------------------------------------------ lists followed by link

  /** Reads a list from its link fragment without following it. Throws ListGoneError, or the read's error. */
  previewList(fragment: string): Promise<ListPreview> {
    return this.lists.preview(fragment);
  }

  /**
   * Follows a list by its link: reads it first, and records it in the vault (so my other devices
   * follow it too) only when that read worked (review L-05). A failed read (`status: 'error'`) or a
   * gone list (`status: 'gone'`) leaves nothing behind: not followed, nothing in my cache; the app
   * says so and the user may try again. A list I already follow is only read again. Following my
   * own list is refused; beyond MAX_FOLLOWED_LISTS, TooManyFollowedListsError (before any download).
   * Do not run it concurrently with a sync pass (the app serializes both).
   */
  async followList(fragment: string): Promise<ListReport> {
    const link = parseListLinkFragment(fragment);
    if (link.owner === this.owner) throw new Error('this list is mine');
    const id = followIdOf(link);
    this.book.checkCanFollow(id);
    const already = this.book.followedLists().some((e) => e.id === id);
    const r = await this.lists.read({ id, link: fragment });
    if (already) return r;
    if (r.status === 'error' || r.status === 'gone') {
      this.lists.forget(id);
      return r;
    }
    this.book.followList(id, fragment, this.nowMs());
    this.saveBook();
    return r;
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

  // ------------------------------------------------------------------ my devices (devices.ts)

  /** The current certificate's revocations and the clock: who counts in the devices and values parts. */
  private trust(): TrustContext {
    return { revoked: (this.own?.sharing ?? this.o.sharing).cert.revoked_devices, now: this.nowMs() };
  }

  /** This device signs its entries in the vault (and is listed there first). */
  private signer(): EntrySigner | null {
    const d = this.o.device;
    if (!d) return null;
    this.book.putDeviceCert(d.cert);
    return { id: d.keys.id, secretKey: d.keys.sign.secretKey };
  }

  /**
   * My devices: every master-signed device certificate in the vault; `removed` when the current
   * sharing certificate revokes it (devices.ts: nothing a stolen device writes decides this).
   */
  devices(): DeviceEntry[] {
    return this.book.devices(this.trust());
  }

  /**
   * Lists a device (its certificate must be master-signed for me), e.g. right after adding it, with
   * this device's display entry for it (name, date added; the primary mark only for itself).
   */
  putDevice(cert: DeviceCert, info: { name: string; added?: number; primary?: boolean }): void {
    this.book.putDeviceCert(cert);
    const s = this.signer();
    if (s) this.book.putDeviceInfo(cert.device, { name: info.name, ...(info.added !== undefined && { added: info.added }), ...(info.primary !== undefined && { primary: info.primary }) }, s, this.nowMs(), this.trust());
    this.saveBook();
  }

  /** Rename, or this device's primary mark (display only), signed by this device. */
  updateDevice(id: string, patch: { name?: string; primary?: boolean }): void {
    const s = this.signer();
    if (!s) return;
    this.book.putDeviceInfo(id, patch, s, this.nowMs(), this.trust());
    this.saveBook();
  }

  /**
   * A small app value kept in the vault (storage settings, profile): the newest one signed by my
   * master key or by a certified device that the current certificate does not revoke.
   */
  value<T>(key: string): { value: T; at: number; by: string } | undefined {
    return this.book.value<T>(key, this.trust());
  }

  /** Sets a value, signed by this device (it then wins over every value seen so far). */
  setValue(key: string, value: unknown): void {
    const s = this.signer();
    if (!s) return;
    const before = this.book.records;
    this.book.setValue(key, value, s, this.nowMs(), this.trust());
    if (this.book.records !== before) this.saveBook();
  }

  /**
   * Adopts a new sharing certificate made on this device with the master key (spec "Loss and
   * theft": "Declare a device lost", a removed device, a storage move) and delivers the key to my
   * other devices (`keys/<device>.bin`) that the certificate does not revoke. Then run `sync()`: the
   * next publication re-encrypts everything for the new key and lists the new certificate.
   *
   * - `cancelInvitations` (a declaration of loss, V4-02): every open invitation is removed from the
   *   vault, whoever created it (`cancelAllInvitations`); the vault is re-sealed with the new vault
   *   data key at the next publication. Returned so the app can list the people to invite again.
   * - newly revoked devices: their `keys/` file is deleted and their vault entry marked removed.
   * - `recoveryCopy`: the sharing key sealed to my identity (TLSK mode 2, phrase-derived key), kept
   *   at `keys/<owner id>.bin` for a restore from the recovery kit.
   * - newly revoked devices (F-01 of the devices review): everything they signed in the devices and
   *   values parts is dropped, and the app values are reset to this device's (`values`, or its own
   *   entries), signed by it: a value a thief planted does not survive the declaration.
   * - keys are delivered to the devices whose certificate is master-signed and that the new
   *   certificate does not revoke, whatever the vault says about them (F-02).
   */
  async rotateKey(
    k: SharingKey,
    opts: { cancelInvitations?: boolean; recoveryCopy?: Uint8Array; values?: Record<string, unknown> } = {},
  ): Promise<{ cancelled: CancelledInvitation[]; delivered: string[] }> {
    const own = this.own;
    if (!own) throw new Error('rotateKey: no storage of mine');
    if (k.cert.owner !== this.owner) throw new Error('rotateKey: another identity');
    if (k.cert.rotation <= own.sharing.cert.rotation) throw new Error('rotateKey: not a newer rotation');
    let cancelled: CancelledInvitation[] = [];
    if (opts.cancelInvitations) {
      const r = cancelAllInvitations(this.book.records);
      this.book.records = r.records;
      cancelled = r.cancelled;
    }
    const before = new Set(own.sharing.cert.revoked_devices);
    const revoked = new Set(k.cert.revoked_devices);
    const me = own.device.keys.id;
    const targets = this.book
      .devices({ revoked, now: this.nowMs() })
      .filter((d) => d.cert.device !== me && d.removed === undefined)
      .map((d) => d.cert);
    await own.rotate(k, targets);
    for (const c of targets) this.o.state.set(deliveredKey(c.device), deliveredMark(k));
    const lost = [...revoked].filter((id) => !before.has(id));
    for (const id of lost) {
      this.o.state.delete(deliveredKey(id));
      try {
        await own.storage.delete(keyPath(id));
      } catch {
        // already gone
      }
    }
    if (lost.length) {
      this.book.markDevicesRemoved(lost, this.nowMs());
      this.book.dropSigners(lost);
      const s = this.signer();
      if (s) this.book.resetValues(opts.values ?? {}, s, this.nowMs());
    }
    if (opts.recoveryCopy) await own.storage.put(keyPath(this.owner), opts.recoveryCopy);
    this.saveBook();
    return { cancelled, delivered: targets.map((c) => c.device) };
  }

  /**
   * Seals my current sharing key to every listed device of mine that does not have it yet (a device
   * added since the last rotation, or one a previous delivery missed). Runs before each publication.
   */
  private async deliverKeys(): Promise<string[]> {
    const own = this.own;
    if (!own) return [];
    const k = own.sharing;
    const mark = deliveredMark(k);
    const done: string[] = [];
    for (const d of this.book.devices({ revoked: k.cert.revoked_devices, now: this.nowMs() })) {
      const id = d.cert.device;
      if (id === own.device.keys.id || d.removed !== undefined || this.o.state.get<string>(deliveredKey(id)) === mark) continue;
      await own.rotate(k, [d.cert]); // same key: only writes keys/<device>.bin
      this.o.state.set(deliveredKey(id), mark);
      done.push(id);
    }
    return done;
  }

  /**
   * A friend moved to a new identity (`report.identityMove`): read their new index at the same
   * certified address, verified for the new owner with the old one retired, and continue the
   * contact there (not verified any more). Returns the new identity's index, or null.
   */
  private async followMove(report: FriendReport): Promise<SignedIndex | null> {
    const m = report.identityMove;
    const c = m && !m.conflict ? this.book.contact(m.from) : undefined;
    const location = c?.sharingCert.location;
    if (!m || !c || !location) return null;
    try {
      const adapter = (this.o.readAdapter ?? ((l: string) => new HttpsReadOnlyAdapter({ baseUrl: l })))(location);
      const f = await fetchHighestIndex(adapter, READ_MAJORS, {}, { maxBytes: this.reader.limits.indexBytes });
      if (!f.changed) return null;
      const index = verifyIndex(f.index, { expectedOwner: m.to, location, retiredOwners: [...this.book.retiredOwners(), m.from], ...(this.o.now && { now: this.o.now() }) });
      if (!index.move || index.move.from !== m.from) return null;
      this.book.followMove(m.from, index, this.nowMs());
      this.reader.forget(m.from);
      this.saveBook();
      return index;
    } catch {
      return null;
    }
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
        report.pulled = await this.own.pull();
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
      // One byte budget for the whole pass: friends and lists followed by link (review L-07).
      const pass = new ByteBudget(this.reader.limits.passBytes, 'pass');
      report.friends = await this.reader.readAll(targets, this.o.friendConcurrency ?? 8, pass);
      // Friends who changed identity (theft of their primary device): follow the move, read them again.
      for (const f of [...report.friends]) {
        const index = f.identityMove ? await this.followMove(f) : null;
        if (!index) continue;
        f.identityMove = { ...f.identityMove!, followed: true };
        delete f.problem;
        const c = this.book.contact(index.owner)!;
        report.friends.push(await this.reader.read({ owner: c.owner, location: c.sharingCert.location!, retiredOwners: this.book.retiredOwners(), ...this.friendKeys(c.owner) }, { pass }));
      }
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
      report.lists = await this.lists.readAll(followed, this.o.friendConcurrency ?? 8, pass);
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
        // Invitation records that can never be listed again leave the vault (spec "Error cases").
        const swept = this.book.sweepInvitations(this.own.sharing.cert, this.nowMs());
        if (swept.invalid.length + swept.revoked.length + swept.expired.length > 0) {
          report.invitationsDropped = swept;
          this.saveBook();
        }
        await this.deliverKeys();
        report.own = await this.own.publish();
      } catch (e) {
        fail('own', e, 'own');
      }
    }
    report.durationMs = Date.now() - startedAt;
    return report;
  }
}

const deliveredKey = (device: string) => `own:delivered:${device}`;
const deliveredMark = (k: SharingKey) => `${k.cert.rotation}:${k.cert.key}`;

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
