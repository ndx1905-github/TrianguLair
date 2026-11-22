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
import {
  canonicalize,
  cancelAllInvitations,
  emptyVault,
  fromB64Url,
  openVault,
  packHash,
  ready,
  verifyIndex,
  type DeviceCert,
  type DeviceSigner,
  type KeyPair,
  type SharingCert,
  type SharingKey,
  type SignedIndex,
  type VaultRecords,
} from '@triangulair/crypto';
import type { DataStore } from '@triangulair/data';
import { HttpsReadOnlyAdapter, type StorageAdapter } from '@triangulair/storage';
import {
  ContactBook,
  DEVICES_KEY,
  SyncEngine,
  SyncScheduler,
  VAULT_PATH,
  keyPath,
  type DeviceEntry,
  type SharePolicy,
  type SpaceUsed,
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
  SqliteMediaCache,
  type MediaCache,
  type Photos,
} from '@triangulair/sync';
import { MB, cacheCapMb } from '../photos/model';

import { engineSyncPort, type SyncPort } from '../contacts/port';
import { slotFiles } from '../devices/channel';
import { JOURNAL_KEY, addEntry, diffSaves, markReverted, ownSaves, revertChange, type JournalEntry, type SaveMap } from '../devices/journal';
import { MAX_CONTACT_NAME, VALUE_CONTACT_NAMES, VALUE_PROFILE, VALUE_STORAGE } from '../devices/sessions';
import { parseConfig, sameWriteTarget, type StorageConfig } from '../storage/config';
import type { OpenInvitationSummary, StorageAccess, StorageMoveHooks } from '../storage/interfaces';
import type { SyncKeys } from './keys';
import { confirmInFilter } from '../lists/sharing';
import { invitationsLogLine, logLine } from './problems';
import { WhatsNewLog } from './whatsNew';
import { BLOCKED_STATE, BLOCKED_VALUE, REPORTED_STATE, parseBlocked, parseReported, withBlocked, withoutBlocked, type BlockedPerson, type ReportedList } from '../privacy/blocked';
import { deleteAllContent, type DeleteAllSummary, type DeleteStep } from '../privacy/deleteAll';

const INDEX = 'index.json';
const INDEX_MAX = 4 * 1024 * 1024;
const LOG_KEY = 'app:log';
const LOG_MAX = 80;
const OWN_OK_KEY = 'app:own-ok';
/** When I chose to keep the places of a friend whose storage no longer answers (spec "Error cases"). */
const keptKey = (owner: string) => `app:friend-kept:${owner}`;
const SLOTS_KEY = 'app:transfer-slots';
const WRITTEN_KEY = 'app:vault-written';
const RECOVERY_KEY = 'app:recovery-copy';
const SELF_KEY = 'app:device-listed';
/** The sync package's own key for my vault records (SyncEngine BOOK_KEY), reset by an identity change. */
const BOOK_KEY = 'vault:records';

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
  /** A contact name found in my vault value, for a contact this device has no name for (contacts service). */
  adoptContactName?(owner: string, name: string): void;
  /**
   * Extra keys per friend, loaded before every pass (T-208: the invitation keys of links I
   * answered, `invitations-received`, until my answer is accepted).
   */
  friendKeys?(): Promise<(owner: string) => KeyPair[]>;
  /** A new engine was built (launch, storage change, move): the contacts screens' port changes too. */
  onEngine?(): void;
  /** This device as listed in Settings › Devices (T-206): its name, when it was added, whether it keeps the master key. */
  device?(): { name: string; added: number; primary: boolean };
  /**
   * My current sharing key `sharing` sealed with the phrase-derived key (b64url TLSK mode 2), kept at
   * keys/<owner>.bin for a restore; null when this device cannot make one without the 12 words
   * (`identity/recovery.ts`: never a copy of an older key).
   */
  recoveryCopy?(sharing: SharingKey): Promise<string | null>;
  /**
   * The vault holds newer settings for my current storage (same read address: the credentials were
   * changed on another device after a declaration of loss). The app stores them and rebuilds.
   */
  onStorageValue?(config: unknown): Promise<void>;
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
  /** When I chose to keep their places although their storage no longer answers (null: never). */
  keptAt: number | null;
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
  /**
   * "Restore with the 12 words" would not find my current key: no phrase copy on this device, and
   * only the 12 words can make one (devices review F-05; Settings › Devices asks for them).
   */
  recoveryCopyMissing: boolean;
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

