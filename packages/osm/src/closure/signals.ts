/**
 * Closed-place detection, pure part: signals from an OSM observation and
 * from user/friend reports, and the resulting status (SPEC "Closed place
 * detection").
 *
 * Nothing here ever decides "closed" on its own: signals make a place
 * "maybe closed", and only the user's confirmation makes it "closed".
 */
import { type CategoryId, LIFECYCLE_PREFIXES, PRIMARY_KEYS, categorize } from '../categories.ts';
import { isPermanentlyOff } from '../opening-hours.ts';
import type { LatLon, OsmElement } from '../types.ts';

export type PlaceStatus = 'open' | 'maybe_closed' | 'closed';
export type Reliability = 'low' | 'medium' | 'high';

export type ClosureSignalCode =
  | 'deleted'
  | 'not_found'
  | 'lifecycle_prefix'
  | 'lifecycle_tag'
  | 'shop_vacant'
  | 'end_date_past'
  | 'name_changed'
  | 'category_changed'
  | 'opening_hours_removed'
  | 'opening_hours_off'
  | 'user_report'
  | 'friend_report';

export interface ClosureSignal {
  code: ClosureSignalCode;
  reliability: Reliability;
  source: 'osm' | 'user' | 'friend';
  /** English explanation for the badge ("Tagged disused:amenity=restaurant"); the app may translate by code. */
  detail: string;
  /** When the evidence appeared, when known (OSM edit or deletion time, report time). ISO 8601. */
  since?: string;
  /** When this check saw it. ISO 8601. */
  observedAt: string;
  /** OSM version the signal was read from. */
  osmVersion?: number;
  /** Structured details: tag, previous/current values. */
  data?: Record<string, string>;
}

/** What the app stored at the previous check, to detect changes. */
export interface PlaceSnapshot {
  name?: string;
  category?: CategoryId;
  openingHours?: string;
  version?: number;
  location?: LatLon;
}

/** What OSM says about the element now. */
export type OsmObservation =
  | { kind: 'present'; element: OsmElement }
  /** Deletion confirmed (OSM API 410 Gone). */
  | { kind: 'deleted'; deletedAt?: string; lastVersion?: OsmElement }
  /** Overpass does not return it and the deletion could not be confirmed. */
  | { kind: 'missing' };

export function snapshotOf(el: OsmElement): PlaceSnapshot {
  const tags = el.tags ?? {};
  const s: PlaceSnapshot = {};
  if (tags.name) s.name = tags.name;
  const cat = categorize(tags);
  if (cat && !cat.lifecyclePrefix) s.category = cat.category;
  if (tags.opening_hours) s.openingHours = tags.opening_hours;
  if (el.version !== undefined) s.version = el.version;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat !== undefined && lon !== undefined) s.location = { lat, lon };
  return s;
}

/** Name comparison that ignores case, accents, punctuation and spacing. */
export function sameName(a: string, b: string): boolean {
  const n = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
  return n(a) === n(b);
}

/** `end_date` (YYYY, YYYY-MM or YYYY-MM-DD) strictly before `now`'s day. */
export function endDatePassed(value: string, now: Date): boolean {
  const m = /^\s*(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?\s*$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  // The end is the last day of the given period.
  const end = m[3]
    ? new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3]) + 1))
    : m[2]
      ? new Date(Date.UTC(y, Number(m[2]), 1))
      : new Date(Date.UTC(y + 1, 0, 1));
  return now.getTime() >= end.getTime();
}

