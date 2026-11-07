// SPDX-License-Identifier: MPL-2.0
/**
 * My side of the sync: publishing my packs and syncing my own devices
 * through my storage.
 *
 * Storage layout (see README):
 *
 *   index.json                  signed index (crypto), written last, conditionally (ETag)
 *   packs/b2b256-<hash>.bin     content-addressed packs, never modified:
 *                               - places packs (GeoJSON) for each recipient set, my own key always included
 *                               - my own Yjs document (a full snapshot + incremental deltas), my key only
 *                               - a manifest (logical pack id → recipient-set fingerprint), my key only
 *   public/lists.geojson        public lists in plaintext (listed in the index with its hash)
 *   vault.bin                   recovery vault (TLVD, vault data key), conditionally written
 *   keys/<device>.bin           the current sharing key sealed to each of my devices (TLSK), after a rotation
 *
 * Publication order: packs, public file, index (with If-Match), then the
 * index is read back: storage compare-and-swap is best effort on some
 * servers (T-202), so the publication counts only if the storage now holds
 * our exact index; otherwise we pull, merge and publish again. Unused files
 * are deleted only after a successful publication.
 */
import {
  DecryptionError,
  RollbackError,
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
  type IndexPackEntry,
  type KeyPair,
  type SharingKey,
  type SignedIndex,
} from '@triangulair/crypto';
import { snapshotOfUpdates, type DataStore } from '@triangulair/data';
import { INDEX_PATH, NotFound, PUBLIC_LISTS_PATH, PreconditionFailed, fetchSnapshot, type StorageAdapter } from '@triangulair/storage';
import { audienceOf, computeAudiences, fingerprint, recipientBytes, type Audience } from './audience.ts';
import { mergeBooks, sameRecords, type ContactBook } from './contacts.ts';
import { DeviceRevokedError, NeedsKeyError, PayloadError } from './errors.ts';
import { featureFor, featureHash, parsePlaces, placesCollection, readOwnItems, zOrder, type PlaceFeature } from './features.ts';
import { planPacks, type DesiredItem, type ExistingPack } from './planner.ts';
import { decodePayload, encodePayload, jsonBytes, parseJsonBody, utf8 } from './payload.ts';
import { PUBLIC_LISTS_NAME, buildPublicLists } from './public-lists.ts';
import type { SyncStateStore } from './state.ts';
import { b64, bytesEqual, mapLimit, randomLogicalId, unb64 } from './util.ts';

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

export interface OwnSyncOptions {
  store: DataStore;
  storage: StorageAdapter;
  device: DeviceSigner;
  sharing: SharingKey;
  /** Earlier sharing key pairs (friends may still wrap to them until they read my new certificate). */
  previousSharingKeys?: KeyPair[];
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
  newId?: () => string;
  random?: () => number;
}

export interface PullResult {
  index: SignedIndex | null;
  etag: string | null;
  /** The storage served an index older than one we had seen (republished from our anchor). */
  rolledBack: boolean;
  /** The storage holds another index with the seq we published (lost compare-and-swap). */
  forked: boolean;
  /** Own-document updates merged into the local store. */
  imported: number;
  /** Listed packs missing from the storage (healed by the next publication). */
  missing: string[];
  /** A new sharing key was adopted from `keys/`. */
  adoptedKey: boolean;
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
  private current: { text: string; index: SignedIndex } | null = null;
  private vaultDirty = false;

  constructor(o: OwnSyncOptions) {
    this.o = o;
    this.store = o.store;
    this.storage = o.storage;
    this.device = o.device;
    this.sharing = o.sharing;
    this.previousKeys = [...(o.previousSharingKeys ?? [])];
    this.st = o.state;
    this.book = o.book;
  }