/** The contact names of the vault value (`VALUE_CONTACT_NAMES`), read defensively: strings only, bounded. */
export function vaultContactNames(engine: Pick<SyncEngine, 'value'>): Record<string, string> {
  const v = engine.value<unknown>(VALUE_CONTACT_NAMES)?.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [owner, name] of Object.entries(v as Record<string, unknown>)) {
    if (typeof name === 'string' && name.trim() && owner.startsWith('ed25519:')) out[owner] = name.trim().slice(0, MAX_CONTACT_NAME);
  }
  return out;
}

export class SyncController implements StorageMoveHooks {
  readonly whatsNew: WhatsNewLog;
  readonly scheduler: SyncScheduler;
  private engine: SyncEngine | null = null;
  private building: Promise<SyncEngine> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private online = true;
  private wiped = false;
  /** An identity change is under way: this controller (old identity) no longer runs. */
  private moving = false;
  private lastPassAt: number | null = null;
  /** No phrase copy of my current key could be written (only the 12 words can make it). */
  private copyMissing = false;
  /** This identity came from a move (F-08): the old identity's index is replaced before publishing. */
  private movedFrom: string | null = null;
  private readonly friendProblems = new Map<string, SyncProblem | null>();
  private keysFor: (owner: string) => KeyPair[] = () => [];
  private portCache: { engine: SyncEngine; port: SyncPort } | null = null;
  /** The keys each engine was built with (the port signs with this device and states my certificate). */
  private readonly built = new WeakMap<SyncEngine, { sharing: SharingKey; device: DeviceSigner }>();

  /** Local copies of photos (my photos and the friends' cache), in the same database (T-111b). */
  readonly media: MediaCache;

