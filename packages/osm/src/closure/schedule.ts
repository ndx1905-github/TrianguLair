/**
 * Monthly schedule of the closed-place check (pure).
 *
 * SPEC: every saved place is rechecked once a month, in small batches when
 * the app is opened (no periodic background task, for F-Droid), and also
 * when its card is opened if the last check is more than a month old. The
 * grouped notice is shown at most once a month.
 */
import type { OsmRef } from '../types.ts';
import type { PlaceStatus } from './signals.ts';

export const CHECK_INTERVAL_DAYS = 30;
export const NOTICE_INTERVAL_DAYS = 30;
/** Default batch: one Overpass query (see ELEMENT_BATCH_SIZE). */
export const DEFAULT_CHECK_BATCH = 100;

const DAY = 24 * 3600_000;

export interface CheckState {
  /** Places without an OSM reference (manual points) are never checked. */
  ref?: OsmRef | null;
  /** ISO 8601, or null/undefined if never checked. */
  lastCheckedAt?: string | null;
  /** A place the user confirmed closed is no longer checked. */
  status?: PlaceStatus;
}

export interface ScheduleOptions {
  intervalDays?: number;
}

/** Whether a place is due for a check at `now`. */
export function isCheckDue(state: CheckState, now: Date = new Date(), opts: ScheduleOptions = {}): boolean {
  if (!state.ref || state.status === 'closed') return false;
  if (!state.lastCheckedAt) return true;
  const last = Date.parse(state.lastCheckedAt);
  if (Number.isNaN(last)) return true;
  // A clock set back (last check "in the future") counts as due, so a wrong date cannot block checks forever.
  if (last > now.getTime() + DAY) return true;
  return now.getTime() - last >= (opts.intervalDays ?? CHECK_INTERVAL_DAYS) * DAY;
}

/** Card opened: check now if the last check is more than a month old. */
export const shouldCheckOnCardOpen = isCheckDue;

/**
 * The places to check when the app opens: due ones, never-checked first,
 * then oldest check first, at most `maxBatch`.
 */
export function placesDueForCheck<T extends CheckState>(
  places: readonly T[],
  now: Date = new Date(),
  opts: ScheduleOptions & { maxBatch?: number } = {},
): T[] {
  const due = places.filter((p) => isCheckDue(p, now, opts));
  const t = (p: T) => (p.lastCheckedAt ? Date.parse(p.lastCheckedAt) || 0 : -Infinity);
  due.sort((a, b) => t(a) - t(b));
  return due.slice(0, opts.maxBatch ?? DEFAULT_CHECK_BATCH);
}

/** Date of the next check of a place (null when it is never checked). */
export function nextCheckAt(state: CheckState, opts: ScheduleOptions = {}): Date | null {
  if (!state.ref || state.status === 'closed') return null;
  if (!state.lastCheckedAt) return new Date(0);
  return new Date(Date.parse(state.lastCheckedAt) + (opts.intervalDays ?? CHECK_INTERVAL_DAYS) * DAY);
}

/** Grouped "maybe closed" notice: only with pending places, at most once a month. */
export function shouldShowClosureNotice(
  lastNoticeAt: string | null | undefined,
  pendingCount: number,
  now: Date = new Date(),
  opts: { intervalDays?: number } = {},
): boolean {
  if (pendingCount <= 0) return false;
  if (!lastNoticeAt) return true;
  const last = Date.parse(lastNoticeAt);
  if (Number.isNaN(last) || last > now.getTime() + DAY) return true;
  return now.getTime() - last >= (opts.intervalDays ?? NOTICE_INTERVAL_DAYS) * DAY;
}
