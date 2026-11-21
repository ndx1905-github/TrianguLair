// SPDX-License-Identifier: MPL-2.0
/**
 * DataStore: the user's data on one device. Edits go through the Yjs
 * document; each change's update is appended to SQLite (`doc_chunks`) and
 * projected into the tables, in one transaction. Reads go to the repository.
 */
import * as Y from 'yjs';
import type { SqlDriver } from './driver/types.ts';
import { randomId, type IdGenerator } from './ids.ts';
import type { PlaceSnapshotInput } from './place.ts';
import {
  createDataDoc,
  DocTx,
  healDoc,
  loadDataDoc,
  type DataDoc,
  type EditContext,
  type ListInput,
  type ListPatch,
  type MediaInput,
  type MediaUpload,
  type SaveInput,
  type SavePatch,
  type TagInput,
  type TrashItemRef,
} from './crdt/doc.ts';
import { emptyTouched, projectAll, projectChanges, saveIdFor, trackChanges, type Touched } from './crdt/project.ts';
import { Repository } from './sqlite/repository.ts';
import type { Capabilities } from './sqlite/schema.ts';
import type { ListFilter, PlaceSnapshot } from './types.ts';

export interface OpenStoreOptions {
  driver: SqlDriver;
  /** My identity (public key); owner of everything in the document. */
  meId: string;
  meDisplayName?: string;
  /**
   * Stable per-device actor (any string), hashed to this device's Yjs client
   * id. Random per session by default. Never open the same database twice at
   * once with the same actor.
   */
  actor?: string;
  /** Clock (ms). Injected for tests. */
  now?: () => number;
  newId?: IdGenerator;
  /** Force SQLite modules off (fallback tests). */
  disable?: readonly (keyof Capabilities)[];
  /** Write a full snapshot after this many incremental chunks (default 200). */
  compactEvery?: number;
}

/** Bump when the projection code changes in a way that needs a rebuild. */
export const PROJECTION_VERSION = 3;

/** Encoding of the chunks in `doc_chunks` (recorded in `meta.doc_format`). */
export const DOC_FORMAT = 'yjs-update-v1';

/**
 * Encoded snapshot (`DataStore.snapshot` format) of the document that these
 * Yjs updates make together, without touching any store: used by the sync
 * step to know what the storage holds.
 */
export function snapshotOfUpdates(updates: readonly Uint8Array[]): Uint8Array {
  const doc = new Y.Doc();
  try {
    doc.transact(() => {
      for (const u of updates) Y.applyUpdate(doc, u);
    });
    return Y.encodeSnapshot(Y.snapshot(doc));
  } finally {
    doc.destroy();
  }
}

/** Above this many touched saves, re-project everything (cheaper than row-by-row diffs). */
const FULL_PROJECTION_SAVES = 2000;

export class DataStore {
  readonly repo: Repository;
  private _doc: DataDoc | null;
  private readonly actor: string | undefined;
  private readonly ctx: EditContext;
  private readonly compactEvery: number;
  private chunks = 0;

  private constructor(repo: Repository, doc: DataDoc | null, actor: string | undefined, ctx: EditContext, compactEvery: number) {
    this.repo = repo;
    this._doc = doc;
    this.actor = actor;
    this.ctx = ctx;
    this.compactEvery = compactEvery;
  }

