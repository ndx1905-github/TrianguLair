// SPDX-License-Identifier: MPL-2.0
/**
 * Following a list by its link, without being the author's contact (spec "Following a list
 * without following the person"): no key exchange, no request, no consent. The link (lists.ts)
 * names the author, their certified read address and either the list key (link-only) or the list
 * id (public). Reading is done directly at the author's storage, like a friend's read:
 *
 * 1. the author's index, verified against the master key named in the link, at the address it
 *    was read from (a master-signed redirect is followed once, only to the address it certifies),
 *    and, after the first read, against the last index accepted for this list (rollback, fork);
 * 2. link-only: every `packs/` file not seen yet is tried with the list key pair only (my own
 *    keys are never used here); the readable lists packs give the definition and the places;
 *    a tombstone means "This list no longer exists", nothing readable means "This link no longer
 *    works" (a new link was made, or the author stopped sharing it);
 *    public: `public/lists.geojson`, checked against the hash in the index, filtered by list id
 *    (no such list any more: "This list no longer exists");
 * 3. the places go to my cache as foreign saves of the followed list (owner = its followed-list
 *    id, `list:…`), so they show like friends' places, never mix with a friend's own cache, and
 *    leave when the list is gone or unfollowed. The difference feeds What's new.
 *
 * Nothing about the reader is ever written to the author's storage: they do not know who follows
 * (the host sees the reader's IP address, as for any web page).
 */
import {
  DecryptionError,
  StorageMovedError,
  indexAnchor,
  openPack,
  verifyIndex,
  verifyPublicFile,
  type IndexAnchor,
  type KeyPair,
  type SignedIndex,
} from '@triangulair/crypto';
import { saveIdFor, type DataStore } from '@triangulair/data';
import { NotFound, fetchHighestIndex, indexPath, type StorageAdapter } from '@triangulair/storage';
import { classifyError, type SyncProblem } from './errors.ts';
import { toForeignSave, type PlaceFeature } from './features.ts';
import {
  followIdOf,
  isTombstone,
  listKeyPair,
  listsReady,
  parseListLinkFragment,
  parseLists,
  parsePublicList,
  type ListDef,
  type ListLink,
} from './lists.ts';
import { resolveLimits, type SyncLimits } from './limits.ts';
import { decodePayload } from './payload.ts';
import { READ_MAJORS, prunePlaces, type WhatsNew } from './reader.ts';
import type { SyncStateStore } from './state.ts';
import { ByteBudget, Semaphore, mapLimit } from './util.ts';

/** Why a followed list shows nothing: "This list no longer exists" / "This link no longer works". */
export type ListGone = 'deleted' | 'link-dead';

export class ListGoneError extends Error {
  constructor(readonly gone: ListGone) {
    super(gone === 'deleted' ? 'This list no longer exists' : 'This link no longer works');
    this.name = 'ListGoneError';
  }
}

export interface ListMeta {
  id: string;
  /** The author's list id. */
  listId: string;
  kind: 'link' | 'public';
  owner: string;
  location: string;
  name: string;
  description?: string;
  /** The list's own date (ISO), when known. */
  updated?: string;
  author?: string;
  count: number;
}

export interface ListPreview extends ListMeta {
  features: PlaceFeature[];
}

export interface ListReport {
  id: string;
  status: 'unchanged' | 'updated' | 'gone' | 'error';
  gone?: ListGone;
  whatsNew: WhatsNew;
  problem?: SyncProblem;
}

export interface FollowedListInfo {
  id: string;
  /** The link fragment (it holds the key of a link-only list: never show it outside the app). */
  link: string;
  kind: 'link' | 'public';
  owner: string;
  location: string;
  name: string;
  description?: string;
  updated?: string;
  author?: string;
  count: number;
  gone: ListGone | null;
  lastSuccess: number | null;
  lastError: number | null;
}

interface PackSeen {
  notFor?: true;
  /** Readable lists pack: its entries and its places (place id → feature hash). */
  lists?: (ListDef | { id: string; deleted: true })[];
  items?: Record<string, string>;
  author?: string;
}

interface ListState {
  location: string;
  etag: string | null;
  path: string;
  hash: string | null;
  checkedAt: number;
  anchor: IndexAnchor | null;
  packs: Record<string, PackSeen>;
  /** place id → [feature hash, pack hash or "public"]. */
  items: Record<string, [string, string]>;
  meta: { listId: string; name: string; description?: string; updated?: string; author?: string } | null;
  gone: ListGone | null;
  lastSuccess: number | null;
  lastError: number | null;
}

export interface ListReaderOptions {
  store: DataStore;
  state: SyncStateStore;
  readAdapter: (location: string) => StorageAdapter;
  concurrency?: number;
  fullCheckMs?: number;
  now?: () => Date;
  limits?: Partial<SyncLimits>;
}