  constructor(private readonly d: ControllerDeps) {
    this.whatsNew = new WhatsNewLog(d.state);
    this.media = new SqliteMediaCache(d.store.repo.db);
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
    if (k.move) this.migrateMovedBook(k.sharing.cert.owner, k.move);
    this.movedFrom = k.move?.from ?? null;
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
      media: this.media,
      friendsCacheBytes: cacheCapMb() * MB,
      ...(author && { author }),
      ...(k.move && { move: k.move }),
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
      if (this.moving) throw new Error('sync: the identity is changing');
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
      if (opts.publish && engine.own && this.movedFrom) await this.clearMovedIndex(engine, this.movedFrom);
      if (opts.publish && engine.own) await this.beforePublish(engine);
      // People (and followed lists) with nothing in my cache yet: their first places are one grouped entry.
      const firstRead = this.unread([...engine.book.following().map((c) => c.owner), ...engine.book.followedLists().map((l) => l.id)]);
      const before = this.journalBase(engine);
      const report = await engine.sync({ publish: opts.publish });
      this.recordJournal(before, report);
      this.afterPass(engine, report, firstRead);
      await this.afterOwn(engine, report);
      return report;
    });
  }

  // ------------------------------------------------------------------ my devices (T-206, T-207)

  /**
   * Before a publication: list this device in the vault (Settings › Devices on every device), keep
   * the storage settings and my first name there for a new device, the phrase-protected copy of my
   * sharing key at keys/<owner>.bin, and delete the files of transfers that expired.
   */
  private async beforePublish(engine: SyncEngine): Promise<void> {
    const own = engine.own!;
    const me = this.d.device?.();
    if (me) {
      // This device's own display entry (signed by it; devices.ts): written once, and when its primary mark changes.
      const cur = engine.devices().find((d) => d.cert.device === own.device.keys.id);
      const written = this.d.state.get<boolean>(SELF_KEY) === true;
      if (!cur || !written) {
        engine.putDevice(own.device.cert, { name: cur?.name || me.name, added: me.added, primary: me.primary });
        this.d.state.set(SELF_KEY, true);
      } else if (!!cur.primary !== me.primary && cur.removed === undefined) engine.updateDevice(cur.cert.device, { primary: me.primary });
    }
    const written = this.d.state.get<Record<string, string>>(WRITTEN_KEY) ?? {};
    const put = (key: string, value: unknown) => {
      const c = canonicalize(value as never);
      if (written[key] === c) return; // unchanged here since I wrote it: a newer value in the vault wins
      engine.setValue(key, value);
      written[key] = c;
    };
    const cfg = this.d.access.config();
    if (cfg) put(VALUE_STORAGE, cfg);
    const name = this.d.author?.();
    if (name) put(VALUE_PROFILE, { name });
    const names = this.contactNames(engine);
    if (Object.keys(names).length) put(VALUE_CONTACT_NAMES, names);
    this.d.state.set(WRITTEN_KEY, written);
    try {
      const rc = this.d.recoveryCopy ? await this.d.recoveryCopy(own.sharing) : undefined;
      this.copyMissing = rc === null;
      if (rc) {
        const bytes = fromB64Url(rc, 'recovery copy');
        const h = packHash(bytes);
        if (this.d.state.get<string>(RECOVERY_KEY) !== h) {
          await own.storage.put(keyPath(engine.owner), bytes, { contentType: 'application/octet-stream' });
          this.d.state.set(RECOVERY_KEY, h);
        }
      }
    } catch (e) {
      console.warn('Could not keep the recovery copy of the sharing key', e);
    }
    const slots = this.d.state.get<{ slot: string; expiresAt: number }[]>(SLOTS_KEY) ?? [];
    const now = this.now();
    const left: typeof slots = [];
    for (const s of slots) {
      if (s.expiresAt > now) {
        left.push(s);
        continue;
      }
      for (const p of Object.values(slotFiles(s.slot))) await own.storage.delete(p).catch(() => {});
    }
    if (left.length !== slots.length) this.d.state.set(SLOTS_KEY, left);
  }

  /**
   * After a pass: newer storage settings in the vault (changed on another device) are taken here.
   * When my storage refuses my credentials, the vault is read at the read address (anonymous), so
   * a device whose password was changed elsewhere picks the new one up by itself.
   *
   * Devices review F-01: only a value signed by my master key or by a certified device that my
   * current certificate does not revoke counts (`engine.value`, devices.ts), and only **new
   * credentials for the same storage** are taken (`sameWriteTarget`: same kind, read address and
   * write endpoint). A value naming another write endpoint is never adopted automatically: a
   * storage move goes through the move screens and a new certificate.
   */
  private async afterOwn(engine: SyncEngine, report: SyncReport): Promise<void> {
    const own = engine.own;
    const cfg = this.d.access.config();
    if (!own || !cfg || !this.d.onStorageValue || report.wiped) return;
    let value: unknown;
    const auth = report.problems.some((p) => p.about === 'own' && p.problem.kind === 'auth');
    if (auth) {
      try {
        const g = await this.d.access.readAdapter()?.get(VAULT_PATH, { maxBytes: 16 * 1024 * 1024 });
        if (!g) return;
        const trust = { revoked: own.sharing.cert.revoked_devices, now: this.now() };
        value = new ContactBook(openVault(g.data, engine.owner, own.sharing.vaultDataKey)).value(VALUE_STORAGE, trust)?.value;
      } catch {
        return;
      }
    } else value = engine.value(VALUE_STORAGE)?.value;
    if (!value || typeof value !== 'object') return;
    let next: StorageConfig;
    try {
      next = parseConfig(value);
    } catch {
      return;
    }
    if (!sameWriteTarget(next, cfg) || canonicalize(next as never) === canonicalize(cfg as never)) return;
    const written = this.d.state.get<Record<string, string>>(WRITTEN_KEY) ?? {};
    if (!auth && written[VALUE_STORAGE] !== canonicalize(cfg as never)) return; // my own change, not written yet
    try {
      await this.d.onStorageValue(next);
      this.d.state.set(WRITTEN_KEY, { ...written, [VALUE_STORAGE]: canonicalize(next as never) });
    } catch (e) {
      console.warn('Could not take the storage settings from the vault', e);
    }
  }

  /**
   * My saves before the pass, when another device of mine can change them (for the changes since a
   * theft): whenever a device other than this one holds a master-signed certificate in the vault
   * (devices review F-02: certificates cannot be hidden by a stolen device).
   */
  private journalBase(engine: SyncEngine): SaveMap | null {
    if (!engine.own) return null;
    try {
      const me = engine.own.device.keys.id;
      return engine.devices().some((d) => d.cert.device !== me) ? ownSaves(this.d.store) : null;
    } catch {
      return null;
    }
  }

  private recordJournal(before: SaveMap | null, report: SyncReport): void {
    if (!before || report.wiped) return;
    const imported = (report.pulled?.imported ?? 0) + (report.own?.pull.imported ?? 0);
    if (!imported) return;
    try {
      const changes = diffSaves(before, ownSaves(this.d.store));
      if (!changes.length) return;
      const device = report.pulled?.importedFrom ?? report.own?.pull.importedFrom ?? null;
      this.d.state.set(JOURNAL_KEY, addEntry(this.journal(), { at: this.now(), device, changes }, this.now()));
    } catch (e) {
      console.warn('Could not record the changes from my other devices', e);
    }
  }

  /** What my other devices changed in my places (newest first), for "changes since the theft". */
  journal(): JournalEntry[] {
    const v = this.d.state.get<JournalEntry[]>(JOURNAL_KEY);
    return Array.isArray(v) ? v : [];
  }

  /** Puts one change back from the local copy (a new edit, published like any other). */
  revert(entryAt: number, placeId: string): void {
    const e = this.journal().find((x) => x.at === entryAt);
    const c = e?.changes.find((x) => x.placeId === placeId);
    if (!c) throw new Error('unknown change');
    revertChange(this.d.store, c);
    this.d.state.set(JOURNAL_KEY, markReverted(this.journal(), entryAt, placeId));
    this.d.onData();
    this.d.onChange();
    this.localChange();
  }

  /** My devices listed in the vault (empty until the engine is built or without a storage). */
  devices(): DeviceEntry[] {
    if (!this.engine || this.wiped) return [];
    try {
      return this.engine.devices();
    } catch {
      return [];
    }
  }

  /** A transfer slot to clean up at expiry, even if its screen was closed. */
  trackSlot(slot: string, expiresAt: number): void {
    const slots = this.d.state.get<{ slot: string; expiresAt: number }[]>(SLOTS_KEY) ?? [];
    this.d.state.set(SLOTS_KEY, [...slots.filter((s) => s.slot !== slot), { slot, expiresAt }]);
  }

  /** A new device of mine, certified by the master key: listed in the vault, which is published now. */
  addDevice(cert: DeviceCert, name: string): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      if (!engine.own) throw new Error('sync: no storage to publish to');
      engine.putDevice(cert, { name, added: this.now() });
      const report = await engine.sync({ readFriends: false });
      this.afterPass(engine, report, new Set());
      const own = report.problems.find((p) => p.about === 'own');
      if (own) throw new Error(`sync: ${own.problem.kind}`);
    });
  }

  renameDevice(id: string, name: string): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      engine.updateDevice(id, { name });
      this.d.onChange();
    }).then(() => this.localChange());
  }

  /**
   * "Declare a device lost" / remove a device (T-207), after the master key issued the new
   * certificate (new sharing key and vault data key, the device revoked): every open invitation is
   * cancelled (declaration of loss), the key goes to my remaining devices, everything is
   * re-encrypted and the index published with the new certificate (the lost device reads its
   * revocation there and erases itself). Returns the people invited who had not answered.
   *
   * A declaration of loss (`cancelInvitations`) also draws a new key for every link-only list of
   * mine (devices review, "Declaration completeness"): the lost device holds their keys (my Yjs
   * document), so it could keep reading them through the old links. The publication that follows
   * seals them to the new keys and deletes the old files (the old links say "This link no longer
   * works"); the lists are returned so the screen asks to share the new links again. "Remove a
   * device" (a device erased and given away) keeps the links.
   */
  declareLost(
    r: { sharing: SharingKey; vaultCopy: Uint8Array; previous: SharingCert },
    opts: { cancelInvitations: boolean },
  ): Promise<{ cancelled: OpenInvitationSummary[]; delivered: string[]; renewedLinks: { id: string; name: string }[] }> {
    return this.exclusive(async () => {
      await ready();
      const engine = await this.engineReady();
      if (!engine.own) throw new Error('sync: no storage to publish to');
      const open = this.openNow(engine, r.previous);
      const renewedLinks = opts.cancelInvitations ? this.renewListLinks() : [];
      // The app values are reset to this device's (devices review F-01): what a lost device planted goes.
      const values: Record<string, unknown> = {};
      const cfg = this.d.access.config();
      if (cfg) values[VALUE_STORAGE] = cfg;
      const name = this.d.author?.();
      if (name) values[VALUE_PROFILE] = { name };
      const names = this.contactNames(engine);
      if (Object.keys(names).length) values[VALUE_CONTACT_NAMES] = names;
      const res = await engine.rotateKey(r.sharing, { cancelInvitations: opts.cancelInvitations, recoveryCopy: r.vaultCopy, values });
      this.d.state.set(WRITTEN_KEY, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, canonicalize(v as never)])));
      this.d.state.set(RECOVERY_KEY, packHash(r.vaultCopy));
      const report = await engine.sync({ readFriends: false });
      this.afterPass(engine, report, new Set());
      const own = report.problems.find((p) => p.about === 'own');
      if (own) throw new Error(`sync: ${own.problem.kind}`);
      return { cancelled: open, delivered: res.delivered, renewedLinks };
    });
  }

  /** New keys for my link-only lists (a declaration of loss): the old links stop working at the next publication. */
  private renewListLinks(): { id: string; name: string }[] {
    const lists = this.d.store.repo.lists().filter((l) => l.visibility === 'link' && l.linkKey && l.deletedAt === null);
    for (const l of lists) this.d.store.updateList(l.id, { linkKey: newListKey() });
    if (lists.length) this.d.onData();
    return lists.map((l) => ({ id: l.id, name: l.name }));
  }

  private openNow(engine: SyncEngine, previous: SharingCert): OpenInvitationSummary[] {
    const now = this.now();
    return engine.book
      .invitations()
      .filter((i) => i.accepted === undefined && i.invitation.rotation === previous.rotation && Date.parse(i.invitation.expires) > now)
      .map((i) => ({ name: this.d.invitationName?.(i.invitation.id) ?? '', createdAt: Date.parse(i.invitation.created) }));
  }

  /** "Lock or wipe after N days without sync", wipe chosen: erase this device now. */
  wipeNow(): Promise<void> {
    return this.exclusive(async () => {
      if (this.wiped) return;
      const engine = await this.engineReady().catch(() => null);
      this.wiped = true;
      this.scheduler.stop();
      if (engine) await engine.wipe();
      else {
        await this.d.wipe.secrets();
        await this.d.wipe.data();
      }
      this.d.onChange();
    });
  }

  // ------------------------------------------------------------------ store rules (gap #6)

  /**
   * "Delete all my content" (privacy/deleteAll.ts): my document emptied, contacts removed, invitations cancelled,
   * followed lists unfollowed, an index listing nothing published (the signed "content deleted" marker), every other
   * file of my storage deleted, then this device erased. A storage failure stops before anything local is erased.
   */
  deleteAllContent(onStep?: (s: DeleteStep) => void): Promise<DeleteAllSummary> {
    return this.exclusive(async () => {
      if (this.wiped) throw new Error('sync: this device was erased');
      await ready();
      const engine = await this.engineReady();
      this.scheduler.stop();
      const own = engine.own;
      const storage = own ? this.d.access.writeAdapter() : null;
      return deleteAllContent({
        store: this.d.store,
        contacts: () => engine.contacts().map((c) => c.owner),
        removeContact: (o) => {
          engine.removeContact(o);
          this.whatsNew.forget(o);
          this.friendProblems.delete(o);
        },
        cancelInvitations: () => {
          const r = cancelAllInvitations(engine.book.records);
          engine.book.records = r.records;
          this.d.state.set(BOOK_KEY, engine.book.records);
          own?.touchVault();
          return r.cancelled.length;
        },
        followedLists: () => engine.followedLists().map((l) => l.id),
        unfollowList: (id) => engine.unfollowList(id),
        publish:
          own && storage
            ? async () => {
                await this.loadFriendKeys();
                for (let attempt = 0; ; attempt++) {
                  const r = await engine.sync({ publish: true, readFriends: false });
                  const p = r.problems.find((x) => x.about === 'own');
                  if (!p) break;
                  if (attempt === 0 && p.problem.retryable) continue;
                  throw new Error(`sync: publishing failed (${p.problem.kind})`);
                }
                const index = own.index;
                return { listed: [...(index?.packs.map((x) => x.file) ?? []), ...(index?.public ? [index.public.file] : [])] };
              }
            : null,
        storage,
        wipe: async () => {
          this.wiped = true;
          await engine.wipe();
        },
        ...(onStep && { onStep }),
      });
    }).catch((e: unknown) => {
      // Nothing local was erased: the app goes on (the user can try again).
      if (!this.wiped) void this.foreground();
      throw e;
    }).finally(() => this.d.onChange());
  }

  /** People I blocked (vault value, so on all my devices; the local copy in local-only mode). */
  blocked(): BlockedPerson[] {
    const v = this.engine?.value<unknown>(BLOCKED_VALUE)?.value;
    return parseBlocked(v !== undefined ? v : this.d.state.get<unknown>(BLOCKED_STATE));
  }

  /**
   * Blocks someone (spec "Moderation": their key and places leave the app, they lose every access): removed as a
   * contact (my next publication drops their wraps), their cache forgotten, their lists unfollowed; the contacts
   * service then refuses their invitations and answers (`isBlocked`).
   */
  block(owner: string, name: string): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      const next = withBlocked(this.blocked(), { owner, name, at: this.now() });
      this.d.state.set(BLOCKED_STATE, next);
      engine.setValue(BLOCKED_VALUE, next);
      if (engine.book.contact(owner)) engine.removeContact(owner);
      else engine.reader.forget(owner);
      for (const l of engine.followedLists()) if (l.owner === owner) engine.unfollowList(l.id);
      this.whatsNew.forget(owner);
      this.friendProblems.delete(owner);
      this.d.store.repo.upsertPerson({ id: owner, iFollow: false });
      this.d.onData();
      this.d.onChange();
    }).then(() => this.localChange());
  }

  unblock(owner: string): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      const next = withoutBlocked(this.blocked(), owner);
      this.d.state.set(BLOCKED_STATE, next);
      engine.setValue(BLOCKED_VALUE, next);
      this.d.onChange();
    }).then(() => this.localChange());
  }

  /** Public lists I reported (hidden on this device). */
  reportedLists(): ReportedList[] {
    return parseReported(this.d.state.get<unknown>(REPORTED_STATE));
  }

  /** Reports a list: kept here as reported, and unfollowed (it leaves the map). */
  hideReportedList(list: { id: string; name: string; owner: string; location: string }): Promise<void> {
    return this.exclusive(async () => {
      const engine = await this.engineReady();
      const next = [{ ...list, at: this.now() }, ...this.reportedLists().filter((r) => r.id !== list.id)];
      this.d.state.set(REPORTED_STATE, next);
      if (engine.followedLists().some((l) => l.id === list.id)) engine.unfollowList(list.id);
      this.whatsNew.forget(list.id);
      this.d.onData();
      this.d.onChange();
    }).then(() => this.localChange());
  }

  /**
   * "Declare the primary device lost" (T-207), before this device switches to the new identity:
   * this controller (old identity) stops; nothing is deleted yet (devices review F-08: the old
   * index stays until the new identity is stored). The new identity's controller carries the vault
   * records over (`migrateMovedBook`) and replaces the old identity's index at its first pass
   * (`clearMovedIndex`); both are resumable.
   */
  prepareIdentityMove(_next?: { owner: string; deviceCert: DeviceCert; deviceName: string; added: number }): Promise<void> {
    return this.exclusive(async () => {
      this.scheduler.stop();
      this.engine = null;
      this.moving = true;
    });
  }

  /**
   * After an identity move (this device's identity carries `move`): the vault records kept for the
   * old owner continue under the new one (friends, their switches, app values; no invitation: the
   * identity change cancels them all; no device list: this device lists itself at its first pass),
   * and the old identity's sync state is dropped. Runs once, at the first build.
   */
  private migrateMovedBook(owner: string, move: { from: string }): void {
    const old = this.d.state.get<VaultRecords>(BOOK_KEY);
    if (!old || old.owner !== move.from) return;
    const app = { ...(old.app ?? {}) } as Record<string, unknown>;
    delete app[DEVICES_KEY];
    const part = app['triangulair_sync'] as Record<string, unknown> | undefined;
    if (part && typeof part === 'object') {
      const rest = { ...part };
      delete rest['own'];
      app['triangulair_sync'] = rest;
    }
    const records = JSON.parse(JSON.stringify({ ...emptyVault(owner), contacts: old.contacts, retired_owners: old.retired_owners, app })) as VaultRecords;
    for (const k of this.d.state.keys('own:')) this.d.state.delete(k);
    for (const k of [RECOVERY_KEY, WRITTEN_KEY, SELF_KEY]) this.d.state.delete(k);
    this.d.state.set(BOOK_KEY, new ContactBook(records).records);
  }

  /**
   * After an identity move: an index of the old identity at my storage (left by the move, or put
   * back by whoever still has the storage access) is removed with its files before the new identity
   * publishes there. At every publishing pass, so a stale one never stays.
   */
  private async clearMovedIndex(engine: SyncEngine, from: string): Promise<void> {
    const own = engine.own!;
    const g = await own.storage.get(INDEX, { maxBytes: INDEX_MAX }).catch(() => null);
    if (!g) return;
    let files: string[];
    try {
      files = verifyIndex(g.data, { expectedOwner: from }).packs.map((p) => p.file);
    } catch {
      return; // the new identity's index (or not mine): nothing to do
    }
    await own.storage.delete(INDEX);
    for (const f of files) await own.storage.delete(f).catch(() => {});
    await own.storage.delete(keyPath(from)).catch(() => {});
    this.d.state.delete('own:index');
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
    // A friend who changed identity keeps the name I gave them.
    for (const f of report.friends) {
      const m = f.identityMove;
      if (!m?.followed) continue;
      const before = this.d.store.repo.getPerson(m.from);
      if (before?.displayName && !this.d.store.repo.getPerson(m.to)?.displayName) this.d.store.repo.upsertPerson({ id: m.to, publicKey: m.to, displayName: before.displayName });
    }
    this.recordNews([...report.friends, ...(report.lists ?? []).map(asFriendReport)], firstRead);
    this.syncPeople(engine);
    const dropped = report.invitationsDropped ? [invitationsLogLine(report.invitationsDropped, report.startedAt)] : [];
    if (report.problems.length || dropped.length) {
      const log = this.d.state.get<string[]>(LOG_KEY) ?? [];
      this.d.state.set(LOG_KEY, [...dropped, ...report.problems.map((p) => logLine(p.about, p.problem, report.startedAt)), ...log].slice(0, LOG_MAX));
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
    // Photos gone since they were announced leave What's new (no empty strip, no broken tile).
    this.whatsNew.prunePhotos((id) => !!repo.mediaById(id));
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
    const fromVault = vaultContactNames(engine);
    for (const c of engine.contacts()) {
      const p = repo.getPerson(c.owner);
      if (fromVault[c.owner] && !this.d.contactName?.(c.owner)) this.d.adoptContactName?.(c.owner, fromVault[c.owner]);
      const name = p?.displayName ? undefined : this.d.contactName?.(c.owner) || fromVault[c.owner] || undefined;
      if (!p || p.iFollow !== c.policy.follow || name) {
        repo.upsertPerson({ id: c.owner, publicKey: c.owner, readUrl: c.sharingCert.location ?? null, iFollow: c.policy.follow, ...(name && { displayName: name }) });
      }
    }
  }

  /**
   * The names of my current contacts for the vault value: those of the vault (written by my other
   * devices), then the names given on this device (person rows), which win.
   */
  private contactNames(engine: SyncEngine): Record<string, string> {
    const repo = this.d.store.repo;
    const fromVault = vaultContactNames(engine);
    const out: Record<string, string> = {};
    for (const c of [...engine.contacts()].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))) {
      const here = repo.getPerson(c.owner)?.displayName?.trim() || this.d.contactName?.(c.owner)?.trim();
      const name = (here || fromVault[c.owner] || '').slice(0, MAX_CONTACT_NAME);
      if (name) out[c.owner] = name;
    }
    return out;
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


  // ------------------------------------------------------------------ photos (T-111b)

  /** The photos service (add, remove, gallery, images); built with the engine, which works without a storage too. */
  async photos(): Promise<Photos | null> {
    if (this.wiped) return null;
    return (await this.engineReady()).photos;
  }

  // ------------------------------------------------------------------ state for the screens

  log(): string[] {
    return this.d.state.get<string[]>(LOG_KEY) ?? [];
  }

  /** Space used on my storage by content type (sync status screen; null without a storage I write to, or when it cannot list). */
  async spaceUsed(): Promise<SpaceUsed | null> {
    const own = this.wiped ? null : this.engine?.own;
    if (!own) return null;
    try {
      return await own.spaceUsed();
    } catch {
      return null;
    }
  }

  /**
   * "Keep" on a friend whose storage has not answered for months: their places stay, and the offer
   * comes back only after as long again ("Remove" is `setPolicy(owner, { follow: false })`).
   */
  keepFriend(owner: string): void {
    if (this.wiped) return;
    this.d.state.set(keptKey(owner), this.now());
    this.d.onChange();
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
          keptAt: this.d.state.get<number>(keptKey(c.owner)) ?? null,
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
      recoveryCopyMissing: !this.wiped && !!e?.own && this.copyMissing,
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
