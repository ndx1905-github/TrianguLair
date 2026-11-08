// SPDX-License-Identifier: MPL-2.0
/**
 * My side of the sync: publishing my packs and syncing my own devices
 * through my storage.
 *
 * Storage layout (see README):
 *
 *   index.json                  signed index (crypto), written last, conditionally (ETag)
 *   packs/b2b256-<hash>.bin     places packs (GeoJSON), one or more per recipient set, my own key always
 *                               included; content-addressed, never modified
 *   media/b2b256-<hash>.bin     my own Yjs document (a full snapshot + incremental deltas) and a manifest
 *                               (logical pack id → recipient-set fingerprint), my key only; under media/
 *                               so that friends, who fetch media/ only on demand (photos), never download them
 *   public/lists.geojson        public lists in plaintext (listed in the index with its hash)
 *   vault.bin                   recovery vault (TLVD, vault data key), conditionally written
 *   keys/<device>.bin           the current sharing key sealed to each of my devices (TLSK), after a rotation
 *
 * Publication order: vault (when it changed: it decides the audiences of
 * my other devices too), packs, public file, a content check of the index
 * (coarse-ETag servers), the index (with If-Match), then the index is read
 * back: storage compare-and-swap is best effort on some servers (T-202), so
 * the publication counts only if the storage now holds our exact index;
 * otherwise we pull (a full GET), merge and publish again. Unused files are
 * deleted only after a successful publication.
 *
 * Trust in my own index (T-204 review R-01): an index of mine is imported
 * (its own-document updates merged, its packs reused) only when it is at or
 * after my anchor and under my current sharing certificate (not an older
 * rotation, not signed by a device my certificate revokes). A rolled-back,
 * forked or older-rotation index only triggers a republication from the local
 * state; nothing it lists is fetched. The anchor is local, or, on a device
 * that has none yet (restored from the recovery kit), the one recorded in the
 * vault (sealed with the current vault data key, which a revoked device does
 * not have); the certificate rule holds without any anchor.
 */
import {
  DecryptionError,
  RollbackError,
  SignatureError,
  indexAnchor,
  openPack,
  openSharingKey,
  openVault,
  packEntry,
  publicEntry,
  sealPack,
  sealSharingKey,
  sealVault,
  serialize,
  signIndex,
  verifyIndex,
  type DeviceCert,
  type DeviceSigner,
  type IndexAnchor,
  type IdentityMove,
  type IndexPackEntry,
  type KeyPair,
  type SharingKey,
  type SignedIndex,
} from '@triangulair/crypto';
import { snapshotOfUpdates, type DataStore } from '@triangulair/data';
import { INDEX_PATH, NotFound, PUBLIC_LISTS_PATH, PreconditionFailed, fetchSnapshot, type StorageAdapter } from '@triangulair/storage';
import { audienceOf, computeAudiences, fingerprint, recipientBytes, type Audience } from './audience.ts';
import { OWN_ANCHOR_STEP, laterAnchor, mergeBooks, sameRecords, type ContactBook } from './contacts.ts';
import { DeviceRevokedError, NeedsKeyError, PayloadError } from './errors.ts';
import { MAX_FEATURES_PER_PACK, featureFor, featureHash, parsePlaces, placesCollection, readOwnItems, zOrder, type PlaceFeature } from './features.ts';
import { resolveLimits, type SyncLimits } from './limits.ts';
import { planPacks, type DesiredItem, type ExistingPack } from './planner.ts';
import { decodePayload, encodePayload, jsonBytes, parseJsonBody, utf8 } from './payload.ts';
import { PUBLIC_LISTS_NAME, buildPublicLists } from './public-lists.ts';
import type { SyncStateStore } from './state.ts';
import { b64, bytesEqual, mapLimit, randomLogicalId, unb64, LimitError } from './util.ts';

export const VAULT_PATH = 'vault.bin';
export const keyPath = (deviceId: string): string => `keys/${deviceId.replace(/^ed25519:/, '')}.bin`;

type PackInfo =
  | { k: 'places'; id: string; rot: number; items: Record<string, string> }
  | { k: 'own-doc'; id: string; rot: number; mode: 'full' | 'delta'; size: number }
  | { k: 'manifest'; id: string; rot: number; fps: Record<string, string> }
  | { k: 'other' };

interface IndexState {
  text: string;
  etag: string | null;
  checkedAt: number;
}

/** A vault data key this device used before a rotation (R-10), with the revocations known then. */
export interface PreviousVaultKey {
  key: Uint8Array;
  rotation: number;
  revoked: string[];
}