const empty = (): WhatsNew => ({ added: [], changed: [], removed: [] });

interface Fetched {
  index: SignedIndex;
  location: string;
  etag: string | null;
  path: string;
  hash: string;
  /** Unchanged index: nothing else read. */
  unchanged: boolean;
  /** The index was downloaded (not only a HEAD). */
  full: boolean;
  packs: Record<string, PackSeen>;
  features: Map<string, PlaceFeature>;
  /** place id → [hash, source]. */
  items: Record<string, [string, string]>;
  meta: ListState['meta'];
  gone: ListGone | null;
}

export class ListReader {
  readonly limits: SyncLimits;
  private readonly slots: Semaphore;
  constructor(private readonly o: ListReaderOptions) {
    this.limits = resolveLimits(o.limits);
    this.slots = new Semaphore(o.concurrency ?? 6);
  }

  private nowMs(): number {
    return (this.o.now?.() ?? new Date()).getTime();
  }
  private key(id: string): string {
    return `follow:${id}`;
  }
  private stateOf(id: string): ListState | undefined {
    return this.o.state.get<ListState>(this.key(id));
  }

  /** Followed-list ids that have local state (read at least once). */
  known(): string[] {
    return this.o.state.keys('follow:').map((k) => k.slice('follow:'.length));
  }

  info(id: string, link: string): FollowedListInfo {
    const l = parseListLinkFragment(link);
    const st = this.stateOf(id);
    return {
      id,
      link,
      kind: l.kind,
      owner: l.owner,
      location: st?.location ?? l.location,
      name: st?.meta?.name ?? '',
      ...(st?.meta?.description && { description: st.meta.description }),
      ...(st?.meta?.updated && { updated: st.meta.updated }),
      ...(st?.meta?.author && { author: st.meta.author }),
      count: st ? Object.keys(st.items).length : 0,
      gone: st?.gone ?? null,
      lastSuccess: st?.lastSuccess ?? null,
      lastError: st?.lastError ?? null,
    };
  }

  /** Reads a list from its link without following it (the preview before "Follow this list"). Throws ListGoneError. */
  async preview(fragment: string): Promise<ListPreview> {
    await listsReady();
    const link = parseListLinkFragment(fragment);
    const id = followIdOf(link);
    const f = await this.fetch(link, null, new ByteBudget(this.limits.friendReadBytes, 'read'));
    if (f.gone) throw new ListGoneError(f.gone);
    return {
      id,
      listId: f.meta!.listId,
      kind: link.kind,
      owner: link.owner,
      location: f.location,
      name: f.meta!.name,
      ...(f.meta!.description && { description: f.meta!.description }),
      ...(f.meta!.updated && { updated: f.meta!.updated }),
      ...(f.meta!.author && { author: f.meta!.author }),
      count: f.features.size,
      features: [...f.features.values()].sort((a, b) => (a.properties.name < b.properties.name ? -1 : 1)),
    };
  }

  /** Erases a followed list's places from my cache and its state (unfollowed). */
  forget(id: string): void {
    const repo = this.o.store.repo;
    const ids = repo.db.all<{ id: string; place_id: string }>(`SELECT id, place_id FROM saves WHERE owner_id = ?`, [id]);
    repo.transaction(() => {
      for (const r of ids) repo.deleteForeignSave(r.id);
      prunePlaces(this.o.store, ids.map((r) => r.place_id));
      repo.db.run(`DELETE FROM people WHERE id = ? AND is_me = 0`, [id]);
    });
    this.o.state.delete(this.key(id));
  }

