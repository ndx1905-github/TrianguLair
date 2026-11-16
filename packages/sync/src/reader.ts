// SPDX-License-Identifier: MPL-2.0
/**
 * Reading the people I follow, at their certified read address (spec
 * "Friends read at the source"):
 *
 * 1. one HEAD on their index; unchanged ETag → nothing else (and a full GET
 *    from time to time, because some servers have coarse ETags);
 * 2. the index is verified against their master key and the last index I
 *    accepted from them (anchor: rollback, fork, jump), at the address it was
 *    read from (a master-signed redirect is followed, only to the address it
 *    certifies);
 * 3. only packs I have not seen are downloaded (by content hash); packs that
 *    none of my keys opens are remembered as such (until my keys change);
 * 4. the readable places are the union of the packs I can open: what is no
 *    longer readable (deleted, private again, my access removed) is erased
 *    from my cache (spec "Removing someone");
 * 5. the projection into the local store happens in one transaction, and
 *    only when every needed pack was fetched and verified: a failure keeps
 *    the last valid content (spec "Tampered content");
 * 6. the difference with the previous version feeds What's new.
 *
 * Bounds (R-06): every download is size-limited before its hash is checked
 * (index, packs), decompression is limited per pack, and the bytes of one
 * friend's read and of all the friends of one pass are counted; pack work
 * shares one concurrency limit across the friends read in parallel. A pack
 * is accepted only at its own path (R-03: the host cannot serve another
 * listed pack there).
 */
import {
  DecryptionError,
  StorageMovedError,
  formatKey,
  indexAnchor,
  openPack,
  verifyIndex,
  type IndexAnchor,
  type KeyPair,
  type SignedIndex,
} from '@triangulair/crypto';
import { saveIdFor, type DataStore } from '@triangulair/data';
import { NotFound, fetchHighestIndex, indexPath, type StorageAdapter } from '@triangulair/storage';
import { fingerprint } from './audience.ts';
import { classifyError, type SyncProblem } from './errors.ts';
import { parsePlaces, toForeignSave, type PlaceFeature } from './features.ts';
import { resolveLimits, type SyncLimits } from './limits.ts';
import { decodePayload } from './payload.ts';
import { isTombstone, parseLists, type ListDef } from './lists.ts';
import type { SyncStateStore } from './state.ts';
import { ByteBudget, Semaphore, mapLimit } from './util.ts';

/** Index majors this reader understands besides the base one (4, at `index.json`). */
export const READ_MAJORS: readonly number[] = [];

export interface ReaderOptions {
  store: DataStore;
  state: SyncStateStore;
  /** My key pairs that friends may wrap to (current sharing key first, then older ones). */
  keys: () => KeyPair[];
  /** Read adapter for an HTTPS read address (default: HttpsReadOnlyAdapter, set by the engine). */
  readAdapter: (location: string) => StorageAdapter;
  /** Pack downloads and decryptions in flight, across every friend read at once (default 6). */
  concurrency?: number;
  /** Full GET of an index whose ETag did not change after this long (default 10 min). */
  fullCheckMs?: number;
  now?: () => Date;
  /** Size limits (SyncLimits: indexBytes, packBytes, placesPayloadBytes, friendReadBytes, passBytes). */
  limits?: Partial<SyncLimits>;
}

export interface FriendTarget {
  owner: string;
  /** Their certified read address (from their sharing certificate). */
  location: string;
  /** Last index accepted from them (vault anchor). */
  anchor?: IndexAnchor | undefined;
  /** Extra keys for this friend only (an invitation key pair before my return link is accepted). */
  extraKeys?: KeyPair[];
  retiredOwners?: readonly string[];
}

export interface ChangedItem {
  placeId: string;
  /** Meaningful for What's new: new comment, switch to tried or favorite (spec "Editing"). */
  meaningful: boolean;
  fields: string[];
}

export interface WhatsNew {
  added: string[];
  changed: ChangedItem[];
  removed: string[];
}