export interface OwnSyncOptions {
  store: DataStore;
  storage: StorageAdapter;
  device: DeviceSigner;
  sharing: SharingKey;
  /** Earlier sharing key pairs (friends may still wrap to them until they read my new certificate). */
  previousSharingKeys?: KeyPair[];
  /**
   * Earlier vault data keys (persist `OwnSync.previousVaultKeys` with the sharing keys): a vault my
   * other device sealed just before it adopted the new key is still merged, but only when the newer
   * certificate revoked no device since (otherwise it may come from the revoked device).
   */
  previousVaultKeys?: PreviousVaultKey[];
  /** Size limits (downloads before verification, decompression per kind). */
  limits?: Partial<SyncLimits>;
  state: SyncStateStore;
  book: ContactBook;
  /** Persists the book after a change (the engine stores it in the state). */
  saveBook?: () => void;
  now?: () => Date;
  /** Max places per pack (default 200, about 20 KB compressed). */
  capacity?: number;
  /** Own-document deltas before a new full snapshot is written (default 8). */
  maxOwnDeltas?: number;
  /** Parallel uploads and downloads (default 6; a real Nextcloud takes ~0.4 s per request). */
  concurrency?: number;
  /** See PlanOptions.blur (default true). */
  blur?: boolean;
  /** Re-read the index even when its ETag is unchanged after this long (coarse ETags; default 10 min). */
  fullCheckMs?: number;
  /** Author name written in the public lists file. */
  author?: string;
  /** Called when this device adopts a new sharing key (persist it in the system vault). */
  onSharingKey?: (key: SharingKey) => void;
  /**
   * After an identity change (theft of the primary device): the move from my old identity, signed
   * by both masters. Written in every index I publish (app rule R-11: friends who were offline need it).
   */
  move?: IdentityMove;
  newId?: () => string;
  random?: () => number;
}

export interface PullResult {
  /** My verified current index (null before the first publication, or when the storage holds a stale one). */
  index: SignedIndex | null;
  etag: string | null;
  /** The index text was taken from the local copy (HEAD ETag unchanged), not downloaded. */
  cached: boolean;
  /** Files listed by a stale index found on the storage (deleted after the next publication). */
  staleFiles: string[];
  /**
   * The storage served an index older than one we had seen, of an older rotation, or signed by a
   * device my certificate revokes: nothing it lists was imported; republished from the local state.
   */
  rolledBack: boolean;
  /** The storage holds another index with the seq we published (lost compare-and-swap). */
  forked: boolean;
  /** Own-document updates merged into the local store. */
  imported: number;
  /** Listed packs missing from the storage (healed by the next publication). */
  missing: string[];
  /** A new sharing key was adopted from `keys/`. */
  adoptedKey: boolean;
  /** Device id that signed the index whose own-document updates were imported (when `imported > 0`). */
  importedFrom?: string;
}

export interface PublishReport {
  published: boolean;
  seq: number | null;
  attempts: number;
  /** Lost compare-and-swap races (PreconditionFailed or read-back mismatch). */
  conflicts: number;
  packsWritten: number;
  packsKept: number;
  bytesUploaded: number;
  filesDeleted: number;
  ownDoc: 'none' | 'delta' | 'full';
  pull: PullResult;
}

const MANIFEST = 'manifest';

export class OwnSync {
  readonly store: DataStore;
  readonly storage: StorageAdapter;
  readonly device: DeviceSigner;
  sharing: SharingKey;
  previousKeys: KeyPair[];
  private readonly st: SyncStateStore;
  readonly book: ContactBook;
  private readonly o: OwnSyncOptions;
  private current: { text: string; index: SignedIndex | null; rolledBack?: boolean; forked?: boolean } | null = null;
  private vaultDirty = false;
  private checkedFiles = false;
  private vaultChecked = false;
  readonly limits: SyncLimits;
  /** Earlier vault data keys (persist them with the sharing keys). */
  previousVaultKeys: PreviousVaultKey[];

  constructor(o: OwnSyncOptions) {
    this.o = o;
    this.store = o.store;
    this.storage = o.storage;
    this.device = o.device;
    this.sharing = o.sharing;
    this.previousKeys = [...(o.previousSharingKeys ?? [])];
    this.previousVaultKeys = [...(o.previousVaultKeys ?? [])];
    this.st = o.state;
    this.book = o.book;
    this.limits = resolveLimits(o.limits);
    if ((o.capacity ?? 200) > MAX_FEATURES_PER_PACK) throw new RangeError(`capacity must be at most ${MAX_FEATURES_PER_PACK}`);
  }

  get owner(): string {
    return this.sharing.cert.owner;
  }
  private now(): Date {
    return this.o.now?.() ?? new Date();
  }
  private nowMs(): number {
    return this.now().getTime();
  }
  /** Every key pair that may open my packs (current first). */
  keys(): KeyPair[] {
    return [this.sharing.keyPair, ...this.previousKeys];
  }
  private get rot(): number {
    return this.sharing.cert.rotation;
  }
  private packs(): Record<string, PackInfo> {
    return this.st.get<Record<string, PackInfo>>('own:packs') ?? {};
  }
  /** My anchor: the local one, or the vault's (a device restored from the recovery kit), whichever is later. */
  private anchor(): IndexAnchor | undefined {
    return laterAnchor(this.st.get<IndexAnchor>('own:anchor'), this.book.ownAnchor());
  }
  /** The last verified index of mine on the storage (null before the first publication). */
  get index(): SignedIndex | null {
    return this.current?.rolledBack || this.current?.forked ? null : (this.current?.index ?? null);
  }

