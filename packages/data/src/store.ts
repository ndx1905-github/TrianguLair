// SPDX-License-Identifier: MPL-2.0
/**
 * DataStore: the user's data on one device. Edits go through the Automerge
 * document; each change is appended to SQLite (`doc_chunks`) and projected
 * into the tables, in one transaction. Reads go to the repository.
 */
import * as A from '@automerge/automerge';
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
  type MediaInput,
  type SaveInput,
  type SavePatch,
  type TagInput,
} from './crdt/doc.ts';
import { projectAll, projectChanges, saveIdFor } from './crdt/project.ts';
import { Repository } from './sqlite/repository.ts';
import type { Capabilities } from './sqlite/schema.ts';
import type { ListFilter, ListVisibility, PlaceSnapshot } from './types.ts';

export interface OpenStoreOptions {
  driver: SqlDriver;
  /** My identity (public key); owner of everything in the document. */
  meId: string;
  meDisplayName?: string;
  /** Automerge actor of this device (hex). Random by default; keep it stable per device. */
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
export const PROJECTION_VERSION = 1;

/** Above this many bytes of missing changes, merge by reloading (much faster than applying ops one by one). */
const LARGE_MERGE_BYTES = 256 * 1024;

export class DataStore {
  readonly repo: Repository;
  private _doc: A.Doc<DataDoc> | null;
  private readonly actor: string | undefined;
  private readonly ctx: EditContext;
  private readonly compactEvery: number;
  private chunks = 0;

  private constructor(
    repo: Repository,
    doc: A.Doc<DataDoc> | null,
    actor: string | undefined,
    ctx: EditContext,
    compactEvery: number,
  ) {
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
    repo.transaction(() => {
      if (count === 0) {
        const doc = createDataDoc(options.actor);
        db.run(`INSERT INTO doc_chunks (kind, bytes) VALUES ('snapshot', ?)`, [A.save(doc)]);
        store._doc = doc;
      }
      const meta = (key: string) => db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key])?.value;
      const heads = meta('projected_heads');
      if (count === 0 || meta('projection_version') !== String(PROJECTION_VERSION)) {
        projectAll(store.doc, repo);
        store.recordHeads();
      } else if (!heads) {
        // Projection state lost (repair, or a write outside DataStore): load and rebuild.
        store.catchUpProjection(null);
        store.recordHeads();
      }
      // Otherwise the projection is current: chunks and projected heads are
      // always written in the same transaction. The document stays unloaded.
    });
    return store;
  }

  private loadDoc(): A.Doc<DataDoc> {
    const rows = this.repo.db.all<{ kind: string; bytes: Uint8Array }>(`SELECT kind, bytes FROM doc_chunks ORDER BY seq`);
    const [first, ...rest] = rows;
    if (!first || first.kind !== 'snapshot') throw new Error('document storage does not start with a snapshot');
    // One load of all chunks concatenated (faster than loading them one by one).
    return loadDataDoc(concat(rows.map((r) => new Uint8Array(r.bytes))), this.actor);
  }

  private catchUpProjection(heads: A.Heads | null): void {
    const doc = this.doc;
    if (heads && sameHeads(heads, A.getHeads(doc))) return;
    if (heads && heads.length > 0 && A.hasHeads(doc, heads)) projectChanges(doc, this.repo, heads);
    else projectAll(doc, this.repo);
  }

  private recordHeads(): void {
    const set = `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
    this.repo.db.run(set, ['projected_heads', JSON.stringify(A.getHeads(this.doc))]);
    this.repo.db.run(set, ['projection_version', String(PROJECTION_VERSION)]);
  }

  /** The current document (immutable snapshot), loaded on first use. */
  get doc(): A.Doc<DataDoc> {
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

  /** Stores and projects a new document state reached from the current one. */
  private commit(next: A.Doc<DataDoc>, full = false): void {
    const before = A.getHeads(this.doc);
    if (sameHeads(before, A.getHeads(next))) return;
    const chunk = A.saveSince(next, before);
    this.repo.transaction(() => {
      this.repo.db.run(`INSERT INTO doc_chunks (kind, bytes) VALUES ('incremental', ?)`, [chunk]);
      // After a large merge, a full projection is cheaper than computing the diff.
      if (full) projectAll(next, this.repo);
      else projectChanges(next, this.repo, before);
      this._doc = next;
      this.recordHeads();
    });
    this.chunks++;
    if (this.chunks >= this.compactEvery) this.compact();
  }

  /**
   * One atomic edit (one Automerge change, one SQLite transaction). Several
   * operations in `fn` are applied together:
   *
   *   store.change(tx => { const id = tx.createTag({ name: 'Pizza' }); tx.addSaveTag(placeId, id); });
   *
   * For a large import, prefer batches of a few hundred saves per change.
   */
  change<T>(fn: (tx: DocTx) => T, message?: string): T {
    let out!: T;
    const next = A.change(this.doc, message ? { message, time: Math.floor(this.ctx.now() / 1000) } : {}, (d) => {
      out = fn(new DocTx(d, this.ctx));
    });
    this.commit(next);
    return out;
  }

  /** Merges another replica of my document (another device), then heals and projects. */
  merge(remote: Uint8Array | A.Doc<DataDoc>): void {
    const local = this.doc;
    const reload = (bytes: Uint8Array) =>
      loadDataDoc(concat([A.save(local), bytes]), A.getActorId(local));
    let next: A.Doc<DataDoc>;
    let large = false;
    if (remote instanceof Uint8Array && remote.byteLength > LARGE_MERGE_BYTES / 4) {
      next = reload(remote); // saved documents are compressed (~4x)
      large = true;
    } else {
      const other = remote instanceof Uint8Array ? loadDataDoc(remote) : remote;
      const missing = A.getChanges(local, other);
      if (missing.length === 0) return;
      large = missing.reduce((n, c) => n + c.byteLength, 0) > LARGE_MERGE_BYTES;
      next = large ? reload(A.save(other)) : A.merge(A.clone(local), other);
    }
    next = healDoc(next);
    this.commit(next, large);
  }

  /** Changes since `heads` (to send to another device); full document without argument. */
  exportDoc(sinceHeads?: A.Heads): Uint8Array {
    return sinceHeads ? A.saveSince(this.doc, sinceHeads) : A.save(this.doc);
  }

  /** Applies changes exported by another device with `exportDoc(heads)`. */
  importChanges(bytes: Uint8Array): void {
    const local = this.doc;
    const large = bytes.byteLength > LARGE_MERGE_BYTES / 4;
    let next = large
      ? loadDataDoc(concat([A.save(local), bytes]), A.getActorId(local))
      : A.loadIncremental(A.clone(local), bytes);
    next = healDoc(next);
    this.commit(next, large);
  }

  heads(): A.Heads {
    return A.getHeads(this.doc);
  }

  /** Replaces the stored chunks by one snapshot. */
  compact(): void {
    const bytes = A.save(this.doc);
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
    this.repo.db.close();
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
  removeMedia(placeId: string, mediaId: string): void {
    this.change((tx) => tx.removeMedia(placeId, mediaId));
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
  updateList(id: string, patch: { name?: string; description?: string; visibility?: ListVisibility; linkKey?: string | null }): void {
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
  purgeTrash(): number {
    return this.change((tx) => tx.purgeTrash());
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function sameHeads(a: A.Heads, b: A.Heads): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((h, i) => h === sb[i]);
}
