/**
 * opening_hours / happy_hours interpretation, on top of opening_hours.js
 * (pure JS, no DOM; its only runtime dependency is suncalc).
 *
 * Times are evaluated in the device's local time zone, which is the place's
 * time zone in the common case (the user is near the place).
 *
 * Public and school holidays need the place's country (and, for some
 * countries, its state). Without it, rules that only apply on holidays are
 * dropped and the result is flagged `holidaysIgnored`; if that is not
 * possible the state is `unknown`.
 */
import OpeningHours from 'opening_hours';

export interface OpeningContext {
  lat?: number;
  lon?: number;
  /** ISO 3166-1 alpha-2 (any case). */
  countryCode?: string;
  /** State/region name as opening_hours.js expects it (e.g. "Bayern" for DE). */
  state?: string;
}

export type UnknownReason = 'missing' | 'unparseable' | 'unknown' | 'holidays_unavailable';

export type OpeningStatus =
  | {
      state: 'open';
      /** When it closes (next change within the horizon); absent for 24/7. */
      closesAt?: Date;
      comment?: string;
      holidaysIgnored?: boolean;
    }
  | {
      state: 'closed';
      /** Next opening within the horizon; absent when it never opens (e.g. `off`). */
      opensAt?: Date;
      comment?: string;
      holidaysIgnored?: boolean;
    }
  | {
      state: 'unknown';
      reason: UnknownReason;
      /** The next time the state changes, if known (for "unknown" ranges like `10:00+`). */
      nextChange?: Date;
      comment?: string;
      /** The raw value, shown as-is when it cannot be interpreted. */
      raw?: string;
      holidaysIgnored?: boolean;
    };

type Parsed = { ok: true; oh: OpeningHours; holidaysIgnored: boolean } | { ok: false; reason: UnknownReason; error: string };

const HORIZON_MS = 8 * 24 * 3600_000;
const MEMO_MAX = 2000;
const memo = new Map<string, Parsed>();

const HOLIDAY_TOKEN = /\b(PH|SH)\b/;

/**
 * Drops holiday-only rules and holiday tokens from weekday lists:
 * "Mo-Fr 10:00-18:00; PH off" → "Mo-Fr 10:00-18:00", "Mo-Fr,PH 10:00-12:00" → "Mo-Fr 10:00-12:00".
 * Returns null if nothing usable remains.
 */
export function stripHolidayRules(value: string): string | null {
  const rules = value
    .split(';')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) =>
      r
        .replace(/\b(PH|SH)\s*(\+|-)\s*\d+\s*days?\b/g, '$1')
        .replace(/,\s*(PH|SH)\b/g, '')
        .replace(/\b(PH|SH)\s*,\s*/g, ''),
    )
    .filter((r) => !/^(PH|SH)\b/.test(r) && !/^"[^"]*"$/.test(r));
  if (rules.length === 0 || rules.some((r) => HOLIDAY_TOKEN.test(r))) return null;
  return rules.join('; ');
}

type OhConf = ConstructorParameters<typeof OpeningHours>[2];

/**
 * The library's "nominatim object". Two traps, contrary to its typings:
 * lat/lon must be strings (they are ignored otherwise), and `null` silently
 * means "somewhere in Baden-Württemberg" (German holidays); `undefined`
 * means unknown location.
 */
function nominatimObject(ctx: OpeningContext): ConstructorParameters<typeof OpeningHours>[1] {
  const hasPoint = ctx.lat !== undefined && ctx.lon !== undefined;
  if (!hasPoint && !ctx.countryCode) return undefined;
  const obj: Record<string, unknown> = {
    address: { country_code: (ctx.countryCode ?? '').toLowerCase(), state: ctx.state ?? '' },
  };
  if (hasPoint) {
    obj.lat = String(ctx.lat);
    obj.lon = String(ctx.lon);
  }
  return obj as unknown as ConstructorParameters<typeof OpeningHours>[1];
}

function tryParse(value: string, ctx: OpeningContext, tagKey: string): Parsed {
  try {
    // mode 0 = time ranges (the `mode` enum is type-only in the library's typings).
    const conf = { tag_key: tagKey, mode: 0, map_value: false, warnings_severity: 4, locale: 'en' } as unknown as OhConf;
    const oh = new OpeningHours(value, nominatimObject(ctx), conf);
    return { ok: true, oh, holidaysIgnored: false };
  } catch (e) {
    return { ok: false, reason: 'unparseable', error: String(e) };
  }
}

