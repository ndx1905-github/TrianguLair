/**
 * Tiny i18n core (pure, unit-tested): flat message keys, `{name}`
 * placeholders and plural forms chosen with Intl.PluralRules (built-in rules
 * where the engine has none, as on Hermes). Enough for v1's
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

/**
 * Cardinal plural rules of the supported locales (CLDR), for engines without
 * Intl.PluralRules: Hermes, the phone's JavaScript engine, only has Collator,
 * DateTimeFormat and NumberFormat. Integers and decimals as `count` gives them.
 */
export function fallbackPluralCategory(locale: string, n: number): Intl.LDMLPluralRule {
  const abs = Math.abs(n);
  const integer = Number.isInteger(abs);
  if (locale.toLowerCase().split(/[-_]/)[0] === 'fr') {
    // one: i = 0,1; many: e = 0 and i != 0 and i % 1000000 = 0 (and v = 0 for integers).
    if (abs < 2) return 'one';
    if (integer && abs % 1_000_000 === 0) return 'many';
    return 'other';
  }
  // English (and the default): one: i = 1 and v = 0.
  return abs === 1 && integer ? 'one' : 'other';
}

const pluralRules = new Map<string, Intl.PluralRules | null>();
function pluralCategory(locale: string, n: number): Intl.LDMLPluralRule {
  let r = pluralRules.get(locale);
  if (r === undefined) {
    r = typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function' ? new Intl.PluralRules(locale) : null;
    pluralRules.set(locale, r);
  }
  return r ? r.select(n) : fallbackPluralCategory(locale, n);
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
