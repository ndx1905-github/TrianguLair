/**
 * Recovery kit (spec "Recovery kit"): what the export formats contain, the
 * word check and the clipboard rule. Pure, unit-tested; the screen
 * (`app/kit.tsx`) only wires them to the share sheet, the clipboard and the
 * printer.
 *
 * The kit is two items: the 12-word phrase and the storage read address. In
 * local-only mode (phase 1) there is no address yet, so the kit says that
 * the phrase alone does not bring the places back and points to a backup.
 */
import { parseKey } from '@triangulair/crypto';

import type { TFunction } from '../i18n';

/** The clipboard is cleared this long after copying a kit field. */
export const KIT_CLIPBOARD_CLEAR_MS = 60_000;

/** Number of words asked again to check that the phrase was written down. */
export const KIT_CHECK_WORDS = 3;

export interface KitInput {
  phrase: string;
  owner: string;
  /** HTTPS read address of the storage; null in local-only mode. */
  readAddress: string | null;
  /** Storage protocol ("Nextcloud", "S3"…); null in local-only mode. */
  protocol: string | null;
  /** Owner's first name, for the entry title. */
  name: string;
  /** When the kit is made (printed date). */
  date: Date;
}

/** A password-manager entry with the usual fields. */
export interface KitEntry {
  title: string;
  password: string;
  url: string;
  notes: string;
}

export function phraseWords(phrase: string): string[] {
  return phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Short fingerprint of the owner key, to recognise it (not a security check):
 * the first 16 bytes of the master public key in 8 groups of 4 hex digits.
 */
export function keyFingerprint(owner: string): string {
  const pk = parseKey('ed25519', owner, 'owner');
  const hex = Array.from(pk.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{4}/g)!.join(' ');
}

const field = (t: TFunction, key: string, value: string) => t('kit.labelValue', { label: t(key), value });

export function kitEntry(k: KitInput, t: TFunction): KitEntry {
  const notes = [
    field(t, 'kit.field.fingerprint', keyFingerprint(k.owner)),
    field(t, 'kit.field.protocol', k.protocol ?? t('kit.localOnlyProtocol')),
    ...(k.readAddress ? [] : [t('kit.localOnlyNote')]),
    t('kit.entryHelp'),
  ].join('\n');
  return {
    title: k.name.trim() ? t('kit.entryTitleNamed', { name: k.name.trim() }) : t('kit.entryTitle'),
    password: phraseWords(k.phrase).join(' '),
    url: k.readAddress ?? '',
    notes,
  };
}

/** Text shared to a password manager (share sheet): one labelled field per line. */
export function passwordManagerText(e: KitEntry, t: TFunction): string {
  return [
    field(t, 'kit.field.title', e.title),
    field(t, 'kit.field.password', e.password),
    field(t, 'kit.field.url', e.url || '—'),
    field(t, 'kit.field.notes', ''),
    e.notes,
  ].join('\n');
}

/** Fields offered one by one for the clipboard (paste into any manager). */
export function clipboardFields(e: KitEntry, t: TFunction): { key: 'phrase' | 'address' | 'notes'; label: string; value: string }[] {
  return [
    { key: 'phrase' as const, label: t('kit.copy.phrase'), value: e.password },
    ...(e.url ? [{ key: 'address' as const, label: t('kit.copy.address'), value: e.url }] : []),
    { key: 'notes' as const, label: t('kit.copy.notes'), value: e.notes },
  ];
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/**
 * Printable page (expo-print on native, a print view on web): the numbered
 * words, the address (or the local-only note), the fingerprint, what to do
 * with it. Self-contained HTML, no external resource.
 */
export function printableKitHtml(k: KitInput, t: TFunction, locale: string): string {
  const words = phraseWords(k.phrase);
  const date = k.date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  const cells = words.map((w, i) => `<li><span class="n">${i + 1}</span><span class="w">${esc(w)}</span></li>`).join('');
  const address = k.readAddress
    ? `<p><strong>${esc(t('kit.field.url'))}</strong><br><span class="mono">${esc(k.readAddress)}</span></p>`
    : `<p class="note">${esc(t('kit.localOnlyNote'))}</p>`;
  return `<!doctype html><html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t('kit.printTitle'))}</title>
<style>
body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0F172A;background:#fff;margin:0;padding:32px;max-width:720px}
h1{font-size:24px;margin:0 0 4px}.sub{color:#475569;margin:0 0 24px}
ol{list-style:none;padding:0;margin:0 0 24px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
li{border:1px solid #CBD5E1;border-radius:8px;padding:10px 12px;display:flex;gap:10px;align-items:baseline}
.n{color:#64748B;font-size:13px;min-width:1.5em}.w{font-size:18px;font-weight:700;letter-spacing:.02em}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}.note{border-left:4px solid #D97706;padding:8px 12px;background:#FEF3C7}
.small{color:#475569;font-size:13px}@media print{body{padding:0}}
</style></head><body>
<h1>${esc(t('kit.printTitle'))}</h1>
<p class="sub">${esc(k.name.trim() || t('kit.entryTitle'))} · ${esc(date)}</p>
<p><strong>${esc(t('kit.phraseLabel'))}</strong></p>
<ol>${cells}</ol>
${address}
<p><strong>${esc(t('kit.field.fingerprint'))}</strong><br><span class="mono">${esc(keyFingerprint(k.owner))}</span></p>
<p class="small">${esc(t('kit.printHelp'))}</p>
</body></html>`;
}

/** `count` distinct word positions (0-based, sorted) to ask again. */
export function pickCheckIndexes(random: () => number = Math.random, count = KIT_CHECK_WORDS, total = 12): number[] {
  const pool = Array.from({ length: total }, (_, i) => i);
  const out: number[] = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  return out.sort((a, b) => a - b);
}

/** Per asked position: does the typed word match (case, accents and spaces ignored)? */
export function checkWords(phrase: string, indexes: readonly number[], typed: readonly string[]): boolean[] {
  const words = phraseWords(phrase);
  return indexes.map((i, n) => {
    const got = (typed[n] ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
    return got.length > 0 && got === words[i];
  });
}