  /** One followed list: refresh its places in my cache (or remove them when the list is gone). */
  async read(entry: { id: string; link: string }, opts: { pass?: ByteBudget } = {}): Promise<ListReport> {
    const report: ListReport = { id: entry.id, status: 'unchanged', whatsNew: empty() };
    const prev = this.stateOf(entry.id);
    try {
      await listsReady();
      const link = parseListLinkFragment(entry.link);
      if (followIdOf(link) !== entry.id) throw new Error('followed list: the link does not match its id');
      const budget = new ByteBudget(this.limits.friendReadBytes, 'read', opts.pass);
      const f = await this.fetch(link, prev ?? null, budget);
      const now = this.nowMs();
      if (f.unchanged && prev) {
        const anchor = f.full ? indexAnchor(f.index) : prev.anchor;
        this.o.state.set(this.key(entry.id), { ...prev, location: f.location, etag: f.etag ?? prev.etag, anchor, checkedAt: f.full ? now : prev.checkedAt, lastSuccess: now, lastError: null });
        if (prev.gone) {
          report.status = 'gone';
          report.gone = prev.gone;
        }
        return report;
      }
      const next = f.gone ? {} : f.items;
      const old = prev?.items ?? {};
      for (const [id, [h]] of Object.entries(next)) {
        if ((!old[id] || old[id]![0] !== h) && !f.features.get(id)) throw new Error(`followed list: ${id} changed but its pack was not read`);
      }
      const repo = this.o.store.repo;
      const wn = report.whatsNew;
      const owner = entry.id;
      repo.transaction(() => {
        if (f.meta) repo.upsertPerson({ id: owner, displayName: f.meta.name, publicKey: link.owner, readUrl: f.location });
        for (const [id, [h]] of Object.entries(next)) {
          const o = old[id];
          if (o && o[0] === h) continue;
          const input = toForeignSave(owner, f.features.get(id)!, now);
          const before = repo.getSave(saveIdFor(owner, id));
          repo.upsertForeignSave(input);
          if (!o || !before) wn.added.push(id);
          else {
            const fields: string[] = [];
            if (before.comment !== input.comment) fields.push('comment');
            if (before.status !== (input.status ?? null)) fields.push('status');
            if (fields.length === 0) fields.push('details');
            const meaningful = (fields.includes('comment') && !!input.comment) || (fields.includes('status') && (input.status === 'tried' || input.status === 'favorite'));
            wn.changed.push({ placeId: id, meaningful, fields });
          }
        }
        const removed: string[] = [];
        for (const id of Object.keys(old)) {
          if (next[id]) continue;
          repo.deleteForeignSave(saveIdFor(owner, id));
          wn.removed.push(id);
          removed.push(id);
        }
        prunePlaces(this.o.store, removed);
      });
      const st: ListState = {
        location: f.location,
        etag: f.etag,
        path: f.path,
        hash: f.hash,
        checkedAt: now,
        anchor: indexAnchor(f.index),
        packs: f.packs,
        items: next,
        meta: f.meta ?? prev?.meta ?? null,
        gone: f.gone,
        lastSuccess: now,
        lastError: null,
      };
      this.o.state.set(this.key(entry.id), st);
      if (f.gone) {
        report.status = 'gone';
        report.gone = f.gone;
      } else report.status = wn.added.length || wn.changed.length || wn.removed.length || !prev ? 'updated' : 'unchanged';
      return report;
    } catch (e) {
      if (prev) this.o.state.set(this.key(entry.id), { ...prev, lastError: this.nowMs() });
      report.status = 'error';
      report.problem = classifyError(e, 'friend');
      return report;
    }
  }

  async readAll(entries: readonly { id: string; link: string }[], concurrency = 8): Promise<ListReport[]> {
    const pass = new ByteBudget(this.limits.passBytes, 'pass');
    return mapLimit(entries, concurrency, (e) => this.read(e, { pass }));
  }

  // ------------------------------------------------------------------ fetching

  private async fetch(link: ListLink, prev: ListState | null, budget: ByteBudget): Promise<Fetched> {
    const L = this.limits;
    let location = prev?.location ?? link.location;
    let adapter = this.o.readAdapter(location);
    const fresh = !!prev && this.nowMs() - prev.checkedAt < (this.o.fullCheckMs ?? 600_000);
    let fi = await fetchHighestIndex(adapter, READ_MAJORS, fresh && prev.etag ? { [prev.path]: prev.etag } : {}, { maxBytes: L.indexBytes });
    const now = this.o.now?.();
    const verify = (bytes: Uint8Array, loc: string) =>
      verifyIndex(bytes, { expectedOwner: link.owner, location: loc, ...(prev?.anchor && { lastSeen: prev.anchor }), ...(now && { now }) });
    if (!fi.changed) {
      return { index: null as unknown as SignedIndex, location, etag: fi.etag, path: prev!.path, hash: prev!.hash ?? '', unchanged: true, full: false, packs: prev!.packs, features: new Map(), items: prev!.items, meta: prev!.meta, gone: prev!.gone };
    }
    let index: SignedIndex;
    try {
      index = verify(fi.index, location);
    } catch (e) {
      if (!(e instanceof StorageMovedError)) throw e;
      location = e.location;
      adapter = this.o.readAdapter(location);
      fi = await fetchHighestIndex(adapter, READ_MAJORS, {}, { maxBytes: L.indexBytes });
      if (!fi.changed) throw new NotFound(indexPath());
      index = verify(fi.index, location);
    }
    const hash = indexAnchor(index).hash;
    const base = { index, location, etag: fi.etag, path: fi.path, hash, unchanged: false, full: true };
    if (prev && prev.hash === hash) {
      return { ...base, packs: prev.packs, features: new Map(), items: prev.items, meta: prev.meta, gone: prev.gone, unchanged: true };
    }
    return link.kind === 'link' ? this.fetchLinkOnly(link.secret, index, adapter, prev, budget, base) : this.fetchPublic(link.listId, index, adapter, budget, base);
  }