  // ------------------------------------------------------------------ pull

  /**
   * Reads my index, merges my other devices' document changes, adopts a new sharing key, merges the
   * vault. `full`: download the index even if its ETag is unchanged (coarse ETags), and list the files.
   */
  async pull(opts: { full?: boolean } = {}): Promise<PullResult> {
    const res: PullResult = {
      index: null, etag: null, cached: false, staleFiles: [], rolledBack: false, forked: false, imported: 0, missing: [], adoptedKey: false,
    };
    const prev = this.st.get<IndexState>('own:index');
    const fresh = !opts.full && !!prev && this.nowMs() - prev.checkedAt < (this.o.fullCheckMs ?? 600_000);
    let text: string;
    let etag: string;
    try {
      const f = await fetchSnapshot(this.storage, fresh && prev.etag ? prev.etag : null, { maxBytes: this.limits.indexBytes });
      if (!f.changed && prev) {
        text = prev.text;
        etag = f.etag;
        res.cached = true;
      } else if (f.changed) {
        text = new TextDecoder().decode(f.index);
        etag = f.etag;
      } else throw new NotFound(INDEX_PATH);
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
      this.current = null;
      await this.pullVault();
      return res;
    }
    // A device without a local anchor yet (restored from the recovery kit): the vault's anchor first.
    if (!this.st.get('own:anchor') && !this.vaultChecked) await this.pullVault();

    let index: SignedIndex | null;
    let stale: 'rolledBack' | 'forked' | null = null;
    if (this.current?.text === text) {
      index = this.current.index;
      if (this.current.rolledBack) stale = 'rolledBack';
      if (this.current.forked) stale = 'forked';
    } else {
      const anchor = this.anchor();
      const vo = { expectedOwner: this.owner, location: this.sharing.cert.location!, now: this.now(), retiredOwners: this.book.retiredOwners() };
      try {
        index = verifyIndex(text, anchor ? { ...vo, lastSeen: anchor } : vo);
      } catch (e) {
        if (e instanceof RollbackError) {
          // An older index of mine (a restored backup, a stale copy, an index of an older rotation
          // signed by a device declared lost), or the loser of a non-atomic compare-and-swap (same
          // seq): it only tells us to publish again above our anchor. Still check it is mine.
          stale = e.fork ? 'forked' : 'rolledBack';
          try {
            index = verifyIndex(text, vo);
          } catch {
            index = null;
          }
        } else if (e instanceof SignatureError && e.code === 'REVOKED') {
          // Signed by a device my certificate (the one in that index) revokes: overwrite it.
          stale = 'rolledBack';
          index = null;
        } else throw e;
      }
      if (index && !stale) {
        // Independently of the anchor: never trust an index of an older rotation than my
        // certificate, or one signed by a device my certificate revokes.
        if (index.sharing_cert.rotation < this.rot || this.sharing.cert.revoked_devices.includes(index.device_cert.device)) stale = 'rolledBack';
      }
    }
    // A revocation is master-signed: it counts whatever the index (a stale one cannot hold a newer one).
    if (index?.revoked_devices.includes(this.device.keys.id)) throw new DeviceRevokedError();
    res.etag = etag;
    if (stale) {
      res[stale] = true;
      res.staleFiles = index ? index.packs.map((p) => p.file) : [];
      this.current = { text, index, rolledBack: stale === 'rolledBack', forked: stale === 'forked' };
      this.st.set('own:index', { text, etag, checkedAt: this.nowMs() } satisfies IndexState);
      await this.pullVault();
      return res;
    }
    index = index!;
    if (index.sharing_cert.rotation > this.rot) {
      await this.fetchNewKey(index);
      res.adoptedKey = true;
    }
    res.index = index;

    // Packs I do not know yet (written by another device): open them with my keys.
    const cache = this.packs();
    // packs/: places packs; media/: my own document and manifest (friends never fetch media/ at sync) and photos.
    const listed = index.packs;
    const unknown = listed.filter((p) => {
      const info = cache[p.hash];
      return !info || (info.k === 'own-doc' && !this.st.getBytes(`own:doc:${p.hash}`));
    });
    // On a full check (and the first pull of a session), make sure the files I wrote are still there
    // (one listing per directory): a damaged storage is healed by the next publication.
    if ((!fresh || !this.checkedFiles) && this.storage.capabilities.list) {
      this.checkedFiles = true;
      const present = new Set<string>();
      for (const dir of ['packs/', 'media/']) for (const e of await this.storage.list(dir)) present.add(e.path);
      for (const p of listed) if (cache[p.hash] && !present.has(p.file)) res.missing.push(p.file);
    }
    const opened = await mapLimit(unknown, this.o.concurrency ?? 6, async (p) => {
      const max = p.file.startsWith('media/') ? this.limits.ownFileBytes : this.limits.packBytes;
      const g = await this.storage.get(p.file, { maxBytes: max });
      if (!g) return { p, info: null as PackInfo | null, update: null as Uint8Array | null };
      return { p, ...this.classify(g.data, index, p) };
    });
    const updates: Uint8Array[] = [];
    for (const { p, info, update } of opened) {
      if (!info) {
        res.missing.push(p.file);
        continue;
      }
      cache[p.hash] = info;
      if (update) {
        this.st.setBytes(`own:doc:${p.hash}`, update);
        updates.push(update);
      }
    }
    // Merge my other devices' changes (Yjs updates commute; duplicates are no-ops).
    for (const u of updates) this.store.importChanges(u);
    res.imported = updates.length;
    if (updates.length) res.importedFrom = index.device_cert.device;

    // Forget packs that are no longer listed.
    const listedHashes = new Set(listed.map((p) => p.hash));
    for (const h of Object.keys(cache)) {
      if (!listedHashes.has(h)) {
        delete cache[h];
        this.st.delete(`own:doc:${h}`);
      }
    }
    this.st.set('own:packs', cache);
    this.st.set('own:index', { text, etag, checkedAt: this.nowMs() } satisfies IndexState);
    this.current = { text, index };
    this.st.set('own:anchor', laterAnchor(this.st.get<IndexAnchor>('own:anchor'), indexAnchor(index)));
    this.remoteSnapshot(index, cache);
    await this.pullVault();
    return res;
  }