  get owner(): string {
    return this.sharing.cert.owner;
  }
  private now(): Date {
    return this.o.now?.() ?? new Date();
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
  private anchor(): IndexAnchor | undefined {
    return this.st.get<IndexAnchor>('own:anchor');
  }
  /** The last verified index of mine on the storage (null before the first publication). */
  get index(): SignedIndex | null {
    return this.current?.index ?? null;
  }

  // ------------------------------------------------------------------ pull

  /** Reads my index, merges my other devices' document changes, adopts a new sharing key, merges the vault. */
  async pull(): Promise<PullResult> {
    const res: PullResult = { index: null, etag: null, rolledBack: false, forked: false, imported: 0, missing: [], adoptedKey: false };
    const prev = this.st.get<IndexState>('own:index');
    const fresh = prev && Date.now() - prev.checkedAt < (this.o.fullCheckMs ?? 600_000);
    let text: string;
    let etag: string;
    try {
      const f = await fetchSnapshot(this.storage, fresh && prev.etag ? prev.etag : null);
      if (!f.changed && prev) {
        text = prev.text;
        etag = f.etag;
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

    let index: SignedIndex;
    if (this.current?.text === text) index = this.current.index;
    else {
      const anchor = this.anchor();
      const opts = { expectedOwner: this.owner, location: this.sharing.cert.location!, now: this.now(), retiredOwners: this.book.retiredOwners() };
      try {
        index = verifyIndex(text, anchor ? { ...opts, lastSeen: anchor } : opts);
      } catch (e) {
        if (!(e instanceof RollbackError)) throw e;
        // An older index of mine (a restored backup, a stale copy) or the
        // loser of a non-atomic compare-and-swap (same seq): publish again
        // above our anchor. Still check it is genuinely mine.
        index = verifyIndex(text, opts);
        if (e.fork) res.forked = true;
        else res.rolledBack = true;
      }
    }
    if (index.revoked_devices.includes(this.device.keys.id)) throw new DeviceRevokedError();
    if (index.sharing_cert.rotation > this.rot) {
      await this.fetchNewKey(index);
      res.adoptedKey = true;
    }
    res.index = index;
    res.etag = etag;

    // Packs I do not know yet (written by another device): open them with my keys.
    const cache = this.packs();
    const listed = index.packs.filter((p) => p.file.startsWith('packs/'));
    const unknown = listed.filter((p) => {
      const info = cache[p.hash];
      return !info || (info.k === 'own-doc' && !this.st.getBytes(`own:doc:${p.hash}`));
    });
    const opened = await mapLimit(unknown, this.o.concurrency ?? 6, async (p) => {
      const g = await this.storage.get(p.file);
      if (!g) return { p, info: null as PackInfo | null, update: null as Uint8Array | null };
      return { p, ...this.classify(g.data, index) };
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

    // Forget packs that are no longer listed.
    const listedHashes = new Set(listed.map((p) => p.hash));
    for (const h of Object.keys(cache)) {
      if (!listedHashes.has(h)) {
        delete cache[h];
        this.st.delete(`own:doc:${h}`);
      }
    }
    this.st.set('own:packs', cache);
    this.st.set('own:index', { text, etag, checkedAt: Date.now() } satisfies IndexState);
    this.current = { text, index };
    if (!res.rolledBack && !res.forked) this.st.set('own:anchor', laterAnchor(this.anchor(), indexAnchor(index)));
    this.remoteSnapshot(index, cache);
    await this.pullVault();
    return res;
  }

  private classify(bytes: Uint8Array, index: SignedIndex): { info: PackInfo; update: Uint8Array | null } {
    let opened;
    try {
      opened = openPack(bytes, index, this.keys());
    } catch (e) {
      if (e instanceof DecryptionError && e.code === 'NO_MATCHING_KEY') return { info: { k: 'other' }, update: null };
      throw e;
    }
    // Opened with an older key: sealed before a rotation, rewrite it.
    const rot = this.sealedForCurrentKey(bytes, index) ? this.rot : -1;
    const { kind, body } = decodePayload(opened.payload);
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
    const g = await this.storage.get(keyPath(this.device.keys.id));
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
    const g = await this.storage.get(VAULT_PATH);
    if (!g) return;
    let remote;
    try {
      remote = openVault(g.data, this.owner, this.sharing.vaultDataKey);
    } catch {
      // Sealed with another vault data key (a device that has not adopted the
      // current one, or damaged): start from our copy (spec "Loss and theft" step 1).
      this.st.set('own:vault', { etag: g.etag, key: keyFp });
      this.vaultDirty = true;
      return;
    }
    const merged = mergeBooks(this.book.records, remote);
    this.book.records = merged;
    this.o.saveBook?.();
    this.vaultDirty ||= !sameRecords(merged, remote);
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

  /** Pulls, then publishes what changed. Retries lost races (re-read, merge, republish). */
  async publish(opts: { force?: boolean } = {}): Promise<PublishReport> {
    let conflicts = 0;
    const orphans = new Set<string>(this.st.get<string[]>('own:garbage') ?? []);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const pull = await this.pull();
      const b = this.build(pull);
      const report: PublishReport = {
        published: false, seq: pull.index?.seq ?? null, attempts: attempt, conflicts, packsWritten: b.writes.size,
        packsKept: b.kept, bytesUploaded: 0, filesDeleted: 0, ownDoc: b.ownDoc, pull,
      };
      if (!b.changed && !opts.force && pull.index) {
        await this.pushVault();
        return report;
      }
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
        await this.storage.put(INDEX_PATH, bytes, pull.etag ? { ifMatch: pull.etag, contentType: 'application/json' } : { ifNoneMatch: '*', contentType: 'application/json' });
        const back = await this.storage.get(INDEX_PATH);
        ok = !!back && bytesEqual(back.data, bytes);
        if (ok) {
          this.st.set('own:index', { text, etag: back!.etag, checkedAt: Date.now() } satisfies IndexState);
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
      this.st.set('own:anchor', indexAnchor(b.index));
      this.st.set('own:packs', b.cache);
      for (const [h, u] of b.docBytes) this.st.setBytes(`own:doc:${h}`, u);
      if (b.snapshot) {
        const docs = b.index.packs.filter((p) => b.cache[p.hash]?.k === 'own-doc').map((p) => p.hash).sort();
        this.st.set('own:remote', { set: fingerprint(docs), snapshot: b64(b.snapshot) });
      }
      const listed = new Set(b.index.packs.map((p) => p.file));
      const last = this.st.get<string[]>('own:published') ?? [];
      const garbage = [...new Set([...b.drop, ...last, ...orphans])].filter((f) => !listed.has(f));
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
    const prev = pull.index;
    const repo = this.store.repo;
    const now = this.now();
    const newId = this.o.newId ?? randomLogicalId;
    const cache: Record<string, PackInfo> = { ...this.packs() };
    const missing = new Set(pull.missing);
    const listed = (prev?.packs ?? []).filter((p) => p.file.startsWith('packs/') && !missing.has(p.file));
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
    for (const p of listed) {
      const i = infoOf(p);
      if (i?.k === 'places') {
        if (i.rot === this.rot) existing.push({ id: i.id, fp: fps[i.id] ?? null, items: i.items, file: p.file });
        else drop.push(p.file);
      } else if (!i || i.k === 'other') drop.push(p.file);
    }
    const plan = planPacks(existing, desired, {
      capacity: this.o.capacity ?? 200,
      blur: this.o.blur ?? true,
      newId,
      ...(this.o.random && { random: this.o.random }),
    });
    drop.push(...plan.drop);

    const writes = new Map<string, Uint8Array>();
    const entries: IndexPackEntry[] = [];
    const keptFiles = new Set(plan.keep.map((p) => p.file));
    for (const p of listed) if (keptFiles.has(p.file)) entries.push(p);
    const add = (bytes: Uint8Array, info: PackInfo) => {
      const e = packEntry(bytes);
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

    // Media files (photos) listed by another device are kept as they are.
    for (const p of prev?.packs ?? []) if (p.file.startsWith('media/')) entries.push(p);

    // Public lists (plaintext).
    const publicFile = buildPublicLists(repo, items, { owner: this.owner, ...(this.o.author && { author: this.o.author }) });
    const pub = publicFile ? publicEntry(publicFile, PUBLIC_LISTS_NAME) : undefined;
    const publicChanged = (pub?.hash ?? null) !== (prev?.public?.hash ?? null);

    entries.sort((a, b) => (a.hash < b.hash ? -1 : 1));
    const anchor = this.anchor();
    const previous = pull.rolledBack || !prev ? anchor : prev;
    const seq = (previous?.seq ?? 0) + 1;
    const index = signIndex(this.device, {
      seq,
      sharingCert: this.sharing.cert,
      packs: entries,
      vaultDataKey: this.sharing.vaultDataKey,
      invitations: this.book.invitations().map((i) => i.invitation),
      ...(pub && { public: pub }),
      ...(previous && { previous }),
      now,
    });
    const changed =
      writes.size > 0 || drop.length > 0 || publicChanged || !prev || pull.rolledBack || pull.forked || missing.size > 0 ||
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

function laterAnchor(a: IndexAnchor | undefined, b: IndexAnchor): IndexAnchor {
  if (!a) return b;
  if (b.sharing_cert.rotation !== a.sharing_cert.rotation) return b.sharing_cert.rotation > a.sharing_cert.rotation ? b : a;
  return b.seq >= a.seq ? b : a;
}
