/**
 * What's new (spec "Interface"): friends' activity since my last visit, built from the friend
 * reader's differences (`FriendReport.whatsNew`) after every sync pass. Only meaningful changes
 * (spec "Editing": a new comment, a switch to tried or favorite; not a tag color or a typo):
 * places added, comments, statuses, a friend's key change or move. The log lives in the sync
 * state (local database), so a remote wipe erases it with the rest.
 *
 * My own places that may no longer exist according to OpenStreetMap (closed-place check, import)
 * are listed with them: they come from their own log (`closure/events.ts`, same local database).
 *
 * Pure apart from the small key-value store it is given; unit-tested.
 */
import type { ClosureSignal } from '@triangulair/osm';
import type { FriendReport, SyncStateStore } from '@triangulair/sync';

import { ClosureEventLog } from '../closure/events';

export type WhatsNewKind = 'added' | 'comment' | 'status' | 'photo' | 'followed' | 'key' | 'moved' | 'identity' | 'closure' | 'closureImport';

export interface WhatsNewEntry {
  id: string;
  owner: string;
  kind: WhatsNewKind;
  at: number;
  /** Place (none for key / moved). */
  placeId?: string;
  /** Place name when recorded (it may leave the cache later). */
  name?: string;
  /** Their comment (added / comment). */
  comment?: string;
  /** Their status (status, or added with one). */
  status?: string;
  /** First read of someone: how many places, and which (capped); new photos: how many. */
  count?: number;
  placeIds?: string[];
  /** New photos (kind `photo`): their ids, for thumbnails. */
  mediaIds?: string[];
  /** One of my places may no longer exist (kind `closure`): the main reason, when known. */
  signal?: ClosureSignal;
}

export type WhatsNewType = 'all' | 'places' | 'comments' | 'statuses' | 'photos' | 'people' | 'closures';

/** My own entries (not a friend's): no avatar, no friend chip. */
export function isOwnEntry(e: Pick<WhatsNewEntry, 'kind'>): boolean {
  return e.kind === 'closure' || e.kind === 'closureImport';
}

export interface RecordContext {
  now: number;
  /** People with nothing in my cache before this pass (their first places are grouped). */
  firstRead: ReadonlySet<string>;
  placeName(placeId: string): string | undefined;
  /** Their save of the place after the pass (comment within their visibility, status). */
  theirSave(owner: string, placeId: string): { comment: string; status: string | null } | undefined;
}

const LOG_KEY = 'app:whatsnew';
const VISIT_KEY = 'app:whatsnew:visit';
const MAX_ENTRIES = 400;
const MAX_IDS = 500;
const MEANINGFUL_STATUS = new Set(['tried', 'favorite']);

type Kv = Pick<SyncStateStore, 'get' | 'set'>;

export class WhatsNewLog {
  readonly closures: ClosureEventLog;

  constructor(private readonly kv: Kv) {
    this.closures = new ClosureEventLog(kv);
  }

  /** Friends' news and my places that may no longer exist, newest first. */
  entries(): WhatsNewEntry[] {
    const own = this.closures.entries();
    const friends = this.friendEntries();
    return own.length === 0 ? friends : [...friends, ...own].sort((a, b) => b.at - a.at);
  }

  /** Friends' news only (the log `record` writes). */
  friendEntries(): WhatsNewEntry[] {
    const v = this.kv.get<WhatsNewEntry[]>(LOG_KEY);
    return Array.isArray(v) ? v : [];
  }

  /** When What's new was last left (0: never). */
  lastVisit(): number {
    return this.kv.get<number>(VISIT_KEY) ?? 0;
  }

  markVisited(at: number): void {
    this.kv.set(VISIT_KEY, at);
  }

  unseen(): number {
    const v = this.lastVisit();
    return this.entries().filter((e) => e.at > v).length;
  }