  /**
   * What a listed file of mine holds. `info: null` = treat it as missing (rewritten by the next
   * publication): served at the path of ANOTHER listed file (R-03). An unreadable pack (bad payload,
   * over a limit) is `other`: `build()` rewrites or drops it (R-12); only a newer payload version stops
   * the pull (another device of mine runs a newer app: do not overwrite what it wrote).
   */
  private classify(bytes: Uint8Array, index: SignedIndex, entry: IndexPackEntry): { info: PackInfo | null; update: Uint8Array | null } {
    let opened;
    try {
      opened = openPack(bytes, index, this.keys());
    } catch (e) {
      if (e instanceof DecryptionError && e.code === 'NO_MATCHING_KEY') return { info: { k: 'other' }, update: null };
      throw e;
    }
    if (opened.file !== entry.file) return { info: null, update: null };
    // Opened with an older key: sealed before a rotation, rewrite it.
    const rot = this.sealedForCurrentKey(bytes, index) ? this.rot : -1;
    try {
      const { kind, body } = decodePayload(opened.payload, {
        maxBytes: { places: this.limits.placesPayloadBytes, manifest: this.limits.manifestPayloadBytes, 'own-doc': this.limits.ownDocPayloadBytes },
      });
      if (kind === 'places') {
        const items: Record<string, string> = {};
        for (const f of parsePlaces(body)) items[f.feature.id] = f.hash;
        return { info: { k: 'places', id: opened.id, rot, items }, update: null };
      }
      if (kind === 'own-doc') {
        if (body.length < 1 || (body[0] !== 1 && body[0] !== 2)) throw new PayloadError('own-doc: bad mode');
        return { info: { k: 'own-doc', id: opened.id, rot, mode: body[0] === 1 ? 'full' : 'delta', size: body.length - 1 }, update: body.subarray(1) };
      }
      const m = parseJsonBody(body) as { kind?: string; version?: number; packs?: Record<string, string> };
      if (m?.kind !== MANIFEST || m.version !== 1 || typeof m.packs !== 'object' || m.packs === null) throw new PayloadError('manifest: malformed');
      return { info: { k: 'manifest', id: opened.id, rot, fps: m.packs }, update: null };
    } catch (e) {
      if (e instanceof PayloadError && e.unsupported) throw e;
      if (e instanceof PayloadError || e instanceof LimitError) return { info: { k: 'other' }, update: null };
      throw e;
    }
  }

  private sealedForCurrentKey(bytes: Uint8Array, index: SignedIndex): boolean {
    if (this.previousKeys.length === 0) return true;
    try {
      openPack(bytes, index, [this.sharing.keyPair]);
      return true;
    } catch {
      return false;
    }
  }