  private async fetchLinkOnly(
    secret: Uint8Array,
    index: SignedIndex,
    adapter: StorageAdapter,
    prev: ListState | null,
    budget: ByteBudget,
    base: Pick<Fetched, 'index' | 'location' | 'etag' | 'path' | 'hash' | 'unchanged' | 'full'>,
  ): Promise<Fetched> {
    const L = this.limits;
    const keys: KeyPair[] = [listKeyPair(secret)];
    const listed = index.packs.filter((p) => p.file.startsWith('packs/'));
    const packs: Record<string, PackSeen> = {};
    for (const p of listed) if (prev?.packs[p.hash]) packs[p.hash] = prev.packs[p.hash]!;
    const features = new Map<string, PlaceFeature>();
    const need = listed.filter((p) => !packs[p.hash]);
    await mapLimit(need, need.length, (p) =>
      this.slots.run(async () => {
        const g = await adapter.get(p.file, { maxBytes: L.packBytes });
        if (!g) throw new NotFound(p.file);
        budget.take(g.data.length, p.file);
        let opened;
        try {
          opened = openPack(g.data, index, keys);
        } catch (e) {
          if (e instanceof DecryptionError && e.code === 'NO_MATCHING_KEY') {
            packs[p.hash] = { notFor: true };
            return;
          }
          throw e;
        }
        if (opened.file !== p.file) throw new DecryptionError(`${p.file}: the storage served another listed pack`, 'NOT_INDEXED');
        if (opened.type !== 'content') {
          packs[p.hash] = { notFor: true };
          return;
        }
        const { kind, body } = decodePayload(opened.payload, { maxBytes: L.placesPayloadBytes, budget });
        if (kind !== 'lists') {
          packs[p.hash] = { notFor: true };
          return;
        }
        const parsed = parseLists(body);
        const items: Record<string, string> = {};
        for (const x of parsed.features) {
          items[x.feature.id] = x.hash;
          features.set(x.feature.id, x.feature);
        }
        packs[p.hash] = {
          lists: parsed.lists.map((l) => (isTombstone(l) ? { id: l.id, deleted: true as const } : l)),
          items,
          ...(parsed.author !== undefined && { author: parsed.author }),
        };
      }),
    );
    // One list per key: the newest live definition; a tombstone only counts with no live one.
    let def: ListDef | null = null;
    let deleted = false;
    let author: string | undefined;
    const items: Record<string, [string, string]> = {};
    for (const p of listed) {
      const s = packs[p.hash];
      if (!s?.lists) continue;
      for (const l of s.lists) {
        if ('deleted' in l) deleted = true;
        else if (!def || l.updated > def.updated) def = l;
      }
      if (s.author !== undefined) author = s.author;
      for (const [id, h] of Object.entries(s.items ?? {})) if (!items[id] || p.hash < items[id]![1]) items[id] = [h, p.hash];
    }
    if (!def) return { ...base, packs, features, items: {}, meta: prev?.meta ?? null, gone: deleted ? 'deleted' : 'link-dead' };
    const d = def as ListDef;
    return {
      ...base,
      packs,
      features,
      items,
      meta: { listId: d.id, name: d.name, ...(d.description && { description: d.description }), updated: d.updated, ...(author !== undefined && { author }) },
      gone: null,
    };
  }

  private async fetchPublic(
    listId: string,
    index: SignedIndex,
    adapter: StorageAdapter,
    budget: ByteBudget,
    base: Pick<Fetched, 'index' | 'location' | 'etag' | 'path' | 'hash' | 'unchanged' | 'full'>,
  ): Promise<Fetched> {
    if (!index.public) return { ...base, packs: {}, features: new Map(), items: {}, meta: null, gone: 'deleted' };
    const g = await adapter.get(index.public.file, { maxBytes: this.limits.packBytes });
    if (!g) throw new NotFound(index.public.file);
    budget.take(g.data.length, index.public.file);
    verifyPublicFile(g.data, index);
    const r = parsePublicList(g.data, index.owner, listId);
    if (!r.def) return { ...base, packs: {}, features: new Map(), items: {}, meta: null, gone: 'deleted' };
    const features = new Map(r.features.map((x) => [x.feature.id, x.feature]));
    const items: Record<string, [string, string]> = {};
    for (const x of r.features) items[x.feature.id] = [x.hash, 'public'];
    const d = r.def;
    return {
      ...base,
      packs: {},
      features,
      items,
      meta: { listId: d.id, name: d.name, ...(d.description && { description: d.description }), updated: d.updated, ...(r.author !== undefined && { author: r.author }) },
      gone: null,
    };
  }
}