/** Signals from OSM. `previous` is the snapshot stored at the last check (if any). */
export function osmSignals(obs: OsmObservation, previous: PlaceSnapshot | undefined, now: Date = new Date()): ClosureSignal[] {
  const observedAt = now.toISOString();
  if (obs.kind === 'deleted') {
    return [
      {
        code: 'deleted',
        reliability: 'high',
        source: 'osm',
        detail: 'Deleted from OpenStreetMap',
        ...(obs.deletedAt ? { since: obs.deletedAt } : {}),
        observedAt,
      },
    ];
  }
  if (obs.kind === 'missing') {
    return [{ code: 'not_found', reliability: 'high', source: 'osm', detail: 'No longer in OpenStreetMap', observedAt }];
  }

  const el = obs.element;
  const tags = el.tags ?? {};
  const out: ClosureSignal[] = [];
  const base = {
    source: 'osm' as const,
    observedAt,
    ...(el.timestamp ? { since: el.timestamp } : {}),
    ...(el.version !== undefined ? { osmVersion: el.version } : {}),
  };
  const live = PRIMARY_KEYS.some((k) => tags[k] !== undefined && tags[k] !== 'vacant' && tags[k] !== 'no');

  // Lifecycle prefixes: disused:shop=…, was:amenity=…, abandoned:…
  for (const prefix of LIFECYCLE_PREFIXES) {
    for (const key of PRIMARY_KEYS) {
      const v = tags[`${prefix}:${key}`];
      if (v === undefined) continue;
      out.push({
        ...base,
        code: 'lifecycle_prefix',
        // With a live main tag too, it records a previous use (a new business may be there).
        reliability: live ? 'medium' : 'high',
        detail: `Tagged ${prefix}:${key}=${v}`,
        data: { key: `${prefix}:${key}`, value: v },
      });
    }
  }
  for (const k of ['disused', 'abandoned']) {
    if (tags[k] === 'yes') out.push({ ...base, code: 'lifecycle_tag', reliability: 'high', detail: `Tagged ${k}=yes`, data: { key: k, value: 'yes' } });
  }
  if (tags.shop === 'vacant' || tags.amenity === 'vacant') {
    out.push({ ...base, code: 'shop_vacant', reliability: 'high', detail: 'Premises marked vacant', data: { key: tags.shop === 'vacant' ? 'shop' : 'amenity', value: 'vacant' } });
  }
  if (tags.end_date && endDatePassed(tags.end_date, now)) {
    out.push({ ...base, code: 'end_date_past', reliability: 'high', detail: `Ended on ${tags.end_date.trim()}`, data: { key: 'end_date', value: tags.end_date } });
  }

  // Change signals only add noise once a lifecycle signal already says "closed".
  const lifecycle = out.length > 0;
  if (previous?.name) {
    if (!tags.name) {
      if (!lifecycle) {
        out.push({ ...base, code: 'name_changed', reliability: 'medium', detail: `Name "${previous.name}" removed`, data: { previous: previous.name } });
      }
    } else if (!sameName(previous.name, tags.name)) {
      out.push({
        ...base,
        code: 'name_changed',
        reliability: 'medium',
        detail: `Name changed from "${previous.name}" to "${tags.name}"`,
        data: { previous: previous.name, current: tags.name },
      });
    }
  }
  const cat = categorize(tags);
  if (!lifecycle && previous?.category && cat && !cat.lifecyclePrefix && cat.category !== previous.category) {
    out.push({
      ...base,
      code: 'category_changed',
      reliability: 'medium',
      detail: `Category changed from ${previous.category} to ${cat.category}`,
      data: { previous: previous.category, current: cat.category },
    });
  }

  if (isPermanentlyOff(tags.opening_hours)) {
    out.push({ ...base, code: 'opening_hours_off', reliability: 'low', detail: `Opening hours set to "${tags.opening_hours}"`, data: { value: tags.opening_hours! } });
  } else if (previous?.openingHours && !tags.opening_hours && out.length === 0) {
    out.push({ ...base, code: 'opening_hours_removed', reliability: 'low', detail: 'Opening hours removed', data: { previous: previous.openingHours } });
  }
  return out;
}

export interface ClosureReport {
  /** `me` for my own report, or the friend's person id. */
  by: 'me' | string;
  kind: 'closed' | 'open' | 'moved';
  reportedAt: string;
}

/** Signals from "closed" reports: mine or a friend's (medium), high from 2 distinct reporters. */
export function reportSignals(reports: ClosureReport[], now: Date = new Date()): ClosureSignal[] {
  // Latest report per person wins (a friend may say "closed" then "open").
  const latest = new Map<string, ClosureReport>();
  for (const r of [...reports].sort((a, b) => a.reportedAt.localeCompare(b.reportedAt))) latest.set(r.by, r);
  const closed = [...latest.values()].filter((r) => r.kind === 'closed');
  const reliability: Reliability = closed.length >= 2 ? 'high' : 'medium';
  return closed.map((r) => ({
    code: r.by === 'me' ? ('user_report' as const) : ('friend_report' as const),
    reliability,
    source: r.by === 'me' ? ('user' as const) : ('friend' as const),
    detail: r.by === 'me' ? 'You reported it closed' : 'A friend reported it closed',
    since: r.reportedAt,
    observedAt: now.toISOString(),
    ...(r.by === 'me' ? {} : { data: { by: r.by } }),
  }));
}

/** The user's answer to a "maybe closed" notice. */
export interface UserResolution {
  decision: 'closed' | 'still_open' | 'moved';
  decidedAt: string;
}

export interface ClosureAssessment {
  status: PlaceStatus;
  /** Signals still standing after the user's last answer, strongest first. */
  signals: ClosureSignal[];
  reliability?: Reliability;
  /** Earliest known date of the standing signals ("maybe closed since"). */
  since?: string;
  /** True when the app should offer to fix OSM (signal from users only, SPEC step 5). */
  suggestOsmEdit: boolean;
}

const RANK: Record<Reliability, number> = { low: 0, medium: 1, high: 2 };

/**
 * Combines signals with the user's last answer:
 * - "closed" confirmed by the user → closed;
 * - "still open"/"moved" dismisses signals whose evidence is not newer than
 *   the answer (signals with no known date are dismissed too: the user saw them);
 * - any remaining signal at or above `minReliability` → maybe closed.
 */
export function assessClosure(
  signals: ClosureSignal[],
  resolution?: UserResolution,
  opts: { minReliability?: Reliability } = {},
): ClosureAssessment {
  const min = RANK[opts.minReliability ?? 'low'];
  let standing = signals.filter((s) => RANK[s.reliability] >= min);
  if (resolution && resolution.decision !== 'closed') {
    standing = standing.filter((s) => s.since !== undefined && s.since > resolution.decidedAt);
  }
  standing.sort((a, b) => RANK[b.reliability] - RANK[a.reliability]);
  const reliability = standing[0]?.reliability;
  const dates = standing.map((s) => s.since).filter((d): d is string => !!d).sort();
  const fromOsm = standing.some((s) => s.source === 'osm');
  const status: PlaceStatus = resolution?.decision === 'closed' ? 'closed' : standing.length > 0 ? 'maybe_closed' : 'open';
  return {
    status,
    signals: standing,
    ...(reliability ? { reliability } : {}),
    ...(dates[0] ? { since: dates[0] } : {}),
    // OSM does not know yet: the information comes from people only.
    suggestOsmEdit: !fromOsm && (status === 'closed' || standing.length > 0),
  };
}