export interface FriendReport {
  owner: string;
  status: 'unchanged' | 'updated' | 'error';
  whatsNew: WhatsNew;
  /** The verified index (to record as the contact's new anchor). */
  index?: SignedIndex;
  /** Their sharing certificate rotation increased: "Léa changed her key". */
  keyChanged?: boolean;
  /** They moved storage (followed redirect): new certified address. */
  movedTo?: string;
  problem?: SyncProblem;
  /** Packs downloaded and bytes. */
  downloaded: { packs: number; bytes: number };
}

interface PackSeen {
  /** Readable: item id → item hash. */
  items?: Record<string, string>;
  /** A readable lists pack: the list definitions it holds (lists.ts). */
  lists?: ListDef[];
  /** Not readable with the keys of this fingerprint. */
  notFor?: string;
}

interface FriendState {
  location: string;
  etag: string | null;
  path: string;
  hash: string | null;
  checkedAt: number;
  packs: Record<string, PackSeen>;
  /** item id → [hash, pack hash]. */
  items: Record<string, [string, string]>;
  lastSuccess: number | null;
  lastError: number | null;
  /** Their lists I can see (definitions, membership limited to the places I can read). */
  lists?: ListDef[];
}

const empty = (): WhatsNew => ({ added: [], changed: [], removed: [] });
const MEANINGFUL_STATUS = new Set(['tried', 'favorite']);

export class FriendReader {
  readonly limits: SyncLimits;
  private readonly slots: Semaphore;
  constructor(private readonly o: ReaderOptions) {
    this.limits = resolveLimits(o.limits);
    this.slots = new Semaphore(o.concurrency ?? 6);
  }

  private nowMs(): number {
    return (this.o.now?.() ?? new Date()).getTime();
  }

  private key(owner: string): string {
    return `friend:${owner}`;
  }

  stateOf(owner: string): FriendState | undefined {
    return this.o.state.get<FriendState>(this.key(owner));
  }

  /** Last successful read (ms) of a friend, for "Updated 12 days ago". */
  lastSuccess(owner: string): number | null {
    return this.stateOf(owner)?.lastSuccess ?? null;
  }

  /** The lists of a friend that they shared with me (as of the last successful read). */
  friendLists(owner: string): ListDef[] {
    return this.stateOf(owner)?.lists ?? [];
  }

  /** Erases a friend's content from my cache (removed contact, "I see their places" off, 3-month cleanup). */
  forget(owner: string): string[] {
    const st = this.stateOf(owner);
    const repo = this.o.store.repo;
    const ids = repo.db.all<{ id: string; place_id: string }>(`SELECT id, place_id FROM saves WHERE owner_id = ?`, [owner]);
    repo.transaction(() => {
      for (const r of ids) repo.deleteForeignSave(r.id);
      prunePlaces(this.o.store, ids.map((r) => r.place_id));
    });
    this.o.state.delete(this.key(owner));
    return st ? Object.keys(st.items) : ids.map((r) => r.place_id);
  }

