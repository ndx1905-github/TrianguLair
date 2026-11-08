/**
 * Sync status and problems → what the user sees (spec "Error cases"): plain words, an action when
 * there is one, nothing for transient problems until they last. Pure (keys and parameters for the
 * i18n dictionaries); unit-tested.
 */
import type { SyncProblem, SyncStatus } from '@triangulair/sync';

export type NoteTone = 'info' | 'warning' | 'error';
/** Where the note's button leads: storage settings (reconnect), the sync status screen. */
export type NoteAction = 'storage' | 'sync' | null;

export interface Note {
  key: string;
  params?: Record<string, string | number>;
  tone: NoteTone;
  action: NoteAction;
  /** Stable id for tests. */
  id: string;
}

const DAY = 86_400_000;

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

/** One followed person's line on the sync status screen. */
export function friendNote(problem: SyncProblem | null | undefined, lastSuccess: number | null, now: number): Note {
  const ago = (): Note =>
    lastSuccess === null
      ? { id: 'never', key: 'sync.friend.never', tone: 'warning', action: null }
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
