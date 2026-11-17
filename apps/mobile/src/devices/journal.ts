/**
 * "Show the changes made on the storage since the date of the theft, with the option to revert"
 * (spec "Loss and theft", step 5). Each sync pass that imports my other devices' document changes
 * compares my own saves before and after, and keeps what changed, with the device that signed the
 * index they came from. The declaration screen lists the entries since a chosen date; a change can
 * be reverted from the local copy kept here (the values before), as a new edit that syncs to my
 * other devices like any other.
 *
 * Kept in the sync state (erased by a remote wipe), at most 120 days and 400 changes. Pure parts
 * are unit-tested; the controller records, the screen reverts through `revertChange`.
 */
import type { DataStore } from '@triangulair/data';

export const JOURNAL_KEY = 'app:journal';
export const JOURNAL_DAYS = 120;
export const JOURNAL_MAX = 400;

/** What can be put back of one of my saves. */
export interface SaveSnapshot {
  name: string;
  comment: string;
  commentVisibility: string;
  status: string | null;
  priceLevel: number | null;
  sharing: string;
  mainTagId: string | null;
  tagIds: string[];
  deleted: boolean;
}

export interface JournalChange {
  placeId: string;
  /** null: the save did not exist (added by the other device). */
  before: SaveSnapshot | null;
  /** null: the save is gone for good (purged). */
  after: SaveSnapshot | null;
}

export interface JournalEntry {
  /** When this device imported it (ms). */
  at: number;
  /** Device id that signed the index the changes came from. */
  device: string | null;
  changes: JournalChange[];
  /** Place ids already reverted. */
  reverted?: string[];
}

export type SaveMap = Map<string, SaveSnapshot>;

/** My saves (trash included), with what a revert needs. */
export function ownSaves(store: DataStore): SaveMap {
  const db = store.repo.db;
  const rows = db.all<{
    id: string; place_id: string; name: string | null; comment: string; comment_visibility: string; status: string | null;
    price_level: number | null; sharing: string; main_tag_id: string | null; deleted_at: number | null;
  }>(
    `SELECT s.id, s.place_id, p.name, s.comment, s.comment_visibility, s.status, s.price_level, s.sharing, s.main_tag_id, s.deleted_at
       FROM saves s LEFT JOIN places p ON p.id = s.place_id WHERE s.owner_id = ?`,
    [store.meId],
  );
  const tags = new Map<string, string[]>();
  for (const t of db.all<{ save_id: string; tag_id: string }>(`SELECT st.save_id, st.tag_id FROM save_tags st JOIN saves s ON s.id = st.save_id WHERE s.owner_id = ?`, [store.meId])) {
    tags.set(t.save_id, [...(tags.get(t.save_id) ?? []), t.tag_id]);
  }
  const out: SaveMap = new Map();
  for (const r of rows) {
    out.set(r.place_id, {
      name: r.name ?? '',
      comment: r.comment,
      commentVisibility: r.comment_visibility,
      status: r.status,
      priceLevel: r.price_level,
      sharing: r.sharing,
      mainTagId: r.main_tag_id,
      tagIds: (tags.get(r.id) ?? []).sort(),
      deleted: r.deleted_at !== null,
    });
  }
  return out;
}