  /**
   * Opens (or creates) the store in this database. When the projection is
   * up to date (the normal case: chunks and projection are written in the
   * same transaction), the document is not loaded until it is needed, so the
   * map can be drawn from SQLite right away (spec: launch under 2 s).
   */
  static open(options: OpenStoreOptions): DataStore {
    const repo = Repository.open(options.driver, {
      meId: options.meId,
      ...(options.meDisplayName !== undefined && { meDisplayName: options.meDisplayName }),
      ...(options.disable && { disable: options.disable }),
    });
    const ctx: EditContext = { now: options.now ?? (() => Date.now()), newId: options.newId ?? randomId };
    const store = new DataStore(repo, null, options.actor, ctx, options.compactEvery ?? 200);
    const db = options.driver;
    const count = db.get<{ n: number }>(`SELECT count(*) AS n FROM doc_chunks`)!.n;
    store.chunks = Math.max(0, count - 1);
    const meta = (key: string) => db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key])?.value;
    if (count > 0 && meta('doc_format') !== DOC_FORMAT) {
      throw new Error(`the document in this database is stored as ${meta('doc_format') ?? 'an older format'}, not ${DOC_FORMAT}`);
    }
    repo.transaction(() => {
      if (count === 0) {
        const doc = createDataDoc(options.actor);
        db.run(`INSERT INTO doc_chunks (kind, bytes) VALUES ('snapshot', ?)`, [Y.encodeStateAsUpdate(doc)]);
        store.setMeta('doc_format', DOC_FORMAT);
        store._doc = doc;
      }
      if (count === 0 || meta('projection_version') !== String(PROJECTION_VERSION) || !meta('projected_heads')) {
        // New store, new projection code, or projection state lost (repair,
        // or a write outside DataStore): load the document and rebuild.
        projectAll(store.doc, repo);
        store.recordHeads();
      }
      // Otherwise the projection is current: chunks and projected heads are
      // always written in the same transaction. The document stays unloaded.
    });
    return store;
  }

  private loadDoc(): DataDoc {
    const rows = this.repo.db.all<{ kind: string; bytes: Uint8Array }>(`SELECT kind, bytes FROM doc_chunks ORDER BY seq`);
    if (rows[0]?.kind !== 'snapshot') throw new Error('document storage does not start with a snapshot');
    // One Yjs transaction applying every chunk (Yjs updates are commutative and idempotent).
    return loadDataDoc(rows.map((r) => new Uint8Array(r.bytes)), this.actor);
  }

  private setMeta(key: string, value: string): void {
    this.repo.db.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, value]);
  }

  private recordHeads(): void {
    // The state vector marks which projection is current; a missing value triggers a rebuild on open.
    this.setMeta('projected_heads', JSON.stringify([...Y.decodeStateVector(Y.encodeStateVector(this.doc))].sort((a, b) => a[0] - b[0])));
    this.setMeta('projection_version', String(PROJECTION_VERSION));
  }

  /** The current document (a live Yjs document), loaded on first use. Edit it only through `change`. */
  get doc(): DataDoc {
    if (!this._doc) this._doc = this.loadDoc();
    return this._doc;
  }

  /** Whether the document has been loaded (it is loaded lazily). */
  get docLoaded(): boolean {
    return this._doc !== null;
  }

  get meId(): string {
    return this.repo.meId;
  }

  /** SQLite id of my save on a place. */
  saveId(placeId: string): string {
    return saveIdFor(this.repo.meId, placeId);
  }

  /**
   * Runs `fn` on the document, collecting the Yjs updates it produced and
   * what it touched, then stores and projects them in one SQLite
   * transaction. On any error the in-memory replica is dropped and reloaded
   * from SQLite on next use (Yjs has no rollback; SQLite does).
   */
  private apply<T>(fn: (doc: DataDoc) => T, extra: Uint8Array[] = []): T {
    const doc = this.doc;
    const updates: Uint8Array[] = [];
    const onUpdate = (u: Uint8Array) => updates.push(u);
    doc.on('update', onUpdate);
    let out: { result: T; touched: Touched };
    try {
      out = trackChanges(doc, () => fn(doc), emptyTouched());
    } catch (e) {
      if (updates.length) this._doc = null;
      throw e;
    } finally {
      doc.off('update', onUpdate);
    }
    const chunks = [...updates, ...extra];
    if (chunks.length === 0) return out.result;
    const chunk = chunks.length === 1 ? chunks[0]! : Y.mergeUpdates(chunks);
    try {
      this.repo.transaction(() => {
        this.repo.db.run(`INSERT INTO doc_chunks (kind, bytes) VALUES ('incremental', ?)`, [chunk]);
        if (out.touched.saves.size > FULL_PROJECTION_SAVES) projectAll(doc, this.repo);
        else projectChanges(doc, this.repo, out.touched);
        this.recordHeads();
      });
    } catch (e) {
      this._doc = null;
      throw e;
    }
    this.chunks++;
    if (this.chunks >= this.compactEvery) this.compact();
    return out.result;
  }

  /**
   * One atomic edit (one Yjs transaction, one SQLite transaction). Several
   * operations in `fn` are applied together:
   *
   *   store.change(tx => { const id = tx.createTag({ name: 'Pizza' }); tx.addSaveTag(placeId, id); });
   *
   * For a large import, prefer batches of a few hundred saves per change.
   */
  change<T>(fn: (tx: DocTx) => T, message?: string): T {
    // `message` becomes the Yjs transaction origin (local only; Yjs updates carry no message).
    return this.apply((doc) => doc.transact(() => fn(new DocTx(doc, this.ctx)), message ?? 'local'));
  }

  /**
   * Merges another replica of my document (another device): a Yjs update
   * (`exportDoc()` of the other device, full or since my state vector) or a
   * live Y.Doc. Then heals and projects.
   */
  merge(remote: Uint8Array | DataDoc): void {
    const local = this.doc;
    const update = remote instanceof Uint8Array ? remote : Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local));
    this.importChanges(update);
  }

  /** Changes this device has that a device at `sinceStateVector` lacks; full document without argument. */
  exportDoc(sinceStateVector?: Uint8Array): Uint8Array {
    return sinceStateVector ? Y.encodeStateAsUpdate(this.doc, sinceStateVector) : Y.encodeStateAsUpdate(this.doc);
  }

  /** Applies a Yjs update exported by another device with `exportDoc(stateVector)`. */
  importChanges(bytes: Uint8Array): void {
    const doc = this.doc;
    const extra: Uint8Array[] = [];
    this.apply(() => {
      Y.applyUpdate(doc, bytes, 'remote');
      // Structs waiting for missing dependencies are not in the update event; keep the raw bytes for them.
      if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) extra.push(bytes);
      healDoc(doc);
    }, extra);
  }

  /** My state vector (what I have), to ask another device for what I miss. Replaces Automerge heads. */
  heads(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /**
   * Encoded Yjs snapshot (state vector and delete set) of the document. The
   * sync step (T-204) compares it with the snapshot of what the storage holds
   * (`snapshotOfUpdates`) to know whether there is anything left to publish.
   */
  snapshot(): Uint8Array {
    return Y.encodeSnapshot(Y.snapshot(this.doc));
  }

  /** Whether the document is exactly at `snapshot` (same state vector, same deletions). */
  isAt(snapshot: Uint8Array): boolean {
    return Y.equalSnapshots(Y.snapshot(this.doc), Y.decodeSnapshot(snapshot));
  }

  /**
   * Everything the document has beyond the state vector of `snapshot`, with
   * the whole delete set (deletions are not covered by a state vector).
   */
  exportSince(snapshot: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(Y.decodeSnapshot(snapshot).sv));
  }

  /** Replaces the stored chunks by one snapshot (`Y.encodeStateAsUpdate`). */
  compact(): void {
    const bytes = Y.encodeStateAsUpdate(this.doc);
    this.repo.transaction(() => {
      this.repo.db.run(`DELETE FROM doc_chunks`);
      this.repo.db.run(`INSERT INTO doc_chunks (kind, bytes) VALUES ('snapshot', ?)`, [bytes]);
    });
    this.chunks = 0;
  }

  /** Rebuilds the whole projection from the document (repair tool). */
  reproject(): void {
    this.repo.transaction(() => {
      projectAll(this.doc, this.repo);
      this.recordHeads();
    });
  }

  close(): void {
    this._doc?.destroy();
    this.repo.db.close();
  }

  /**
   * Erases every row of this database (my document, its projection, friends'
   * cache, people, lists) and closes the store: the remote wipe of a device
   * declared lost (spec "Loss and theft"). Best effort on the file itself
   * (`secure_delete`, then VACUUM); the app also deletes the database key,
   * which is what makes the file unreadable at once.
   */
  wipe(): void {
    const db = this.repo.db;
    const tables = db
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'`)
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_') && !/_(data|idx|content|docsize|config|node|parent|rowid)$/.test(n));
    try {
      db.exec('PRAGMA secure_delete = ON');
    } catch {
      // not supported by this build: VACUUM below still rewrites the file
    }
    db.exec('PRAGMA foreign_keys = OFF');
    db.transaction(() => {
      for (const t of tables) {
        if (t === 'meta') db.run(`DELETE FROM meta WHERE key <> 'capabilities'`);
        else db.run(`DELETE FROM "${t.replace(/"/g, '""')}"`);
      }
    });
    try {
      db.exec('VACUUM');
    } catch {
      // inside an outer transaction (tests): the rows are gone anyway
    }
    this._doc?.destroy();
    this._doc = null;
    db.close();
  }

  // ---------------------------------------------------------------- convenience edits

  putSave(input: SaveInput): string {
    return this.change((tx) => tx.putSave(input));
  }
  updateSave(placeId: string, patch: SavePatch): void {
    this.change((tx) => tx.updateSave(placeId, patch));
  }
  setSaveTags(placeId: string, tagIds: readonly string[], mainTagId?: string | null): void {
    this.change((tx) => tx.setSaveTags(placeId, tagIds, mainTagId));
  }
  addSaveTag(placeId: string, tagId: string): void {
    this.change((tx) => tx.addSaveTag(placeId, tagId));
  }
  removeSaveTag(placeId: string, tagId: string): void {
    this.change((tx) => tx.removeSaveTag(placeId, tagId));
  }
  deleteSave(placeId: string): void {
    this.change((tx) => tx.deleteSave(placeId));
  }
  restoreSave(placeId: string): void {
    this.change((tx) => tx.restoreSave(placeId));
  }
  addMedia(placeId: string, media: MediaInput): string {
    return this.change((tx) => tx.addMedia(placeId, media));
  }
  removeMedia(placeId: string, mediaId: string, opts: { quiet?: boolean } = {}): void {
    this.change((tx) => tx.removeMedia(placeId, mediaId, opts));
  }
  setMediaUpload(placeId: string, mediaId: string, upload: MediaUpload | null): void {
    this.change((tx) => tx.setMediaUpload(placeId, mediaId, upload));
  }
  relinkSave(fromPlaceId: string, to: PlaceSnapshotInput | PlaceSnapshot): string {
    return this.change((tx) => tx.relinkSave(fromPlaceId, to));
  }
  createTag(input: TagInput): string {
    return this.change((tx) => tx.createTag(input));
  }
  updateTag(id: string, patch: Partial<TagInput>): void {
    this.change((tx) => tx.updateTag(id, patch));
  }
  deleteTag(id: string): void {
    this.change((tx) => tx.deleteTag(id));
  }
  restoreTag(id: string): void {
    this.change((tx) => tx.restoreTag(id));
  }
  setTagMapping(personId: string, theirTag: string, myTagId: string | null): void {
    this.change((tx) => tx.setTagMapping(personId, theirTag, myTagId));
  }
  createList(input: ListInput): string {
    return this.change((tx) => tx.createList(input));
  }
  updateList(id: string, patch: ListPatch): void {
    this.change((tx) => tx.updateList(id, patch));
  }
  setListFilter(id: string, filter: ListFilter): void {
    this.change((tx) => tx.setListFilter(id, filter));
  }
  addToList(id: string, placeId: string): void {
    this.change((tx) => tx.addToList(id, placeId));
  }
  removeFromList(id: string, placeId: string): void {
    this.change((tx) => tx.removeFromList(id, placeId));
  }
  deleteList(id: string): void {
    this.change((tx) => tx.deleteList(id));
  }
  restoreList(id: string): void {
    this.change((tx) => tx.restoreList(id));
  }
  /** Purges the trash (items older than 30 days); with `only`, that one item now ("Delete forever"). */
  purgeTrash(only?: TrashItemRef): number {
    return this.change((tx) => tx.purgeTrash(only));
  }
}
