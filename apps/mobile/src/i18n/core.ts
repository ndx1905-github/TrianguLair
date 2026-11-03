/**
 * Tiny i18n core (pure, unit-tested): flat message keys, `{name}`
 * placeholders and plural forms chosen with Intl.PluralRules. Enough for v1's
 * English and French; the messages can move to ICU files (Weblate) later
 * without changing call sites.
 */
export type PluralMessage = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
export type Message = string | PluralMessage;
export type Messages = Record<string, Message>;
export type Params = Record<string, string | number>;

export const SUPPORTED_LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Picks a supported locale from BCP-47 tags in preference order ("fr-CA" -> "fr"). */
export function pickLocale(tags: readonly (string | null | undefined)[], fallback: Locale = 'en'): Locale {
  for (const tag of tags) {
    if (!tag) continue;
    const base = tag.toLowerCase().split(/[-_]/)[0];
    const hit = SUPPORTED_LOCALES.find((l) => l === base);
    if (hit) return hit;
  }
  return fallback;
}

function interpolate(text: string, params: Params | undefined): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralCategory(locale: string, n: number): Intl.LDMLPluralRule {
  let r = pluralRules.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    pluralRules.set(locale, r);
  }
  return r.select(n);
}

/**
 * Translates `key`. Plural messages use `params.count`. Missing keys fall back
 * to the fallback dictionary, then to the key itself (visible in the UI, so a
 * gap is noticed rather than hidden).
 */
export function translate(
  locale: string,
  dict: Messages,
  fallback: Messages,
  key: string,
  params?: Params,
): string {
  const msg = dict[key] ?? fallback[key];
  if (msg === undefined) return key;
  if (typeof msg === 'string') return interpolate(msg, params);
  const count = Number(params?.count ?? 0);
  const form = count === 0 && msg.zero !== undefined ? msg.zero : (msg[pluralCategory(locale, count)] ?? msg.other);
  return interpolate(form, params);
}

/** Keys used in `dict` but whose placeholders differ from the reference (for tests). */
export function placeholderMismatches(reference: Messages, dict: Messages): string[] {
  const names = (m: Message) =>
    [...new Set((typeof m === 'string' ? [m] : Object.values(m)).join(' ').match(/\{\w+\}/g) ?? [])].sort().join(',');
  return Object.keys(reference).filter((k) => dict[k] !== undefined && names(reference[k]!) !== names(dict[k]!));
}