function same(a: SaveSnapshot, b: SaveSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What changed between two snapshots of my saves. */
export function diffSaves(before: SaveMap, after: SaveMap): JournalChange[] {
  const out: JournalChange[] = [];
  for (const [id, a] of after) {
    const b = before.get(id) ?? null;
    if (!b || !same(a, b)) out.push({ placeId: id, before: b, after: a });
  }
  for (const [id, b] of before) if (!after.has(id)) out.push({ placeId: id, before: b, after: null });
  return out.sort((x, y) => (x.placeId < y.placeId ? -1 : 1));
}

/** Adds an entry, dropping what is older than JOURNAL_DAYS and beyond JOURNAL_MAX changes. */
export function addEntry(journal: readonly JournalEntry[], e: JournalEntry, now: number): JournalEntry[] {
  const floor = now - JOURNAL_DAYS * 86_400_000;
  const all = [e, ...journal].filter((x) => x.at >= floor && x.changes.length > 0);
  const out: JournalEntry[] = [];
  let n = 0;
  for (const x of all) {
    if (n >= JOURNAL_MAX) break;
    const keep = x.changes.slice(0, JOURNAL_MAX - n);
    n += keep.length;
    out.push({ ...x, changes: keep });
  }
  return out;
}

export interface ChangeLine {
  entryAt: number;
  device: string | null;
  change: JournalChange;
  kind: 'added' | 'removed' | 'restored' | 'edited' | 'purged';
  /** Fields that differ (edited). */
  fields: string[];
  reverted: boolean;
  /** A revert can be made from the local copy. */
  revertible: boolean;
}

export function kindOf(c: JournalChange): ChangeLine['kind'] {
  if (!c.before) return 'added';
  if (!c.after) return 'purged';
  if (!c.before.deleted && c.after.deleted) return 'removed';
  if (c.before.deleted && !c.after.deleted) return 'restored';
  return 'edited';
}

export function changedFields(c: JournalChange): string[] {
  if (!c.before || !c.after) return [];
  const f: string[] = [];
  const b = c.before;
  const a = c.after;
  if (b.name !== a.name) f.push('name');
  if (b.comment !== a.comment || b.commentVisibility !== a.commentVisibility) f.push('comment');
  if (b.status !== a.status) f.push('status');
  if (b.priceLevel !== a.priceLevel) f.push('price');
  if (b.sharing !== a.sharing) f.push('sharing');
  if (b.mainTagId !== a.mainTagId || b.tagIds.join() !== a.tagIds.join()) f.push('tags');
  return f;
}

/**
 * The changes since `since` (ms), newest first; `devices` keeps only those signed by these devices
 * (the lost one). Only the latest change of each place is revertible (an older one was overwritten).
 */
export function changesSince(journal: readonly JournalEntry[], since: number, devices?: readonly string[]): ChangeLine[] {
  const lines: ChangeLine[] = [];
  const seen = new Set<string>();
  for (const e of [...journal].sort((a, b) => b.at - a.at)) {
    if (e.at < since) continue;
    if (devices && (!e.device || !devices.includes(e.device))) continue;
    for (const c of e.changes) {
      const latest = !seen.has(c.placeId);
      seen.add(c.placeId);
      const kind = kindOf(c);
      const reverted = !!e.reverted?.includes(c.placeId);
      lines.push({ entryAt: e.at, device: e.device, change: c, kind, fields: changedFields(c), reverted, revertible: latest && !reverted && kind !== 'purged' });
    }
  }
  return lines;
}

/** Puts back the values before `change` (a new edit of my document). Throws if the place is gone. */
export function revertChange(store: DataStore, change: JournalChange): void {
  const b = change.before;
  if (!b) {
    // Added by the other device: to the trash (undoable like any removal).
    store.deleteSave(change.placeId);
    return;
  }
  if (!change.after) throw new Error('purged');
  if (b.deleted && !change.after.deleted) {
    store.deleteSave(change.placeId);
    return;
  }
  if (!b.deleted && change.after.deleted) store.restoreSave(change.placeId);
  store.updateSave(change.placeId, {
    comment: b.comment,
    commentVisibility: b.commentVisibility as never,
    status: b.status as never,
    priceLevel: b.priceLevel as never,
    sharing: b.sharing as never,
  });
  if (b.tagIds.join() !== change.after.tagIds.join() || b.mainTagId !== change.after.mainTagId) {
    const known = new Set(store.repo.db.all<{ id: string }>(`SELECT id FROM tags WHERE owner_id = ?`, [store.meId]).map((r) => r.id));
    const tags = b.tagIds.filter((t) => known.has(t));
    store.setSaveTags(change.placeId, tags, b.mainTagId && known.has(b.mainTagId) ? b.mainTagId : (tags[0] ?? null));
  }
}

export function markReverted(journal: readonly JournalEntry[], entryAt: number, placeId: string): JournalEntry[] {
  return journal.map((e) => (e.at === entryAt ? { ...e, reverted: [...new Set([...(e.reverted ?? []), placeId])] } : e));
}
