/**
 * Sync status and problems → what the user sees (spec "Error cases"): plain words, an action when
 * there is one, nothing for transient problems until they last. Pure (keys and parameters for the
 * i18n dictionaries); unit-tested.
 */
import type { SpaceKind, SpaceUsed, SyncProblem, SyncStatus } from '@triangulair/sync';

export type NoteTone = 'info' | 'warning' | 'error';
/**
 * Where the note's button leads: storage settings (reconnect: straight to the connection form), the
 * sync status screen; `keep-or-remove`: a friend unreachable for months, keep or remove their places.
 */
export type NoteAction = 'storage' | 'sync' | 'keep-or-remove' | null;

export interface Note {
  key: string;
  params?: Record<string, string | number>;
  tone: NoteTone;
  action: NoteAction;
  /** Stable id for tests. */
  id: string;
}

const DAY = 86_400_000;

/** A friend's storage unreachable for this long: offer to keep or remove their content (spec "Error cases"). */
export const FRIEND_STALE_MS = 90 * DAY;

/**
 * Where a note of mine leads. Credentials rejected: the storage connection form, filled with the
 * current settings, to type the new password (or app password, for Nextcloud).
 */
export function noteHref(n: Note): string {
  if (n.id === 'reconnect') return '/storage/setup?mode=edit';
  return n.action === 'storage' ? '/storage' : '/sync';
}

/** "yesterday", "2 days ago"… as i18n key + count; `since` in the spec's banner. */
export function ageParts(ms: number): { key: string; count: number } {
  const m = Math.max(0, ms);
  if (m < 60_000) return { key: 'age.now', count: 0 };
  if (m < 3_600_000) return { key: 'age.minutes', count: Math.floor(m / 60_000) };
  if (m < DAY) return { key: 'age.hours', count: Math.floor(m / 3_600_000) };
  if (m < 30 * DAY) return { key: 'age.days', count: Math.floor(m / DAY) };
  if (m < 365 * DAY) return { key: 'age.months', count: Math.floor(m / (30 * DAY)) };
  return { key: 'age.years', count: Math.floor(m / (365 * DAY)) };
}

/** Day the storage stopped answering, relative to `now` (calendar days in local time). */
export function sinceParts(since: number, now: number): { key: 'since.today' | 'since.yesterday' | 'since.date'; date: Date } {
  const a = new Date(since);
  const b = new Date(now);
  const days = Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / DAY);
  return { key: days <= 0 ? 'since.today' : days === 1 ? 'since.yesterday' : 'since.date', date: a };
}

/**
 * The small note about my own storage on the map (and the head of the sync status screen), or
 * null when there is nothing to say. `hasStorage`: false in local-only mode (nothing to sync of
 * mine; friends are still read).
 */
export function ownNote(s: SyncStatus, hasStorage: boolean): Note | null {
  if (s.state === 'wiped') return null;
  if (!s.online || s.state === 'offline') {
    return s.pending > 0 && hasStorage
      ? { id: 'offline-pending', key: 'sync.note.offlinePending', params: { count: s.pending }, tone: 'info', action: 'sync' }
      : { id: 'offline', key: 'sync.note.offline', tone: 'info', action: 'sync' };
  }
  const p = s.problem;
  if (!p) return null;
  if (s.state === 'blocked' || p.blocksWrites) {
    if (p.kind === 'auth') return { id: 'reconnect', key: 'sync.note.reconnect', tone: 'error', action: 'storage' };
    if (p.kind === 'needs-key') return { id: 'needs-key', key: 'sync.note.needsKey', tone: 'error', action: 'sync' };
    if (p.kind === 'too-many-recipients') return { id: 'too-many', key: 'sync.note.tooMany', tone: 'error', action: 'sync' };
    return { id: 'blocked', key: 'sync.note.error', tone: 'error', action: 'sync' };
  }
  if (p.retryable) {
    if (p.kind === 'quota') return { id: 'quota', key: 'sync.note.quota', tone: 'warning', action: 'sync' };
    // Transient (unreachable, a lost race, a file not there yet): nothing until it lasts 24 h.
    if (s.banner) return { id: 'banner', key: 'sync.note.banner', tone: 'warning', action: 'sync' };
    return null;
  }
  if (p.kind === 'tampered' || p.kind === 'rollback') return { id: 'own-tampered', key: 'sync.note.ownTampered', tone: 'error', action: 'sync' };
  if (p.kind === 'unsupported') return { id: 'own-unsupported', key: 'sync.note.ownUnsupported', tone: 'error', action: 'sync' };
  return { id: 'error', key: 'sync.note.error', tone: 'error', action: 'sync' };
}