  /** Reads one friend. `pass`: the byte budget of the whole sync pass (shared by every friend read in it). */
  async read(t: FriendTarget, opts: { pass?: ByteBudget } = {}): Promise<FriendReport> {
    const report: FriendReport = { owner: t.owner, status: 'unchanged', whatsNew: empty(), downloaded: { packs: 0, bytes: 0 } };
    const prev = this.stateOf(t.owner);
    // A copy in both cases (R-04): a failed read must leave the saved state exactly as it was.
    const st: FriendState = prev && prev.location === t.location
      ? structuredClone(prev)
      : { location: t.location, etag: null, path: indexPath(), hash: null, checkedAt: 0, packs: structuredClone(prev?.packs ?? {}), items: structuredClone(prev?.items ?? {}), lastSuccess: prev?.lastSuccess ?? null, lastError: null };
    const L = this.limits;
    const budget = new ByteBudget(L.friendReadBytes, 'read', opts.pass);
    try {
      let location = t.location;
      let adapter = this.o.readAdapter(location);
      const fresh = this.nowMs() - st.checkedAt < (this.o.fullCheckMs ?? 600_000);
      let f = await fetchHighestIndex(adapter, READ_MAJORS, fresh && st.etag ? { [st.path]: st.etag } : {}, { maxBytes: L.indexBytes });
      if (!f.changed) {
        st.lastSuccess = this.nowMs();
        st.lastError = null;
        this.o.state.set(this.key(t.owner), st);
        return report;
      }
      const verify = (bytes: Uint8Array, loc: string) =>
        verifyIndex(bytes, {
          expectedOwner: t.owner,
          location: loc,
          ...(t.anchor && { lastSeen: t.anchor }),
          ...(t.retiredOwners && { retiredOwners: t.retiredOwners }),
          ...(this.o.now && { now: this.o.now() }),
        });
      let index: SignedIndex;
      try {
        index = verify(f.index, location);
      } catch (e) {
        if (!(e instanceof StorageMovedError)) throw e;
        // A signed redirect: read only at the address it certifies, once.
        location = e.location;
        adapter = this.o.readAdapter(location);
        f = await fetchHighestIndex(adapter, READ_MAJORS, {}, { maxBytes: L.indexBytes });
        if (!f.changed) throw new NotFound('index.json');
        index = verify(f.index, location);
        report.movedTo = location;
      }
      if (t.anchor && index.sharing_cert.rotation > t.anchor.sharing_cert.rotation) report.keyChanged = true;
      report.index = index;
      const hash = indexAnchor(index).hash;
      st.location = location;
      st.etag = f.etag;
      st.path = f.path;
      st.checkedAt = this.nowMs();
      if (hash === st.hash) {
        st.lastSuccess = this.nowMs();
        st.lastError = null;
        this.o.state.set(this.key(t.owner), st);
        return report;
      }

      // Packs.
      const keys = [...this.o.keys(), ...(t.extraKeys ?? [])];
      const kfp = fingerprint(keys.map((k) => formatKey('x25519', k.publicKey)));
      const listed = index.packs.filter((p) => p.file.startsWith('packs/'));
      const need = listed.filter((p) => {
        const s = st.packs[p.hash];
        if (!s || (s.notFor !== undefined && s.notFor !== kfp)) return true;
        // A pack read before whose items were not all projected (cannot happen since R-04, but then
        // read it again rather than skip its items).
        return !!s.items && Object.entries(s.items).some(([id, h]) => st.items[id]?.[0] !== h);
      });
      const features = new Map<string, Map<string, PlaceFeature>>();
      await mapLimit(need, need.length, (p) => this.slots.run(async () => {
        const g = await adapter.get(p.file, { maxBytes: L.packBytes });
        if (!g) throw new NotFound(p.file); // listed but not there (yet): keep the cache, retry later
        budget.take(g.data.length, p.file);
        report.downloaded.packs++;
        report.downloaded.bytes += g.data.length;
        let opened;
        try {
          opened = openPack(g.data, index, keys);
        } catch (e) {
          if (e instanceof DecryptionError && e.code === 'NO_MATCHING_KEY') {
            st.packs[p.hash] = { notFor: kfp };
            return;
          }
          throw e;
        }
        // R-03: openPack accepts the bytes of ANY listed entry; they must be the one at this path.
        if (opened.file !== p.file) throw new DecryptionError(`${p.file}: the storage served another listed pack`, 'NOT_INDEXED');
        if (opened.type !== 'content') {
          st.packs[p.hash] = { notFor: kfp };
          return;
        }
        const { kind, body } = decodePayload(opened.payload, { maxBytes: L.placesPayloadBytes, budget });
        if (kind === 'lists') {
          // List definitions shared with me (the places are in places packs).
          st.packs[p.hash] = { items: {}, lists: parseLists(body).lists.filter((l): l is ListDef => !isTombstone(l)) };
          return;
        }
        if (kind !== 'places') {
          st.packs[p.hash] = { notFor: kfp };
          return;
        }
        const items: Record<string, string> = {};
        const m = new Map<string, PlaceFeature>();
        for (const x of parsePlaces(body)) {
          items[x.feature.id] = x.hash;
          m.set(x.feature.id, x.feature);
        }
        features.set(p.hash, m);
        st.packs[p.hash] = { items };
      }));

      // The readable set: union of the listed packs I can open.
      const next: Record<string, [string, string]> = {};
      const listedHashes = new Set(listed.map((p) => p.hash));
      for (const p of listed) {
        const s = st.packs[p.hash];
        if (!s?.items) continue;
        for (const [id, h] of Object.entries(s.items)) {
          const cur = next[id];
          // One save is in exactly one pack; if a malformed index lists it twice, keep the first by pack hash.
          if (!cur || p.hash < cur[1]) next[id] = [h, p.hash];
        }
      }
      for (const h of Object.keys(st.packs)) if (!listedHashes.has(h)) delete st.packs[h];

      // Features of items that changed may sit in packs read earlier: refetching is not needed,
      // since a pack never changes; an item whose hash changed is always in a new pack.
      const repo = this.o.store.repo;
      const wn = report.whatsNew;
      const removedPlaces: string[] = [];
      const now = this.nowMs();
      for (const [id, [h, ph]] of Object.entries(next)) {
        const old = st.items[id];
        // Every changed item must come from a pack read in this pass (see `need`): otherwise fail and keep the cache.
        if ((!old || old[0] !== h) && !features.get(ph)?.get(id)) throw new Error(`friend reader: ${id} changed but its pack was not read`);
      }
      repo.transaction(() => {
        for (const [id, [h, ph]] of Object.entries(next)) {
          const old = st.items[id];
          if (old && old[0] === h) continue;
          const f = features.get(ph)!.get(id)!;
          const input = toForeignSave(t.owner, f, now);
          const before = repo.getSave(saveIdFor(t.owner, id));
          repo.upsertForeignSave(input);
          if (!old || !before) wn.added.push(id);
          else {
            const fields: string[] = [];
            if (before.comment !== input.comment) fields.push('comment');
            if (before.status !== (input.status ?? null)) fields.push('status');
            if (before.priceLevel !== (input.priceLevel ?? null)) fields.push('price_level');
            if (before.commentVisibility !== input.commentVisibility) fields.push('comment_visibility');
            if (fields.length === 0) fields.push('details'); // name, tags, geometry
            const meaningful = (fields.includes('comment') && !!input.comment) || (fields.includes('status') && MEANINGFUL_STATUS.has(input.status ?? ''));
            wn.changed.push({ placeId: id, meaningful, fields });
          }
        }
        for (const id of Object.keys(st.items)) {
          if (next[id]) continue;
          repo.deleteForeignSave(saveIdFor(t.owner, id));
          wn.removed.push(id);
          removedPlaces.push(id);
        }
        prunePlaces(this.o.store, removedPlaces);
      });
      st.items = next;
      // Their lists: the newest definition of each id among the readable packs, places I can read only.
      const lists = new Map<string, ListDef>();
      for (const p of listed) {
        for (const l of st.packs[p.hash]?.lists ?? []) {
          const cur = lists.get(l.id);
          if (!cur || l.updated > cur.updated) lists.set(l.id, l);
        }
      }
      st.lists = [...lists.values()]
        .map((l) => ({ ...l, items: l.items.filter((id) => next[id]) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
      st.hash = hash;
      st.lastSuccess = this.nowMs();
      st.lastError = null;
      this.o.state.set(this.key(t.owner), st);
      report.status = 'updated';
      return report;
    } catch (e) {
      // Keep the last valid content; remember the failure for "Updated N days ago".
      const keep = prev ?? st;
      this.o.state.set(this.key(t.owner), { ...keep, lastError: this.nowMs() });
      report.status = 'error';
      report.problem = classifyError(e, 'friend');
      delete report.index;
      return report;
    }
  }

  /**
   * Reads several friends in parallel (bounded: `concurrency` index checks at once; their pack work
   * shares the reader's `concurrency` slots), within one pass budget (SyncLimits.passBytes).
   */
  async readAll(targets: readonly FriendTarget[], concurrency = 8, pass = new ByteBudget(this.limits.passBytes, 'pass')): Promise<FriendReport[]> {
    return mapLimit(targets, concurrency, (t) => this.read(t, { pass }));
  }
}

/** Removes cached places that a friend's removed saves leave without any save (their name and shape came from that friend). */
export function prunePlaces(store: DataStore, placeIds: readonly string[]): void {
  for (const id of placeIds) {
    store.repo.db.run(`DELETE FROM places WHERE id = ? AND NOT EXISTS (SELECT 1 FROM saves s WHERE s.place_id = places.id)`, [id]);
  }
}
