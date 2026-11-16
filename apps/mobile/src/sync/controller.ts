/**
 * The app's sync glue (T-210), without React: builds the `SyncEngine` from my identity's keys, the
 * storage settings (`StorageAccess`) and the local data store; runs it from a `SyncScheduler`
 * (launch, foreground, edits, pull to refresh, a last pass when the app goes to the background,
 * nothing after that); implements the storage screens' `StorageMoveHooks` (publish at the new
 * storage and leave the signed redirect at the old ones) and `republishPending`; records What's
 * new; and carries the remote wipe to the app's hooks (secrets, then the database).
 *
 * It also hands the invitation and contacts screens (T-208/T-209) a `SyncPort` over this same
 * engine (`port()`, registered by the SyncProvider): their publications and reads run inside the
 * controller's lock, so exactly one engine publishes from this database. At every pass, a friend
 * whose invitation link I answered is read with that invitation key too (`friendKeys`), until they
 * accept my answer.
 *
 * `SyncProvider.tsx` is the React side (AppState, network status, screens). Unit-tested with
 * in-memory storages (`sync.test.ts`).
 */
import { ready, verifyIndex, type DeviceSigner, type KeyPair, type SharingCert, type SharingKey, type SignedIndex } from '@triangulair/crypto';
import type { DataStore } from '@triangulair/data';
import { HttpsReadOnlyAdapter, type StorageAdapter } from '@triangulair/storage';
import {
  SyncEngine,
  SyncScheduler,
  type SharePolicy,
  type SyncProblem,
  type SyncReason,
  type SyncReport,
  type SyncStateStore,
  type SyncStatus,
  type FriendReport,
  type Timers,
  type FollowedListInfo,
  type ListDef,
  type ListPreview,
  type ListReport,
  heldPublicPlaces,
  listLinkFragment,
  listSecretOf,
  readOwnItems,
  newListKey,
  publicListsUrl,
} from '@triangulair/sync';

import { engineSyncPort, type SyncPort } from '../contacts/port';
import type { OpenInvitationSummary, StorageAccess, StorageMoveHooks } from '../storage/interfaces';
import type { SyncKeys } from './keys';
import { confirmInFilter } from '../lists/sharing';
import { logLine } from './problems';
import { WhatsNewLog } from './whatsNew';

const INDEX = 'index.json';
const INDEX_MAX = 4 * 1024 * 1024;
const LOG_KEY = 'app:log';
const LOG_MAX = 80;
const OWN_OK_KEY = 'app:own-ok';

export interface ControllerDeps {
  store: DataStore;
  state: SyncStateStore;
  /** Fresh from the secret store (after a rotation, the new sharing key). */
  loadKeys(): Promise<SyncKeys>;
  /** The engine adopted a new sharing key (rotation made on another device): store it. */
  saveKeys(k: { sharing: SharingKey; previousSharingKeys: SyncKeys['previousSharingKeys']; previousVaultKeys: SyncKeys['previousVaultKeys'] }): Promise<void>;
  access: StorageAccess;
  /** A friend's read address → adapter (default: anonymous HTTPS). */
  readAdapter?: (location: string) => StorageAdapter;
  /** Remote wipe: the keys in the system vault, then the database (and its file). */
  wipe: { secrets(): Promise<void>; data(): Promise<void> };
  /** Data changed outside the screens' edits (friends' cache, my other devices): redraw. */
  onData(): void;
  /** Status, friends or What's new changed. */
  onChange(): void;
  /** My first name, for the public lists file. */
  author?(): string | undefined;
  /** Name the owner gave an invitation (T-208), for "Your pending invitations were cancelled". */
  invitationName?(id: string): string | undefined;
  /** Name I gave a contact (T-208, kept on this device), for their person row when it has none. */
  contactName?(owner: string): string | undefined;
  /**
   * Extra keys per friend, loaded before every pass (T-208: the invitation keys of links I
   * answered, `invitations-received`, until my answer is accepted).
   */
  friendKeys?(): Promise<(owner: string) => KeyPair[]>;
  /** A new engine was built (launch, storage change, move): the contacts screens' port changes too. */
  onEngine?(): void;
  timers?: Timers;
  now?: () => number;
  intervalMs?: number;
  debounceMs?: number;
}