  /** Snapshot of what my listed own-document packs hold (cached per set of files). */
  private remoteSnapshot(index: SignedIndex, cache: Record<string, PackInfo>): Uint8Array | null {
    const docs = index.packs.filter((p) => cache[p.hash]?.k === 'own-doc').map((p) => p.hash).sort();
    if (docs.length === 0) return null;
    const set = fingerprint(docs);
    const cur = this.st.get<{ set: string; snapshot: string }>('own:remote');
    if (cur?.set === set) return unb64(cur.snapshot);
    const updates = docs.map((h) => this.st.getBytes(`own:doc:${h}`)).filter((u): u is Uint8Array => !!u);
    if (updates.length !== docs.length) return null;
    const snapshot = snapshotOfUpdates(updates);
    this.st.set('own:remote', { set, snapshot: b64(snapshot) });
    return snapshot;
  }

  private async fetchNewKey(index: SignedIndex): Promise<void> {
    const g = await this.storage.get(keyPath(this.device.keys.id), { maxBytes: 64 * 1024 });
    if (!g) throw new NeedsKeyError(index.sharing_cert.rotation);
    let k: SharingKey;
    try {
      k = openSharingKey(g.data, this.device.keys, { expectedOwner: this.owner, lastSeen: this.sharing.cert });
    } catch {
      throw new NeedsKeyError(index.sharing_cert.rotation);
    }
    if (k.cert.rotation < index.sharing_cert.rotation || k.cert.key !== index.sharing_cert.key) throw new NeedsKeyError(index.sharing_cert.rotation);
    this.adopt(k);
  }

  private adopt(k: SharingKey): void {
    if (k.cert.key !== this.sharing.cert.key) this.previousKeys = [this.sharing.keyPair, ...this.previousKeys].slice(0, 4);
    if (!bytesEqual(k.vaultDataKey, this.sharing.vaultDataKey)) {
      const old: PreviousVaultKey = { key: this.sharing.vaultDataKey, rotation: this.rot, revoked: [...this.sharing.cert.revoked_devices] };
      this.previousVaultKeys = [old, ...this.previousVaultKeys].slice(0, 4);
    }
    this.sharing = k;
    this.vaultDirty = true; // re-sealed with the new vault data key
    this.o.onSharingKey?.(k);
  }

  /**
   * Adopts a new sharing key (and vault data key), as the primary device does
   * after `issueSharingCert(…, { rotation: r + 1 })`, and seals it to my other
   * devices (`keys/<device>.bin`) so they pick it up at their next sync. The
   * next publication re-encrypts everything for the new key.
   */
  async rotate(k: SharingKey, devices: readonly DeviceCert[] = []): Promise<void> {
    for (const cert of devices) {
      if (cert.device === this.device.keys.id) continue;
      await this.storage.put(keyPath(cert.device), sealSharingKey(k, cert));
    }
    this.adopt(k);
  }

  // ------------------------------------------------------------------ vault

  private async pullVault(): Promise<void> {
    this.vaultChecked = true;
    const vs = this.st.get<{ etag: string | null; key: string }>('own:vault');
    const keyFp = fingerprint([b64(this.sharing.vaultDataKey)]);
    if (vs && vs.key !== keyFp) this.vaultDirty = true;
    const h = await this.storage.head(VAULT_PATH);
    if (!h) {
      this.st.set('own:vault', { etag: null, key: keyFp });
      this.vaultDirty = true;
      return;
    }
    if (vs?.etag === h.etag && vs.key === keyFp) return;
    const g = await this.storage.get(VAULT_PATH, { maxBytes: 16 * 1024 * 1024 });
    if (!g) return;
    let remote;
    let current = true;
    try {
      remote = openVault(g.data, this.owner, this.sharing.vaultDataKey);
    } catch {
      // Sealed with a vault data key I had before a rotation (R-10: another device of mine wrote it
      // before adopting the new one): merge it, but only when no device was revoked since, otherwise
      // it may come from the revoked device (spec "Loss and theft" step 1: start from our copy).
      const revoked = new Set(this.sharing.cert.revoked_devices);
      for (const pk of this.previousVaultKeys) {
        if (revoked.size !== pk.revoked.length || pk.revoked.some((d) => !revoked.has(d))) continue;
        try {
          remote = openVault(g.data, this.owner, pk.key);
          current = false;
          break;
        } catch {
          // next key
        }
      }
    }
    if (!remote) {
      // Sealed with another vault data key (a device that has not adopted the
      // current one, or damaged): start from our copy (spec "Loss and theft" step 1).
      this.st.set('own:vault', { etag: g.etag, key: keyFp });
      this.vaultDirty = true;
      return;
    }
    const merged = mergeBooks(this.book.records, remote);
    this.book.records = merged;
    this.o.saveBook?.();
    this.vaultDirty ||= !current || !sameRecords(merged, remote);
    this.st.set('own:vault', { etag: g.etag, key: keyFp });
  }

  /** Marks the vault as changed locally (a contact added or edited). */
  touchVault(): void {
    this.vaultDirty = true;
  }

