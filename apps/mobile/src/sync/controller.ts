/**
 * The app's sync glue (T-210), without React: builds the `SyncEngine` from my identity's keys, the
 * storage settings (`StorageAccess`) and the local data store; runs it from a `SyncScheduler`
 * (launch, foreground, edits, pull to refresh, a last pass when the app goes to the background,
 * nothing after that); implements the storage screens' `StorageMoveHooks` (publish at the new
 * storage and leave the signed redirect at the old ones) and `republishPending`; records What's
 * new; and carries the remote wipe to the app's hooks (secrets, then the database).
 *
 * `SyncProvider.tsx` is the React side (AppState, network status, screens). Unit-tested with
 * in-memory storages (`sync.test.ts`).
 */
import { ready, verifyIndex, type SharingCert, type SharingKey, type SignedIndex } from '@triangulair/crypto';
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
  type Timers,
} from '@triangulair/sync';

import type { OpenInvitationSummary, StorageAccess, StorageMoveHooks } from '../storage/interfaces';
import type { SyncKeys } from './keys';
import { logLine } from './problems';
import { WhatsNewLog } from './whatsNew';

const INDEX = 'index.json';
const INDEX_MAX = 4 * 1024 * 1024;
const LOG_KEY = 'app:log';
const LOG_MAX = 80;

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
      ...(author && { author }),
      onSharingKey: (nk) => {
        void this.d
          .saveKeys({ sharing: nk, previousSharingKeys: engine.own?.previousKeys ?? [], previousVaultKeys: engine.own?.previousVaultKeys ?? [] })
          .catch((e: unknown) => console.warn('Could not store the new sharing key', e));
      },
      wipe: { secrets: () => this.d.wipe.secrets(), data: () => this.d.wipe.data() },
    });
    return engine;
  }

  private engineReady(): Promise<SyncEngine> {
    if (this.engine) return Promise.resolve(this.engine);
    this.building ??= this.build().then((e) => {
      this.engine = e;
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
      this.engine = await this.build();
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
      // People with nothing in my cache yet: their first places are one grouped entry.
      const repo = this.d.store.repo;
      const firstRead = new Set(
        engine.book.following().map((c) => c.owner).filter((o) => !repo.db.get(`SELECT 1 AS x FROM saves WHERE owner_id = ? LIMIT 1`, [o])),
      );
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
    const repo = this.d.store.repo;
    for (const f of report.friends) this.friendProblems.set(f.owner, f.problem ?? null);
    this.whatsNew.record(report.friends, {
      now: this.now(),
      firstRead,
      placeName: (id) => repo.getPlace(id)?.name,
      theirSave: (owner, placeId) => {
        const s = repo.savesForPlace(placeId).find((x) => x.ownerId === owner);
        return s ? { comment: s.commentVisibility === 'private' ? '' : s.comment, status: s.status } : undefined;
      },
    });
    // Contacts added on my other devices (through the vault) get a person row.
    for (const c of engine.contacts()) {
      const p = repo.getPerson(c.owner);
      if (!p || p.iFollow !== c.policy.follow) repo.upsertPerson({ id: c.owner, publicKey: c.owner, readUrl: c.sharingCert.location ?? null, iFollow: c.policy.follow });
    }
    if (report.problems.length) {
      const log = this.d.state.get<string[]>(LOG_KEY) ?? [];
      this.d.state.set(LOG_KEY, [...report.problems.map((p) => logLine(p.about, p.problem, report.startedAt)), ...log].slice(0, LOG_MAX));
    }
    const changed = report.friends.some((f) => f.status === 'updated') || (report.own?.pull.imported ?? 0) > 0;
    if (changed) this.d.onData();
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
    this.engine = engine;
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
   * Adds someone from their verified index, read at their certified address (what the invitation
   * and return link flows do once accepted, T-208/T-209; the e2e test hook calls it directly).
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

  /** My owner id (test hook, contact screens). */
  owner(): string | null {
    return this.engine?.owner ?? null;
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
    };
  }
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