/**
 * One followed person's line on the sync status screen. `keptAt`: when I last chose to keep the
 * places of this friend whose storage no longer answers (the offer comes back 3 months later).
 */
export function friendNote(problem: SyncProblem | null | undefined, lastSuccess: number | null, now: number, keptAt: number | null = null): Note {
  const ago = (): Note =>
    lastSuccess === null
      ? { id: 'never', key: 'sync.friend.never', tone: 'warning', action: null }
      : now - lastSuccess >= FRIEND_STALE_MS && (keptAt === null || now - keptAt >= FRIEND_STALE_MS)
        ? { id: 'stale', key: 'sync.friend.stale', params: { ageMs: now - lastSuccess }, tone: 'warning', action: 'keep-or-remove' }
        : { id: 'updated-ago', key: 'sync.friend.updatedAgo', params: { ageMs: now - lastSuccess }, tone: now - lastSuccess > 3 * DAY ? 'warning' : 'info', action: null };
  if (!problem) {
    return lastSuccess === null
      ? { id: 'waiting', key: 'sync.friend.waiting', tone: 'info', action: null }
      : { id: 'ok', key: 'sync.friend.ok', params: { ageMs: now - lastSuccess }, tone: 'info', action: null };
  }
  switch (problem.kind) {
    case 'tampered':
    case 'rollback':
      return { id: 'tampered', key: 'sync.friend.tampered', tone: 'error', action: null };
    case 'too-large':
      return problem.retryable ? ago() : { id: 'tampered', key: 'sync.friend.tampered', tone: 'error', action: null };
    case 'unsupported':
      return { id: 'unsupported', key: 'sync.friend.unsupported', tone: 'error', action: null };
    case 'identity-moved':
      return { id: 'identity-moved', key: 'sync.friend.identityMoved', tone: 'warning', action: null };
    default:
      // Unreachable, not found, offline, a redirect to retry: their content stays from the cache.
      return ago();
  }
}

/** Problems worth a line in the local technical log (never content or keys: `detail` is error names and paths). */
export function logLine(about: string, p: SyncProblem, at: number): string {
  return `${new Date(at).toISOString()} ${about === 'own' ? 'own' : 'friend'} ${p.kind}${p.retryable ? ' (retry)' : ''}: ${p.detail}`;
}

/**
 * Invitation records dropped from my vault (spec "Error cases": "Nothing, or 'An invitation could
 * not be verified and was removed'"): a line of the local log, ids left out.
 */
export function invitationsLogLine(d: { invalid: readonly string[]; revoked: readonly string[]; expired: readonly string[] }, at: number): string {
  return `${new Date(at).toISOString()} own invitations removed: ${d.invalid.length} invalid, ${d.revoked.length} by a device declared lost, ${d.expired.length} expired`;
}

/** Space used on my storage, by content type, in the order shown (empty types left out). */
export function spaceRows(s: SpaceUsed): { kind: SpaceKind; bytes: number }[] {
  const order: SpaceKind[] = ['places', 'document', 'lists', 'public', 'photos', 'keys', 'other'];
  return order.filter((k) => s[k] > 0).map((k) => ({ kind: k, bytes: s[k] }));
}

/**
 * Suggestions when my storage is full (spec "Error cases": reduce photo quality, purge version
 * history), as i18n keys: the version history always (WebDAV and Nextcloud keep old copies of every
 * file TrianguLair rewrites), photo quality when photos take space, other files when the folder holds some.
 */
export function quotaTips(s: SpaceUsed | null): string[] {
  const tips = ['sync.space.tipHistory'];
  if (s && s.photos > 0) tips.push('sync.space.tipPhotos');
  if (s && s.other > 0) tips.push('sync.space.tipOther');
  return tips;
}

/** "820 B", "12 KB", "3.4 MB" ("3,4 Mo" in French; decimal units, as storage providers count). */
export function formatBytes(n: number, locale: string): string {
  const units = locale.startsWith('fr') ? ['o', 'ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v)} ${units[i]}`;
}