/** Parses (memoized) a value; `parse` never throws. */
export function parseOpeningHours(value: string, ctx: OpeningContext = {}, tagKey = 'opening_hours'): Parsed {
  const key = `${tagKey}|${value}|${ctx.countryCode ?? ''}|${ctx.state ?? ''}|${ctx.lat?.toFixed(1) ?? ''}|${ctx.lon?.toFixed(1) ?? ''}`;
  const hit = memo.get(key);
  if (hit) return hit;
  let parsed: Parsed;
  if (HOLIDAY_TOKEN.test(value) && !ctx.countryCode) {
    const stripped = stripHolidayRules(value);
    const p = stripped ? tryParse(stripped, ctx, tagKey) : null;
    if (p?.ok) parsed = { ...p, holidaysIgnored: true };
    else if (tryParse(value, ctx, tagKey).ok) parsed = { ok: false, reason: 'holidays_unavailable', error: 'Country needed for holidays' };
    else parsed = { ok: false, reason: 'unparseable', error: 'Invalid value' };
  } else {
    parsed = tryParse(value, ctx, tagKey);
  }
  memo.set(key, parsed);
  if (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return parsed;
}

function holidayError(e: unknown): boolean {
  return /holiday|country/i.test(String(e));
}

/**
 * State at `at` (default now): open (and until when), closed (and when it
 * opens), or unknown with a reason. Never throws.
 */
export function openingStatus(
  value: string | undefined,
  at: Date = new Date(),
  ctx: OpeningContext = {},
  tagKey = 'opening_hours',
): OpeningStatus {
  if (!value || !value.trim()) return { state: 'unknown', reason: 'missing' };
  const raw = value.trim();
  const p = parseOpeningHours(raw, ctx, tagKey);
  if (!p.ok) return { state: 'unknown', reason: p.reason, raw };
  const extra = p.holidaysIgnored ? { holidaysIgnored: true as const } : {};
  try {
    const comment = p.oh.getComment(at);
    const withComment = comment ? { comment } : {};
    const next = p.oh.getNextChange(at, new Date(at.getTime() + HORIZON_MS));
    if (p.oh.getUnknown(at)) {
      return { state: 'unknown', reason: 'unknown', ...(next ? { nextChange: next } : {}), ...withComment, raw, ...extra };
    }
    if (p.oh.getState(at)) {
      return { state: 'open', ...(next ? { closesAt: next } : {}), ...withComment, ...extra };
    }
    return { state: 'closed', ...(next ? { opensAt: next } : {}), ...withComment, ...extra };
  } catch (e) {
    return { state: 'unknown', reason: holidayError(e) ? 'holidays_unavailable' : 'unparseable', raw, ...extra };
  }
}

/**
 * Context of a place: its point and `addr:country`, with a fallback country
 * (e.g. from reverse geocoding or the device region) when the tag is absent.
 */
export function openingContextOf(
  place: { location: { lat: number; lon: number } | null; address: { country?: string } },
  fallbackCountry?: string,
): OpeningContext {
  const ctx: OpeningContext = {};
  if (place.location) {
    ctx.lat = place.location.lat;
    ctx.lon = place.location.lon;
  }
  const cc = place.address.country ?? fallbackCountry;
  if (cc) ctx.countryCode = cc;
  return ctx;
}

/** For the "open now / open at a chosen time" filter: true, false, or null when unknown. */
export function isOpenAt(value: string | undefined, at: Date, ctx: OpeningContext = {}): boolean | null {
  const s = openingStatus(value, at, ctx);
  return s.state === 'unknown' ? null : s.state === 'open';
}

/** Open intervals between two dates (for a week view). Empty when unparseable. */
export function openIntervals(
  value: string | undefined,
  from: Date,
  to: Date,
  ctx: OpeningContext = {},
): Array<{ from: Date; to: Date; unknown: boolean; comment?: string }> {
  if (!value) return [];
  const p = parseOpeningHours(value.trim(), ctx);
  if (!p.ok) return [];
  try {
    return p.oh.getOpenIntervals(from, to).map(([f, t, unknown, comment]) => ({
      from: f,
      to: t,
      unknown,
      ...(comment ? { comment } : {}),
    }));
  } catch {
    return [];
  }
}

/** True when the value says the place is permanently closed (`off`, `closed`). Used as a weak closure signal. */
export function isPermanentlyOff(value: string | undefined): boolean {
  if (!value) return false;
  return /^\s*(off|closed)\s*(?:"[^"]*")?\s*$/i.test(value);
}

export type HappyHourStatus =
  | { state: 'active'; until?: Date }
  | { state: 'inactive'; startsAt?: Date }
  | { state: 'unknown'; reason: UnknownReason };

/** Happy hour from `happy_hours` (opening_hours syntax): "Happy hour until 8 pm". */
export function happyHourStatus(value: string | undefined, at: Date = new Date(), ctx: OpeningContext = {}): HappyHourStatus {
  const s = openingStatus(value, at, ctx, 'happy_hours');
  if (s.state === 'open') return { state: 'active', ...(s.closesAt ? { until: s.closesAt } : {}) };
  if (s.state === 'closed') return { state: 'inactive', ...(s.opensAt ? { startsAt: s.opensAt } : {}) };
  return { state: 'unknown', reason: s.reason };
}

// ---------------------------------------------------------------------------
// Display helpers (English; the app translates through its own i18n, these
// are the reference wording and a fallback).

/** "8 pm", "8:30 pm" in English; the locale's own clock elsewhere. */
export function formatClock(d: Date, locale = 'en'): string {
  if (locale.startsWith('en')) {
    const h = d.getHours();
    const m = d.getMinutes();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const suffix = h < 12 ? 'am' : 'pm';
    if (h === 0 && m === 0) return 'midnight';
    if (h === 12 && m === 0) return 'noon';
    return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
  }
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(d);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function when(d: Date, now: Date): string {
  if (sameDay(d, now)) return `at ${formatClock(d)}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameDay(d, tomorrow)) return `tomorrow at ${formatClock(d)}`;
  const day = new Intl.DateTimeFormat('en', { weekday: 'long' }).format(d);
  return `${day} at ${formatClock(d)}`;
}

/** "Open, closes at 10 pm", "Closed, opens tomorrow at 9 am", "Open 24/7", or null when unknown. */
export function describeOpening(s: OpeningStatus, now: Date = new Date()): string | null {
  if (s.state === 'open') return s.closesAt ? `Open, closes ${when(s.closesAt, now)}` : 'Open 24/7';
  if (s.state === 'closed') return s.opensAt ? `Closed, opens ${when(s.opensAt, now)}` : 'Closed';
  return null;
}

/** "Happy hour until 8 pm", or null when not in progress. */
export function describeHappyHour(s: HappyHourStatus, now: Date = new Date()): string | null {
  if (s.state !== 'active') return null;
  if (!s.until) return 'Happy hour';
  return sameDay(s.until, now) ? `Happy hour until ${formatClock(s.until)}` : `Happy hour until ${when(s.until, now).replace(/^at /, '')}`;
}