export interface FriendLine {
  owner: string;
  name: string;
  follow: boolean;
  share: SharePolicy;
  verified: boolean;
  lastSuccess: number | null;
  problem: SyncProblem | null;
  /** Their places in my cache. */
  places: number;
}

export interface ControllerSnapshot {
  status: SyncStatus;
  /** A storage of mine where this device publishes (false: local only, or HTTPS-only mode). */
  publishes: boolean;
  /** The engine is built. */
  ready: boolean;
  wiped: boolean;
  friends: FriendLine[];
  unseen: number;
  lastPassAt: number | null;
  /** Last pass where my storage worked (kept across launches; the scheduler's own value is per session). */
  lastOwnSuccess: number | null;
}

export interface AddContactInput {
  /** Their certified read address (index.json right under it). */
  location: string;
  /** Their owner id, when known (the invitation or return link carries it). */
  owner?: string;
  name?: string;
  /** "I see their places". */
  follow: boolean;
  /** "They see my places". */
  share: SharePolicy;
  verified?: boolean;
}

/** The storage at `to` holds an index of someone else: never overwrite it. */
export class ForeignIndexError extends Error {
  constructor() {
    super('the storage already holds the index of another identity');
    this.name = 'ForeignIndexError';
  }
}

export class SyncController implements StorageMoveHooks {
  readonly whatsNew: WhatsNewLog;
  readonly scheduler: SyncScheduler;
  private engine: SyncEngine | null = null;
  private building: Promise<SyncEngine> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private online = true;
  private wiped = false;
  private lastPassAt: number | null = null;
  private readonly friendProblems = new Map<string, SyncProblem | null>();
  private keysFor: (owner: string) => KeyPair[] = () => [];
  private portCache: { engine: SyncEngine; port: SyncPort } | null = null;
  /** The keys each engine was built with (the port signs with this device and states my certificate). */
  private readonly built = new WeakMap<SyncEngine, { sharing: SharingKey; device: DeviceSigner }>();