  /** Adds what a pass brought; returns the new entries. */
  record(reports: readonly FriendReport[], ctx: RecordContext): WhatsNewEntry[] {
    const fresh: WhatsNewEntry[] = [];
    const gone = new Set<string>();
    let n = 0;
    const add = (e: Omit<WhatsNewEntry, 'id' | 'at'>) => fresh.push({ ...e, at: ctx.now, id: `${ctx.now.toString(36)}-${(n++).toString(36)}-${e.kind}` });
    for (const r of reports) {
      // A friend changed identity (theft of their primary device), followed by the engine.
      if (r.identityMove?.followed) add({ owner: r.identityMove.to, kind: 'identity' });
      if (r.status === 'error') continue;
      const owner = r.owner;
      if (r.keyChanged) add({ owner, kind: 'key' });
      if (r.movedTo) add({ owner, kind: 'moved' });
      const wn = r.whatsNew;
      for (const id of wn.removed) gone.add(`${owner} ${id}`);
      if (ctx.firstRead.has(owner) && wn.added.length > 1) {
        add({ owner, kind: 'followed', count: wn.added.length, placeIds: wn.added.slice(0, MAX_IDS) });
        continue;
      }
      for (const placeId of wn.added) {
        const s = ctx.theirSave(owner, placeId);
        add({
          owner,
          kind: 'added',
          placeId,
          ...opt('name', ctx.placeName(placeId)),
          ...opt('comment', s?.comment || undefined),
          ...opt('status', s?.status ?? undefined),
        });
      }
      for (const ch of wn.changed) {
        if (!ch.meaningful) continue;
        const s = ctx.theirSave(owner, ch.placeId);
        const base = { owner, placeId: ch.placeId, ...opt('name', ctx.placeName(ch.placeId)) };
        if (ch.fields.includes('comment') && s?.comment) add({ ...base, kind: 'comment', comment: s.comment });
        if (ch.fields.includes('status') && s?.status && MEANINGFUL_STATUS.has(s.status)) add({ ...base, kind: 'status', status: s.status });
      }
      // New photos on a place already there (spec "Editing": "new photo" is meaningful).
      for (const p of wn.photos ?? []) {
        if (p.mediaIds.length === 0) continue;
        add({ owner, kind: 'photo', placeId: p.placeId, ...opt('name', ctx.placeName(p.placeId)), count: p.mediaIds.length, mediaIds: p.mediaIds.slice(0, 24) });
      }
    }
    if (fresh.length === 0 && gone.size === 0) return [];
    // A place that left their shared places takes its earlier news with it.
    const kept = this.friendEntries().filter((e) => !(e.placeId && gone.has(`${e.owner} ${e.placeId}`)));
    this.kv.set(LOG_KEY, [...fresh.reverse(), ...kept].slice(0, MAX_ENTRIES));
    return fresh;
  }

  /**
   * Photos that left my cache (removed by their author, access lost, or dropped by a key renewal that
   * could not be done, review photos F-07) leave What's new as if they had never been added: their
   * ids go, and a "new photo" entry left without any goes too. Returns whether anything changed.
   */
  prunePhotos(exists: (mediaId: string) => boolean): boolean {
    let changed = false;
    const out: WhatsNewEntry[] = [];
    for (const e of this.friendEntries()) {
      if (e.kind !== 'photo' || !e.mediaIds) {
        out.push(e);
        continue;
      }
      const ids = e.mediaIds.filter(exists);
      if (ids.length === e.mediaIds.length) {
        out.push(e);
        continue;
      }
      changed = true;
      if (ids.length > 0) out.push({ ...e, mediaIds: ids, count: Math.max(0, (e.count ?? e.mediaIds.length) - (e.mediaIds.length - ids.length)) || ids.length });
    }
    if (changed) this.kv.set(LOG_KEY, out);
    return changed;
  }

  /** Someone I no longer follow: their news go too. */
  forget(owner: string): void {
    this.kv.set(LOG_KEY, this.friendEntries().filter((e) => e.owner !== owner));
  }
}

function opt<K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [k]: v }) as { [P in K]?: V };
}

export function matchesType(e: WhatsNewEntry, type: WhatsNewType): boolean {
  switch (type) {
    case 'all':
      return true;
    case 'places':
      return e.kind === 'added' || e.kind === 'followed';
    case 'comments':
      return e.kind === 'comment' || (e.kind === 'added' && !!e.comment);
    case 'statuses':
      return e.kind === 'status';
    case 'photos':
      return e.kind === 'photo';
    case 'people':
      return e.kind === 'key' || e.kind === 'moved' || e.kind === 'identity';
    case 'closures':
      return isOwnEntry(e);
  }
}

export function filterEntries(entries: readonly WhatsNewEntry[], f: { type: WhatsNewType; owner: string | null }): WhatsNewEntry[] {
  return entries.filter((e) => matchesType(e, f.type) && (f.owner === null || e.owner === f.owner));
}

export interface DayGroup {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Days before today (0 today, 1 yesterday…). */
  daysAgo: number;
  entries: WhatsNewEntry[];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Newest day first, entries newest first (local time). */
export function groupByDay(entries: readonly WhatsNewEntry[], now: number): DayGroup[] {
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const groups = new Map<string, DayGroup>();
  for (const e of [...entries].sort((a, b) => b.at - a.at)) {
    const d = new Date(e.at);
    const key = dayKey(d);
    let g = groups.get(key);
    if (!g) {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      g = { day: key, daysAgo: Math.max(0, Math.round((midnight - start) / 86_400_000)), entries: [] };
      groups.set(key, g);
    }
    g.entries.push(e);
  }
  return [...groups.values()];
}

/** Places the "See on the map" button highlights. */
export function placesOf(entries: readonly WhatsNewEntry[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.placeId) out.add(e.placeId);
    for (const id of e.placeIds ?? []) out.add(id);
  }
  return [...out];
}
