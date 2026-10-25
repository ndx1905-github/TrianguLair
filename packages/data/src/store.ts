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

export class DataStore {
  readonly repo: Repository;
  private _doc: A.Doc<DataDoc>;
  private readonly ctx: EditContext;
  private readonly compactEvery: number;
  private chunks = 0;

  private constructor(repo: Repository, doc: A.Doc<DataDoc>, ctx: EditContext, compactEvery: number) {
    this.repo = repo;
    this._doc = doc;
    this.ctx = ctx;
    this.compactEvery = compactEvery;
  }

  /** Opens (or creates) the store in this database and brings the projection up to date. */
  static open(options: OpenStoreOptions): DataStore {
    const repo = Repository.open(options.driver, {
      meId: options.meId,
      ...(options.meDisplayName !== undefined && { meDisplayName: options.meDisplayName }),
      ...(options.disable && { disable: options.disable }),
    });
    const db = options.driver;
    const rows = db.all<{ kind: string; bytes: Uint8Array }>(`SELECT kind, bytes FROM doc_chunks ORDER BY seq`);
    let doc: A.Doc<DataDoc>;
    if (rows.length === 0) {
      doc = createDataDoc(options.actor);
    } else {
      const [first, ...rest] = rows;
      if (first!.kind !== 'snapshot') throw new Error('document storage does not start with a snapshot');
      doc = loadDataDoc(new Uint8Array(first!.bytes), options.actor);
      for (const r of rest) doc = A.loadIncremental(doc, new Uint8Array(r.bytes));
    }
    const ctx: EditContext = { now: options.now ?? (() => Date.now()), newId: options.newId ?? randomId };
    const store = new DataStore(repo, doc, ctx, options.compactEvery ?? 200);
    store.chunks = Math.max(0, rows.length - 1);
    repo.transaction(() => {
      if (rows.length === 0) db.run(`INSERT INTO doc_chunks (kind, bytes) VALUES ('snapshot', ?)`, [A.save(doc)]);
      store.catchUpProjection();
    });
    return store;
  }

  private catchUpProjection(): void {
    const row = this.repo.db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'projected_heads'`);
    const heads = row ? (JSON.parse(row.value) as A.Heads) : null;
    const now = A.getHeads(this._doc);
    if (heads && sameHeads(heads, now)) return;
    if (heads && heads.length > 0 && A.hasHeads(this._doc, heads)) projectChanges(this._doc, this.repo, heads);
    else projectAll(this._doc, this.repo);
    this.recordHeads();
  }

  private recordHeads(): void {
    this.repo.db.run(
      `INSERT INTO meta (key, value) VALUES ('projected_heads', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(A.getHeads(this._doc))],
    );
  }

  /** The current document (immutable snapshot). */
  get doc(): A.Doc<DataDoc> {
    return this._doc;
  }

  get meId(): string {
    return this.repo.meId;
  }

  /** SQLite id of my save on a place. */
  saveId(placeId: string): string {
    return saveIdFor(this.repo.meId, placeId);
  }

  /** Stores and projects a new document state reached from the current one. */
  private commit(next: A.Doc<DataDoc>): void {
    const before = A.getHeads(this._doc);
    if (sameHeads(before, A.getHeads(next))) return;
    const chunk = A.saveSince(next, before);
    this.repo.transaction(() => {
      this.repo.db.run(`INSERT INTO doc_chunks (kind, bytes) VALUES ('incremental', ?)`, [chunk]);
      projectChanges(next, this.repo, before);
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
   */
  change<T>(fn: (tx: DocTx) => T, message?: string): T {
    let out!: T;
    const next = A.change(this._doc, message ? { message, time: Math.floor(this.ctx.now() / 1000) } : {}, (d) => {
      out = fn(new DocTx(d, this.ctx));
    });
    this.commit(next);
    return out;
  }

  /** Merges another replica of my document (another device), then heals and projects. */
  merge(remote: Uint8Array | A.Doc<DataDoc>): void {
    const other = remote instanceof Uint8Array ? loadDataDoc(remote) : remote;
    let next = A.merge(A.clone(this._doc), other);
    next = healDoc(next);
    this.commit(next);
  }

  /** Changes since `heads` (to send to another device); full document without argument. */
  exportDoc(sinceHeads?: A.Heads): Uint8Array {
    return sinceHeads ? A.saveSince(this._doc, sinceHeads) : A.save(this._doc);
  }

  /** Applies changes exported by another device with `exportDoc(heads)`. */
  importChanges(bytes: Uint8Array): void {
    let next = A.loadIncremental(A.clone(this._doc), bytes);
    next = healDoc(next);
    this.commit(next);
  }

  heads(): A.Heads {
    return A.getHeads(this._doc);
  }

  /** Replaces the stored chunks by one snapshot. */
  compact(): void {
    const bytes = A.save(this._doc);
    this.repo.transaction(() => {
      this.repo.db.run(`DELETE FROM doc_chunks`);
      this.repo.db.run(`INSERT INTO doc_chunks (kind, bytes) VALUES ('snapshot', ?)`, [bytes]);
    });
    this.chunks = 0;
  }

  /** Rebuilds the whole projection from the document (repair tool). */
  reproject(): void {
    this.repo.transaction(() => {
      projectAll(this._doc, this.repo);
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

function sameHeads(a: A.Heads, b: A.Heads): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((h, i) => h === sb[i]);
}
