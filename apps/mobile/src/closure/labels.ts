/** Wording of closed-place signals on the card (translated by code; the osm package's English detail is a fallback). Pure. */
import type { ClosureSignal } from '@triangulair/osm';

import type { Translator } from '../places/card';

export function signalText(s: ClosureSignal, tr: Translator): string {
  const d = s.data ?? {};
  switch (s.code) {
    case 'lifecycle_prefix':
      return tr.t('closure.signal.lifecycle_prefix', { tag: d.key && d.value ? `${d.key}=${d.value}` : '' });
    case 'end_date_past':
      return tr.t('closure.signal.end_date_past', { date: d.value ?? '' });
    case 'name_changed':
      return d.current
        ? tr.t('closure.signal.name_changed', { previous: d.previous ?? '', current: d.current })
        : tr.t('closure.signal.name_removed', { previous: d.previous ?? '' });
    default: {
      const key = `closure.signal.${s.code}`;
      return tr.has(key) ? tr.t(key) : s.detail;
    }
  }
}

/** "23 October 2026" in the UI language. */
export function signalDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}
