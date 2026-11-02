// SPDX-License-Identifier: MPL-2.0
/** Small value parsers shared by the format readers. */
import { normalizeText, type SaveStatus } from '@triangulair/data';
import { strFromU8 } from 'fflate';

/** A coordinate written with a dot or a decimal comma ("48,8566"); null when not a number. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s/g, '');
  if (!/^[+-]?\d+([.,]\d+)?$/.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function validLatLon(lat: number | null | undefined, lon: number | null | undefined): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/**
 * Dates as found in exports: ISO 8601, epoch seconds or milliseconds, and
 * day-first "31/12/2024 18:30" (European spreadsheets). ms since the epoch.
 */
export function parseDate(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return undefined;
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^\d{9,13}(\.\d+)?$/.test(s)) return parseDate(Number(s));
  const dm = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (dm) {
    const t = Date.UTC(Number(dm[3]), Number(dm[2]) - 1, Number(dm[1]), Number(dm[4] ?? 0), Number(dm[5] ?? 0), Number(dm[6] ?? 0));
    return Number.isFinite(t) ? t : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

const STATUS_WORDS: [SaveStatus, string[]][] = [
  ['favorite', ['favorite', 'favourite', 'favorites', 'favourites', 'favori', 'favoris', 'coup de coeur', 'starred', 'star', 'loved', 'love', 'preferito']],
  ['tried', ['tried', 'visited', 'been', 'been there', 'done', 'teste', 'testé', 'deja fait', 'déjà fait', 'visite', 'visité', 'fait', 'besucht']],
  ['to_try', ['to try', 'to_try', 'want to go', 'want to try', 'to visit', 'wishlist', 'a tester', 'à tester', 'a essayer', 'à essayer', 'a faire', 'à faire', 'envie', 'todo', 'to do']],
];

/** A status from a source value or list name ("Want to go" → to_try), or undefined. */
export function parseStatus(v: unknown): SaveStatus | undefined {
  if (typeof v === 'boolean') return undefined;
  if (typeof v !== 'string') return undefined;
  const s = normalizeText(v).replace(/[_-]/g, ' ').trim();
  if (!s) return undefined;
  for (const [status, words] of STATUS_WORDS) {
    if (words.some((w) => normalizeText(w) === s)) return status;
  }
  return undefined;
}

/** "#RGB", "#RRGGBB", "RRGGBB", "#RRGGBBAA" (CSS order) → "#RRGGBB" upper case. */
export function normalizeColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) return `#${s.split('').map((c) => c + c).join('')}`.toUpperCase();
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return `#${s.slice(0, 6)}`.toUpperCase();
  return undefined;
}

/** KML colors are aabbggrr. */
export function kmlColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{8}$/i.test(s)) return undefined;
  return `#${s.slice(6, 8)}${s.slice(4, 6)}${s.slice(2, 4)}`.toUpperCase();
}

/** Splits a tag cell: "Pizza, Bar; Terrace | Paris" → ["Pizza", "Bar", "Terrace", "Paris"]. */
export function splitTags(v: unknown): string[] {
  if (Array.isArray(v)) return uniq(v.flatMap((x) => (typeof x === 'string' ? splitTags(x) : typeof x === 'object' && x && 'name' in x ? splitTags((x as { name: unknown }).name) : [])));
  if (typeof v !== 'string') return [];
  return uniq(
    v
      .split(/[,;|]|\s#(?=\S)/)
      .map((t) => t.trim().replace(/^#/, '').trim())
      .filter((t) => t.length > 0 && t.length <= 60),
  );
}

export function uniq(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = normalizeText(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

/** Plain text from an HTML description (My Maps, Pin Drop): line breaks kept, tags dropped. */
export function stripHtml(s: string): string {
  if (!/[<&]/.test(s)) return s.trim();
  return s
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' ? undefined : s;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** File name without folders and extension ("Takeout/Saved/Want to go.csv" → "Want to go"). */
export function baseName(name: string): string {
  const file = name.split(/[\\/]/).pop() ?? name;
  return file.replace(/\.[a-z0-9]{1,5}$/i, '').trim();
}

/** UTF-8 bytes to text (fflate's decoder: Hermes has no TextDecoder). */
export function bytesToText(bytes: Uint8Array): string {
  return strFromU8(bytes);
}