  async pushVault(): Promise<boolean> {
    if (!this.vaultDirty) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const vs = this.st.get<{ etag: string | null; key: string }>('own:vault');
      const bytes = sealVault(this.book.records, this.sharing.vaultDataKey);
      try {
        const r = await this.storage.put(VAULT_PATH, bytes, vs?.etag ? { ifMatch: vs.etag } : { ifNoneMatch: '*' });
        this.st.set('own:vault', { etag: r.etag, key: fingerprint([b64(this.sharing.vaultDataKey)]) });
        this.vaultDirty = false;
        return true;
      } catch (e) {
        if (!(e instanceof PreconditionFailed)) throw e;
        this.st.set('own:vault', { etag: null, key: '' });
        await this.pullVault();
        this.vaultDirty = true;
      }
    }
    throw new PreconditionFailed(VAULT_PATH);
  }

  // ------------------------------------------------------------------ publish

  /** Pulls, then publishes what changed. Retries lost races (re-read in full, merge, republish). */
  async publish(opts: { force?: boolean } = {}): Promise<PublishReport> {
    let conflicts = 0;
    const orphans = new Set<string>(this.st.get<string[]>('own:garbage') ?? []);
    for (let attempt = 1; attempt <= 5; attempt++) {
      // After a lost race, never trust an unchanged ETag (coarse ETags: the winner's index may have the same one).
      const pull = await this.pull({ full: attempt > 1 });
      // The vault first (R-09): my other devices compute their audiences from it, so a removed
      // contact must reach it before anything else is published.
      await this.pushVault();
      const b = this.build(pull);
      const report: PublishReport = {
        published: false, seq: pull.index?.seq ?? null, attempts: attempt, conflicts, packsWritten: b.writes.size,
        packsKept: b.kept, bytesUploaded: 0, filesDeleted: 0, ownDoc: b.ownDoc, pull,
      };
      if (!b.changed && !opts.force && pull.index) return report;
      await mapLimit([...b.writes], this.o.concurrency ?? 6, async ([path, bytes]) => {
        report.bytesUploaded += bytes.length;
        try {
          await this.storage.put(path, bytes, { ifNoneMatch: '*' });
        } catch (e) {
          if (!(e instanceof PreconditionFailed)) throw e; // content-addressed: same name, same bytes
        }
      });
      if (b.publicFile) {
        report.bytesUploaded += b.publicFile.length;
        await this.storage.put(PUBLIC_LISTS_PATH, b.publicFile, { contentType: 'application/geo+json' });
      }
      const text = serialize(b.index);
      const bytes = utf8(text);
      let ok = true;
      try {
        // R-08: on servers with coarse ETags (Nextcloud, WsgiDAV: mtime in seconds + size) another
        // device's index can carry the ETag we based this attempt on, and If-Match would let us
        // overwrite it. Compare the content right before writing.
        const base = this.current?.text ?? null;
        if (pull.etag) {
          const cur = await this.storage.get(INDEX_PATH, { maxBytes: this.limits.indexBytes });
          if (!cur || base === null || new TextDecoder().decode(cur.data) !== base) throw new PreconditionFailed(INDEX_PATH, { detail: 'index changed (content check)' });
        }
        await this.storage.put(INDEX_PATH, bytes, pull.etag ? { ifMatch: pull.etag, contentType: 'application/json' } : { ifNoneMatch: '*', contentType: 'application/json' });
        const back = await this.storage.get(INDEX_PATH, { maxBytes: this.limits.indexBytes });
        ok = !!back && bytesEqual(back.data, bytes);
        if (ok) {
          this.st.set('own:index', { text, etag: back!.etag, checkedAt: this.nowMs() } satisfies IndexState);
        }
      } catch (e) {
        if (!(e instanceof PreconditionFailed)) throw e;
        ok = false;
      }
      if (!ok) {
        conflicts++;
        for (const p of b.writes.keys()) orphans.add(p);
        this.st.set('own:garbage', [...orphans]);
        continue;
      }
      // Committed.
      this.current = { text, index: b.index };
      const anchor = indexAnchor(b.index);
      this.st.set('own:anchor', anchor);
      const inVault = this.book.ownAnchor();
      this.book.noteOwnAnchor(anchor);
      this.o.saveBook?.();
      if (!inVault || inVault.sharing_cert.rotation !== anchor.sharing_cert.rotation || anchor.seq - inVault.seq >= OWN_ANCHOR_STEP) this.vaultDirty = true;
      this.st.set('own:packs', b.cache);
      for (const [h, u] of b.docBytes) this.st.setBytes(`own:doc:${h}`, u);
      if (b.snapshot) {
        const docs = b.index.packs.filter((p) => b.cache[p.hash]?.k === 'own-doc').map((p) => p.hash).sort();
        this.st.set('own:remote', { set: fingerprint(docs), snapshot: b64(b.snapshot) });
      }
      const listed = new Set(b.index.packs.map((p) => p.file));
      const last = this.st.get<string[]>('own:published') ?? [];
      // Files of a stale index (a rolled-back copy, a fork, a revoked device's) are superseded too.
      const garbage = [...new Set([...b.drop, ...last, ...orphans, ...pull.staleFiles])].filter((f) => !listed.has(f));
      if (!b.index.public && pull.index?.public) garbage.push(PUBLIC_LISTS_PATH);
      const left: string[] = [];
      await mapLimit(garbage, this.o.concurrency ?? 6, async (f) => {
        try {
          await this.storage.delete(f);
          report.filesDeleted++;
        } catch {
          left.push(f);
        }
      });
      this.st.set('own:garbage', left);
      this.st.set('own:published', [...listed]);
      for (const h of Object.keys(b.cache)) if (!b.index.packs.some((p) => p.hash === h)) this.st.delete(`own:doc:${h}`);
      await this.pushVault();
      report.published = true;
      report.seq = b.index.seq;
      report.conflicts = conflicts;
      return report;
    }
    throw new PreconditionFailed(INDEX_PATH, { detail: 'lost the race too many times' });
  }

  /** Builds the next index from the local state and what the pull found (synchronous). */
  private build(pull: PullResult) {
    // A stale index (rollback, fork, older rotation) is never built upon: everything is rewritten
    // from the local state, above the anchor (R-01).
    const stale = pull.rolledBack || pull.forked;
    const prev = stale ? null : pull.index;
    const repo = this.store.repo;
    const now = this.now();
    const newId = this.o.newId ?? randomLogicalId;
    const cache: Record<string, PackInfo> = { ...this.packs() };
    const missing = new Set(pull.missing);
    const listed = (prev?.packs ?? []).filter((p) => !missing.has(p.file));
    const infoOf = (p: IndexPackEntry) => cache[p.hash];

    // What each audience can read.
    const items = readOwnItems(repo);
    const audiences = computeAudiences(items, {
      myCert: this.sharing.cert,
      contacts: this.book.contacts(),
      invitations: this.book.invitations(),
      listItems: (id) => repo.listItems(id),
      now,
    });
    const desired = new Map<string, DesiredItem>();
    const features = new Map<string, PlaceFeature>();
    const audByFp = new Map<string, Audience>();
    for (const it of items) {
      const a = audiences.get(it.placeId);
      if (!a) continue;
      const f = featureFor(it, 'friends');
      features.set(it.placeId, f);
      audByFp.set(a.fp, a);
      desired.set(it.placeId, { id: it.placeId, fp: a.fp, hash: featureHash(f), sortKey: zOrder(it.lat, it.lon) });
    }

    // Current packs (sealed for the current key; anything else is rewritten).
    const manifestEntry = listed.find((p) => { const i = infoOf(p); return i?.k === 'manifest' && i.rot === this.rot; });
    const fps = manifestEntry ? (infoOf(manifestEntry) as Extract<PackInfo, { k: 'manifest' }>).fps : {};
    const existing: ExistingPack[] = [];
    const drop: string[] = [];
    const entries: IndexPackEntry[] = [];
    for (const p of listed) {
      const i = infoOf(p);
      if (i?.k === 'places') {
        if (i.rot === this.rot) existing.push({ id: i.id, fp: fps[i.id] ?? null, items: i.items, file: p.file });
        else drop.push(p.file);
      } else if (!i || i.k === 'other') {
        // Not mine to rebuild: a photo (media/) is kept as it is; an unreadable places pack is rewritten.
        if (p.file.startsWith('media/')) entries.push(p);
        else drop.push(p.file);
      }
    }
    const plan = planPacks(existing, desired, {
      capacity: this.o.capacity ?? 200,
      blur: this.o.blur ?? true,
      newId,
      ...(this.o.random && { random: this.o.random }),
    });
    drop.push(...plan.drop);

    const writes = new Map<string, Uint8Array>();
    const keptFiles = new Set(plan.keep.map((p) => p.file));
    for (const p of listed) if (keptFiles.has(p.file)) entries.push(p);
    const add = (bytes: Uint8Array, info: PackInfo) => {
      const e = packEntry(bytes, info.k === 'places' ? 'packs' : 'media');
      writes.set(e.file, bytes);
      entries.push(e);
      cache[e.hash] = info;
      return e;
    };
    const newFps: Record<string, string> = {};
    for (const p of plan.keep) newFps[p.id] = p.fp!;
    for (const w of plan.write) {
      const feats = w.itemIds.map((id) => features.get(id)!);
      const payload = encodePayload('places', placesCollection(feats));
      const bytes = sealPack(this.owner, payload, recipientBytes(audByFp.get(w.fp)!), { id: w.id });
      const itemsMap: Record<string, string> = {};
      for (const id of w.itemIds) itemsMap[id] = desired.get(id)!.hash;
      add(bytes, { k: 'places', id: w.id, rot: this.rot, items: itemsMap });
      newFps[w.id] = w.fp;
    }

    // My own document.
    const me = audienceOf([this.sharing.cert.key]);
    const docs = listed.filter((p) => infoOf(p)?.k === 'own-doc');
    const docsOk = docs.filter((p) => (infoOf(p) as Extract<PackInfo, { k: 'own-doc' }>).rot === this.rot);
    // A listed pack is missing from the storage: write my whole document again (it may have been one of mine).
    const remote = docsOk.length === docs.length && missing.size === 0 ? this.remoteSnapshot(prev ?? emptyIndexLike(), cache) : null;
    let ownDoc: 'none' | 'delta' | 'full' = 'none';
    let snapshot: Uint8Array | null = null;
    const docBytes = new Map<string, Uint8Array>();
    if (!remote || !this.store.isAt(remote)) {
      const sizes = docsOk.map((p) => infoOf(p) as Extract<PackInfo, { k: 'own-doc' }>);
      const base = sizes.find((s) => s.mode === 'full')?.size ?? 0;
      const deltas = sizes.filter((s) => s.mode === 'delta').reduce((n, s) => n + s.size, 0);
      const full = !remote || docs.length !== docsOk.length || docsOk.length >= (this.o.maxOwnDeltas ?? 8) || deltas > base;
      snapshot = this.store.snapshot();
      const update = full ? this.store.exportDoc() : this.store.exportSince(remote!);
      const body = new Uint8Array(update.length + 1);
      body[0] = full ? 1 : 2;
      body.set(update, 1);
      const bytes = sealPack(this.owner, encodePayload('own-doc', body), recipientBytes(me), { id: newId() });
      const e = add(bytes, { k: 'own-doc', id: 'doc', rot: this.rot, mode: full ? 'full' : 'delta', size: update.length });
      docBytes.set(e.hash, update);
      ownDoc = full ? 'full' : 'delta';
      if (full) drop.push(...docs.map((p) => p.file));
      else entries.push(...docsOk);
    } else entries.push(...docsOk);
    for (const p of docs) if (!docsOk.includes(p)) drop.push(p.file);

    // Manifest (my devices only): which recipient set each places pack is for.
    const sortedFps = Object.fromEntries(Object.entries(newFps).sort(([a], [b]) => (a < b ? -1 : 1)));
    const manifestChanged = !manifestEntry || JSON.stringify(sortedFps) !== JSON.stringify(Object.fromEntries(Object.entries(fps).sort(([a], [b]) => (a < b ? -1 : 1))));
    for (const p of listed) if (infoOf(p)?.k === 'manifest' && (manifestChanged || p !== manifestEntry)) drop.push(p.file);
    if (manifestChanged) {
      const id = manifestEntry ? (infoOf(manifestEntry) as Extract<PackInfo, { k: 'manifest' }>).id : newId();
      const bytes = sealPack(this.owner, encodePayload('manifest', jsonBytes({ kind: MANIFEST, version: 1, packs: sortedFps })), recipientBytes(me), { id });
      add(bytes, { k: 'manifest', id, rot: this.rot, fps: sortedFps });
    } else if (manifestEntry) entries.push(manifestEntry);


    // Public lists (plaintext).
    const publicFile = buildPublicLists(repo, items, { owner: this.owner, ...(this.o.author && { author: this.o.author }) });
    const pub = publicFile ? publicEntry(publicFile, PUBLIC_LISTS_NAME) : undefined;
    const publicChanged = (pub?.hash ?? null) !== (prev?.public?.hash ?? null);

    entries.sort((a, b) => (a.hash < b.hash ? -1 : 1));
    const anchor = this.anchor();
    const previous = stale || !prev ? anchor : prev;
    const seq = (previous?.seq ?? 0) + 1;
    const index = signIndex(this.device, {
      seq,
      sharingCert: this.sharing.cert,
      packs: entries,
      vaultDataKey: this.sharing.vaultDataKey,
      invitations: this.book.invitations().map((i) => i.invitation),
      ...(this.o.move && { move: this.o.move }),
      ...(pub && { public: pub }),
      ...(previous && { previous }),
      now,
    });
    const changed =
      writes.size > 0 || drop.length > 0 || publicChanged || !prev || stale || missing.size > 0 ||
      prev.sharing_cert.rotation !== this.rot ||
      JSON.stringify(prev.invitations ?? []) !== JSON.stringify(index.invitations ?? []);
    return {
      index, writes, drop, cache, docBytes, snapshot, ownDoc, changed,
      kept: plan.keep.length, publicFile: publicChanged ? publicFile : null,
    };
  }
}

function emptyIndexLike(): SignedIndex {
  return { packs: [] } as unknown as SignedIndex;
}
