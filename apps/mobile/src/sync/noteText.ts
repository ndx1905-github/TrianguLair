/** Notes (problems.ts) → words, with the dictionaries. Pure; covered by the i18n tests. */
import type { SyncStatus } from '@triangulair/sync';

import { ageParts, sinceParts, type Note } from './problems';

type T = (key: string, params?: Record<string, string | number>) => string;

/** "just now", "5 minutes ago", "12 days ago". */
export function agoText(ms: number, t: T): string {
  const a = ageParts(ms);
  return a.key === 'age.now' ? t('sync.justNow') : t('sync.ago', { age: t(a.key, { count: a.count }) });
}

export function noteText(n: Note, s: SyncStatus, t: T, locale: string, now: number): string {
  if (n.key === 'sync.note.banner') {
    const since = sinceParts(s.failingSince ?? now, now);
    const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(since.date);
    return t(n.key, { since: t(since.key, { date }) });
  }
  return t(n.key, n.params);
}

export function friendNoteText(n: Note, name: string, t: T): string {
  const ageMs = typeof n.params?.['ageMs'] === 'number' ? (n.params['ageMs'] as number) : null;
  return t(n.key, { name, ...(ageMs !== null && { when: agoText(ageMs, t) }) });
}

/** Help paragraph for my storage's note on the sync status screen. */
export function noteHelpKey(n: Note): string | null {
  switch (n.id) {
    case 'reconnect':
      return 'sync.help.reconnect';
    case 'banner':
      return 'sync.help.banner';
    case 'quota':
      return 'sync.help.quota';
    case 'needs-key':
      return 'sync.help.needsKey';
    case 'own-tampered':
      return 'sync.help.ownTampered';
    case 'error':
    case 'blocked':
    case 'own-unsupported':
    case 'too-many':
      return 'sync.help.error';
    default:
      return null;
  }
}