  constructor(private readonly d: ControllerDeps) {
    this.whatsNew = new WhatsNewLog(d.state);
    this.scheduler = new SyncScheduler({
      run: (reason, opts) => this.pass(reason, opts),
      onStatus: () => d.onChange(),
      ...(d.timers && { timers: d.timers }),
      ...(d.intervalMs !== undefined && { intervalMs: d.intervalMs }),
      ...(d.debounceMs !== undefined && { debounceMs: d.debounceMs }),
    });
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** Runs `fn` alone: passes, rebuilds, moves and contact changes never overlap. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  // ------------------------------------------------------------------ engine

  private readAdapter(location: string): StorageAdapter {
    return this.d.readAdapter ? this.d.readAdapter(location) : new HttpsReadOnlyAdapter({ baseUrl: location });
  }

  /** `storage`: undefined = the current storage of the settings; null = none. */
  private async build(storage?: StorageAdapter | null): Promise<SyncEngine> {
    await ready();
    const k = await this.d.loadKeys();
    const cfg = this.d.access.config();
    const mine = storage !== undefined ? storage : cfg && cfg.kind !== 'https' ? this.d.access.writeAdapter() : null;
    // My storage is used only once its read address is certified (connect / move issue the certificate).
    const write = mine && k.sharing.cert.location ? mine : null;
    const author = this.d.author?.();
    const engine: SyncEngine = new SyncEngine({
      store: this.d.store,
      state: this.d.state,
      sharing: k.sharing,
      previousSharingKeys: k.previousSharingKeys,
      previousVaultKeys: k.previousVaultKeys,
      device: k.device,
      ...(write && { storage: write }),
      readAdapter: (loc) => this.readAdapter(loc),
      online: () => this.online,
      friendKeys: (owner) => this.keysFor(owner),
      ...(author && { author }),
      onSharingKey: (nk) => {
        void this.d
          .saveKeys({ sharing: nk, previousSharingKeys: engine.own?.previousKeys ?? [], previousVaultKeys: engine.own?.previousVaultKeys ?? [] })
          .catch((e: unknown) => console.warn('Could not store the new sharing key', e));
      },
      wipe: { secrets: () => this.d.wipe.secrets(), data: () => this.d.wipe.data() },
    });
    this.built.set(engine, { sharing: k.sharing, device: k.device });
    return engine;
  }

  private setEngine(e: SyncEngine): void {
    const changed = this.engine !== e;
    this.engine = e;
    if (changed) this.d.onEngine?.();
  }

  /** Reloads the per-friend extra keys (a broken source reads with my keys only). */
  private async loadFriendKeys(): Promise<void> {
    if (!this.d.friendKeys) return;
    try {
      this.keysFor = await this.d.friendKeys();
    } catch (e) {
      console.warn('Could not load the invitation keys', e);
    }
  }

  private engineReady(): Promise<SyncEngine> {
    if (this.engine) return Promise.resolve(this.engine);
    this.building ??= this.build().then((e) => {
      this.setEngine(e);
      this.building = null;
      this.d.onChange();
      return e;
    }, (err: unknown) => {
      this.building = null;
      throw err;
    });
    return this.building;
  }

  /** The storage settings or my sharing certificate changed: a new engine for the next pass. */
  rebuild(): Promise<void> {
    return this.exclusive(async () => {
      if (this.wiped) return;
      this.setEngine(await this.build());
      this.d.onChange();
    });
  }

  // ------------------------------------------------------------------ passes

  private pass(_reason: SyncReason, opts: { publish: boolean }): Promise<SyncReport> {
    return this.exclusive(async () => {
      let engine = await this.engineReady();
      if (opts.publish && engine.own && this.d.access.republishPending()) {
        const to = this.d.access.writeAdapter();
        if (to) {
          const k = await this.d.loadKeys();
          engine = await this.republish(k.sharing.cert, to, this.d.access.redirects().map((r) => r.adapter));
          await this.d.access.markRepublished();
        }
      }
      await this.loadFriendKeys();
      // People (and followed lists) with nothing in my cache yet: their first places are one grouped entry.
      const firstRead = this.unread([...engine.book.following().map((c) => c.owner), ...engine.book.followedLists().map((l) => l.id)]);
      const report = await engine.sync({ publish: opts.publish });
      this.afterPass(engine, report, firstRead);
      return report;
    });
  }

  private afterPass(engine: SyncEngine, report: SyncReport, firstRead: ReadonlySet<string>): void {
    this.lastPassAt = this.now();
    if (report.wiped) {
      this.wiped = true;
      this.d.onChange();
      return;
    }
    if (engine.own && !report.problems.some((p) => p.about === 'own')) this.d.state.set(OWN_OK_KEY, report.startedAt);
    for (const f of report.friends) this.friendProblems.set(f.owner, f.problem ?? null);
    this.recordNews([...report.friends, ...(report.lists ?? []).map(asFriendReport)], firstRead);
    this.syncPeople(engine);
    if (report.problems.length) {
      const log = this.d.state.get<string[]>(LOG_KEY) ?? [];
      this.d.state.set(LOG_KEY, [...report.problems.map((p) => logLine(p.about, p.problem, report.startedAt)), ...log].slice(0, LOG_MAX));
    }
    const changed =
      report.friends.some((f) => f.status === 'updated') ||
      (report.lists ?? []).some((l) => l.status === 'updated' || (l.status === 'gone' && l.whatsNew.removed.length > 0)) ||
      (report.own?.pull.imported ?? 0) > 0;
    if (changed) this.d.onData();
    this.d.onChange();
  }

  /** Of these owners, those with nothing in my cache yet. */
  private unread(owners: readonly string[]): Set<string> {
    const db = this.d.store.repo.db;
    return new Set(owners.filter((o) => !db.get(`SELECT 1 AS x FROM saves WHERE owner_id = ? LIMIT 1`, [o])));
  }

  private recordNews(friends: FriendReport[], firstRead: ReadonlySet<string>): void {
    const repo = this.d.store.repo;
    this.whatsNew.record(friends, {
      now: this.now(),
      firstRead,
      placeName: (id) => repo.getPlace(id)?.name,
      theirSave: (owner, placeId) => {
        const s = repo.savesForPlace(placeId).find((x) => x.ownerId === owner);
        return s ? { comment: s.commentVisibility === 'private' ? '' : s.comment, status: s.status } : undefined;
      },
    });
  }

  /**
   * Every contact gets a person row (contacts added on my other devices come through the vault)
   * with the name I gave them on this device when the row has none, so that their places, What's
   * new and the sync status show it rather than "A friend".
   */
  private syncPeople(engine: SyncEngine): void {
    const repo = this.d.store.repo;
    for (const c of engine.contacts()) {
      const p = repo.getPerson(c.owner);
      const name = p?.displayName ? undefined : this.d.contactName?.(c.owner) || undefined;
      if (!p || p.iFollow !== c.policy.follow || name) {
        repo.upsertPerson({ id: c.owner, publicKey: c.owner, readUrl: c.sharingCert.location ?? null, iFollow: c.policy.follow, ...(name && { displayName: name }) });
      }
    }
  }

  /** A name given on the contacts screens (invitation, answer, rename): their person row. */
  nameContact(owner: string, name: string): void {
    if (this.wiped || !name) return;
    this.d.store.repo.upsertPerson({ id: owner, displayName: name, publicKey: owner });
    this.d.onData();
    this.d.onChange();
  }

  /**
   * Publishes my index, signed with `cert`, at `to`, then puts the same index at every redirect
   * storage (the signed redirect friends follow). The packs were copied by the move. An index of
   * mine left at `to` under an older certificate (the copy the move made) is removed first: it
   * certifies the old address, which my own pull would refuse to read there.
   */
  private async republish(cert: SharingCert, to: StorageAdapter, redirects: readonly StorageAdapter[]): Promise<SyncEngine> {
    await ready();
    await clearStaleIndex(to, cert);
    const engine = await this.build(to);
    if (!engine.own) throw new Error('sync: no storage to publish to');
    const report = await engine.sync({ readFriends: false });
    const own = report.problems.find((p) => p.about === 'own');
    if (report.wiped) {
      this.wiped = true;
      throw new Error('this device was declared lost');
    }
    if (own) throw new Error(`sync: publishing at the new storage failed (${own.problem.kind})`);
    const g = await to.get(INDEX, { maxBytes: INDEX_MAX });
    if (!g) throw new Error('sync: the new index is missing');
    for (const r of redirects) await r.put(INDEX, g.data, { contentType: 'application/json' });
    this.setEngine(engine);
    return engine;
  }

  // ------------------------------------------------------------------ StorageMoveHooks

  publishAfterMove(args: { cert: SharingCert; to: StorageAdapter; redirects: StorageAdapter[] }): Promise<void> {
    return this.exclusive(async () => {
      await this.republish(args.cert, args.to, args.redirects);
      this.d.onChange();
    });
  }

  async openInvitations(previous: SharingCert): Promise<OpenInvitationSummary[]> {
    const engine = await this.engineReady();
    const now = this.now();
    return engine.book
      .invitations()
      .filter((i) => i.accepted === undefined && i.invitation.rotation === previous.rotation && Date.parse(i.invitation.expires) > now)
      .map((i) => ({ name: this.d.invitationName?.(i.invitation.id) ?? '', createdAt: Date.parse(i.invitation.created) }));
  }

  // ------------------------------------------------------------------ lifecycle

  foreground(reason: 'launch' | 'foreground' = 'foreground'): Promise<void> {
    return this.scheduler.appForeground(reason);
  }

  background(): Promise<void> {
    return this.scheduler.appBackground();
  }

  localChange(): void {
    this.scheduler.localChange();
  }

  refresh(): Promise<void> {
    return this.scheduler.pullToRefresh();
  }

  resume(): Promise<void> {
    return this.scheduler.resume();
  }

  setOnline(online: boolean): void {
    this.online = online;
    this.scheduler.setOnline(online);
  }

  stop(): void {
    this.scheduler.stop();
  }

  // ------------------------------------------------------------------ contacts

  /**
   * Adds someone from their verified index, read at their certified address. The app's screens go
   * through the invitation and return link flows instead (ContactsService on `port()`, which
   * checks the link against the index); this direct path is kept for the unit tests and tools.
   * Returns their owner id.
   */
  addContact(input: AddContactInput): Promise<string> {
    return this.exclusive(async () => {
      await ready();
      const engine = await this.engineReady();
      const g = await this.readAdapter(input.location).get(INDEX, { maxBytes: INDEX_MAX });
      if (!g) throw new Error('sync: nothing published at this address');
      const index: SignedIndex = verifyIndex(g.data, { location: input.location, ...(input.owner && { expectedOwner: input.owner }) });
      if (index.owner === engine.owner) throw new Error('sync: this is my own address');
      engine.addContact(index, { follow: input.follow, share: input.share, ...(input.verified !== undefined && { verified: input.verified }) });
      const repo = this.d.store.repo;
      const cur = repo.getPerson(index.owner);
      repo.upsertPerson({
        id: index.owner,
        displayName: input.name ?? cur?.displayName ?? '',
        publicKey: index.owner,
        readUrl: input.location,
        iFollow: input.follow,
      });
      this.d.onData();
      this.d.onChange();
      return index.owner;
    }).then((owner) => {
      // Publish (wraps for them) and read them now.
      void this.refresh();
      return owner;
    });
  }

  /** "I see their places" / "they see my places" (spec "Asymmetric relationships"). */
  setPolicy(owner: string, patch: { share?: SharePolicy; follow?: boolean }): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      engine.setPolicy(owner, patch);
      if (patch.follow !== undefined) this.d.store.repo.upsertPerson({ id: owner, iFollow: patch.follow });
      if (patch.follow === false) {
        this.whatsNew.forget(owner);
        this.friendProblems.delete(owner);
      }
      this.d.onData();
      this.d.onChange();
    }).then(() => this.localChange());
  }

  removeContact(owner: string): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      engine.removeContact(owner);
      this.whatsNew.forget(owner);
      this.friendProblems.delete(owner);
      this.d.store.repo.upsertPerson({ id: owner, iFollow: false });
      this.d.onData();
      this.d.onChange();
    }).then(() => this.localChange());
  }

  /** My owner id. */
  owner(): string | null {
    return this.engine?.owner ?? null;
  }

  // ------------------------------------------------------------------ lists (T-211, T-212)

  /** My certified read address (null before a storage is connected and certified). */
  readAddress(): string | null {
    const e = this.engine;
    if (!e) return null;
    return e.own?.sharing.cert.location ?? this.built.get(e)?.sharing.cert.location ?? null;
  }

  /** The fragment of a link-only list's link (null: no link yet, or no storage). */
  listLink(listId: string): string | null {
    const owner = this.owner();
    const location = this.readAddress();
    const secret = listSecretOf(this.d.store.repo.getList(listId)?.linkKey);
    if (!owner || !location || !secret) return null;
    return listLinkFragment({ kind: 'link', owner, location, secret });
  }

  /** The fragment of a public list's link (followed in the app), and its file for uMap. */
  publicList(listId: string): { fragment: string; file: string } | null {
    const owner = this.owner();
    const location = this.readAddress();
    if (!owner || !location) return null;
    return { fragment: listLinkFragment({ kind: 'public', owner, location, listId }), file: publicListsUrl(location) };
  }

  /** Publishes now (vault, packs, index), without reading friends; throws when my storage failed. */
  publishNow(): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      if (!engine.own) throw new Error('sync: no storage to publish to');
      await this.loadFriendKeys();
      const report = await engine.sync({ readFriends: false });
      this.afterPass(engine, report, new Set());
      const own = report.problems.find((p) => p.about === 'own');
      if (own) throw new Error(`sync: publishing failed (${own.problem.kind})`);
    });
  }

  /**
   * Makes (or renews: "New link") a link-only list's link, then publishes so the link works the
   * moment it is handed out. A new key cuts the previous link (its pack is re-sealed and deleted).
   */
  async newListLink(listId: string): Promise<string> {
    const list = this.d.store.repo.getList(listId);
    if (!list) throw new Error('lists: no such list');
    this.d.store.updateList(listId, { linkKey: newListKey(), ...(list.visibility !== 'link' && { visibility: 'link' as const }) });
    this.d.onData();
    try {
      await this.publishNow();
    } catch (e) {
      // Not published (offline, storage down): never show a link that does not work yet (review
      // Info 7). Back to what is published; the user tries again.
      this.d.store.updateList(listId, { linkKey: list.linkKey, ...(list.visibility !== 'link' && { visibility: list.visibility }) });
      this.d.onData();
      throw e;
    }
    const f = this.listLink(listId);
    if (!f) throw new Error('lists: no link');
    return f;
  }

  /** Stops sharing a list by link (holders get "This link no longer works"). */
  async removeListLink(listId: string): Promise<void> {
    this.d.store.updateList(listId, { linkKey: null });
    this.d.onData();
    await this.publishNow();
  }

  /**
   * Public or link-only; publishes (the public file appears or goes). Leaving link-only drops the
   * list key (data package), so coming back needs "Create the link": the old link stays dead.
   */
  async setListVisibility(listId: string, visibility: 'link' | 'public'): Promise<void> {
    this.d.store.updateList(listId, { visibility });
    this.d.onData();
    await this.publishNow();
  }

  /**
   * Places that a public filter list of mine keeps out of the public file because they look like a
   * home, until I decide (sync package `heldPublicPlaces`, review M-02).
   */
  heldPublic(listId: string): { id: string; name: string }[] {
    const repo = this.d.store.repo;
    return safe(() => (heldPublicPlaces(repo, readOwnItems(repo)).get(listId) ?? []).map((i) => ({ id: i.placeId, name: i.name })), []);
  }

  /**
   * Decides about places a public filter list holds back: publish them (an explicit "include" of
   * the filter) or leave them out ("exclude"); then publishes.
   */
  async decideHeld(listId: string, placeIds: readonly string[], publish: boolean): Promise<void> {
    const list = this.d.store.repo.getList(listId);
    if (!list || placeIds.length === 0) return;
    this.d.store.setListFilter(listId, confirmInFilter(list.filter, placeIds, publish));
    this.d.onData();
    await this.publishNow();
  }

  /** Whether my link-only lists and public file carry my tag names (opt-in, kept in my vault). */
  publicTagNames(): boolean {
    return this.engine && !this.wiped ? this.engine.book.publicTagNames() : false;
  }

  /** Opt in or out of publishing my tag names in forwardable lists, then publishes (best effort). */
  setPublicTagNames(on: boolean): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      engine.setPublicTagNames(on);
      this.d.onChange();
    }).then(() => this.publishNow().catch(() => this.localChange()));
  }

  /** Owners of my contacts who see this list (its name, description and places). */
  listViewers(listId: string): string[] {
    return this.engine && !this.wiped ? this.engine.book.listViewers(listId) : [];
  }

  /** "Pick who": gives or takes a contact's access to one list, then publishes (best effort). */
  setListAccess(listId: string, owner: string, on: boolean): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      engine.setListAccess(owner, listId, on);
      this.d.onChange();
    }).then(() => this.publishNow().catch(() => this.localChange()));
  }

  /** Reads a list from its link, without following it (throws ListGoneError when it is gone). */
  async previewList(fragment: string): Promise<ListPreview> {
    await ready();
    const engine = await this.engineReady();
    return engine.previewList(fragment);
  }

  /** Follows a list by link: kept in my vault (all my devices), read now; its places show like friends'. */
  followList(fragment: string): Promise<ListReport> {
    return this.exclusive(async () => {
      await ready();
      const engine = await this.engineReady();
      const r = await engine.followList(fragment);
      this.recordNews([asFriendReport(r)], new Set([r.id]));
      this.d.onData();
      this.d.onChange();
      return r;
    }).then((r) => {
      this.localChange(); // the vault (followed lists) goes to my storage
      return r;
    });
  }

  unfollowList(id: string): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      engine.unfollowList(id);
      this.whatsNew.forget(id);
      this.d.onData();
      this.d.onChange();
    }).then(() => this.localChange());
  }

  followedLists(): FollowedListInfo[] {
    if (!this.engine || this.wiped) return [];
    return safe(() => this.engine!.followedLists(), []);
  }

  /** Lists my friends shared with me, per friend (as of their last read). */
  friendLists(): { owner: string; lists: ListDef[] }[] {
    const e = this.engine;
    if (!e || this.wiped) return [];
    return e.book
      .following()
      .map((c) => ({ owner: c.owner, lists: safe(() => e.reader.friendLists(c.owner), []) }))
      .filter((x) => x.lists.length > 0);
  }

  // ------------------------------------------------------------------ port for the contacts screens

  /**
   * The contacts service's `SyncPort` over the current engine (null until it is built, and after
   * a wipe). A new engine (storage change, move) gives a new port (`onEngine`). Its publications
   * and friend reads run inside the controller's lock, and every change redraws the screens.
   */
  port(): SyncPort | null {
    const engine = this.engine;
    if (!engine || this.wiped) return null;
    if (this.portCache?.engine === engine) return this.portCache.port;
    const keys = this.built.get(engine);
    if (!keys) return null;
    const base = engineSyncPort({
      engine,
      state: this.d.state,
      // A rotation adopted by the engine (made on another device) shows in `own.sharing`.
      sharing: () => engine.own?.sharing.cert ?? keys.sharing.cert,
      device: () => engine.own?.device ?? keys.device,
      readAdapter: (loc) => this.readAdapter(loc),
    });
    const changed = (data: boolean) => {
      this.syncPeople(engine);
      if (data) this.d.onData();
      this.d.onChange();
    };
    const port: SyncPort = {
      owner: engine.owner,
      sharingCert: base.sharingCert,
      device: base.device,
      canPublish: base.canPublish,
      addContact: (index, policy) => {
        base.addContact(index, policy);
        changed(false);
      },
      setPolicy: (owner, patch) => {
        base.setPolicy(owner, patch);
        if (patch.follow === false) {
          this.whatsNew.forget(owner);
          this.friendProblems.delete(owner);
        }
        changed(true);
      },
      removeContact: (owner) => {
        base.removeContact(owner);
        this.whatsNew.forget(owner);
        this.friendProblems.delete(owner);
        this.d.store.repo.upsertPerson({ id: owner, iFollow: false });
        changed(true);
      },
      addInvitation: base.addInvitation,
      contacts: base.contacts,
      records: base.records,
      updateRecords: base.updateRecords,
      publish: () =>
        this.exclusive(async () => {
          if (this.engine !== engine) throw new Error('sync: the engine changed, try again');
          await this.loadFriendKeys();
          await base.publish();
          if (engine.own) this.d.state.set(OWN_OK_KEY, this.now());
          changed(false);
        }),
      fetchIndex: base.fetchIndex,
      readFriend: (target) =>
        this.exclusive(async () => {
          const firstRead = this.unread([target.owner]);
          const r = await base.readFriend(target);
          this.friendProblems.set(target.owner, r.problem ?? null);
          // Read right after answering an invitation: their first places are in What's new too.
          if (engine.book.contact(target.owner)?.policy.follow) this.recordNews([r], firstRead);
          changed(true);
          return r;
        }),
      lastSuccess: base.lastSuccess,
    };
    this.portCache = { engine, port };
    return port;
  }


  // ------------------------------------------------------------------ state for the screens

  log(): string[] {
    return this.d.state.get<string[]>(LOG_KEY) ?? [];
  }

  snapshot(): ControllerSnapshot {
    const e = this.engine;
    const repo = this.d.store.repo;
    let friends: FriendLine[] = [];
    if (e && !this.wiped) {
      try {
        friends = e.contacts().map((c) => ({
          owner: c.owner,
          name: repo.getPerson(c.owner)?.displayName ?? '',
          follow: c.policy.follow,
          share: c.policy.share,
          verified: c.verified,
          lastSuccess: e.reader.lastSuccess(c.owner),
          problem: this.friendProblems.get(c.owner) ?? null,
          places: repo.db.get<{ n: number }>(`SELECT count(*) AS n FROM saves WHERE owner_id = ? AND deleted_at IS NULL`, [c.owner])?.n ?? 0,
        }));
      } catch {
        friends = [];
      }
    }
    return {
      status: this.scheduler.getStatus(),
      publishes: !!e?.own,
      ready: !!e,
      wiped: this.wiped || this.scheduler.getStatus().state === 'wiped',
      friends,
      unseen: this.wiped ? 0 : safe(() => this.whatsNew.unseen(), 0),
      lastPassAt: this.lastPassAt,
      lastOwnSuccess: this.wiped ? null : safe(() => this.d.state.get<number>(OWN_OK_KEY) ?? null, null),
    };
  }
}

/** A followed list's report, in the shape What's new records (its places' owner is the list's id). */
function asFriendReport(l: ListReport): FriendReport {
  return { owner: l.id, status: l.status === 'gone' ? 'updated' : l.status, whatsNew: l.whatsNew, downloaded: { packs: 0, bytes: 0 }, ...(l.problem && { problem: l.problem }) };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Before publishing at `to` under `cert`: an index of mine certifying another address (the copy a
 * move made) is deleted; one of someone else stops everything.
 */
export async function clearStaleIndex(to: StorageAdapter, cert: SharingCert): Promise<void> {
  const g = await to.get(INDEX, { maxBytes: INDEX_MAX });
  if (!g) return;
  let idx: SignedIndex;
  try {
    idx = verifyIndex(g.data, { expectedOwner: cert.owner });
  } catch {
    throw new ForeignIndexError();
  }
  if (idx.sharing_cert.location !== cert.location || idx.sharing_cert.rotation < cert.rotation) await to.delete(INDEX);
}
