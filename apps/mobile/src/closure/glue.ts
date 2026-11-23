/**
 * Closed-place check in the app (T-113), pure glue between the data package
 * (place cache) and the osm package (ClosureChecker, monthly schedule).
 * Unit-tested; the runner is `closure/run.ts`, the hook `useClosureCheck.ts`.
 *
 * - The last check of a place is its `osmSyncedAt`: every OSM refresh of a
 *   saved place goes through the checker, so the card is refreshed "at the
 *   same time as the monthly closure check".
 * - The previous snapshot (to detect a new name or category) is read from
 *   the cached OSM tags, i.e. what the last check saw.
 * - The status and the standing signals are written to the place cache
 *   (`status`, `closedSignals`): the map, the list and public lists see it.
 * - Nothing is ever marked closed without the user: "Confirm closed" and
 *   "Still open" are kept per device (`ResolutionMap`) and fed back into
 *   `assessClosure`, so a dismissed signal does not come back next month.
 */
import { parseOsmPlaceId, type PlaceOsmData, type PlaceRecord } from '@triangulair/data';
import {
  isCheckDue,
  placesDueForCheck,
  shouldShowClosureNotice,
  snapshotOf,
  type CheckInput,
  type CheckResult,
  type ClosureSignal,
  type OsmRef,
  type UserResolution,
} from '@triangulair/osm';

export type ResolutionMap = Record<string, UserResolution>;

export const RESOLUTIONS_KEY = 'closure-resolutions';
export const LAST_NOTICE_KEY = 'closure-last-notice';
/** Places checked per run (one Overpass batch) and runs per app session. */
export const RUN_BATCH = 50;
export const MAX_BATCHES_PER_RUN = 3;
/** A new run when the app comes back to the foreground, at most this often. */
export const RUN_EVERY_MS = 6 * 3600_000;

export function refOf(place: Pick<PlaceRecord, 'id' | 'osmType' | 'osmId'>): OsmRef | null {
  if (place.osmType && place.osmId != null) return { type: place.osmType, id: place.osmId };
  const p = parseOsmPlaceId(place.id);
  return p ? { type: p.osmType, id: p.osmId } : null;
}

export interface CheckCandidate {
  placeId: string;
  ref: OsmRef | null;
  lastCheckedAt: string | null;
  status: PlaceRecord['status'];
}

export function candidateOf(place: Pick<PlaceRecord, 'id' | 'osmType' | 'osmId' | 'osmSyncedAt' | 'status'>): CheckCandidate {
  return {
    placeId: place.id,
    ref: refOf(place),
    lastCheckedAt: place.osmSyncedAt ? new Date(place.osmSyncedAt).toISOString() : null,
    status: place.status,
  };
}

/** My saved OSM places due for a check, never-checked first (at most `max`). */
export function dueCandidates(places: readonly Pick<PlaceRecord, 'id' | 'osmType' | 'osmId' | 'osmSyncedAt' | 'status'>[], now: Date, max = RUN_BATCH): CheckCandidate[] {
  return placesDueForCheck(places.map(candidateOf), now, { maxBatch: max });
}

/** Card opened: check now when the last check is more than a month old. */
export function isDueOnCardOpen(place: Pick<PlaceRecord, 'id' | 'osmType' | 'osmId' | 'osmSyncedAt' | 'status'>, now: Date): boolean {
  return isCheckDue(candidateOf(place), now);
}

export function checkInputOf(place: PlaceRecord, resolution: UserResolution | undefined): CheckInput | null {
  const ref = refOf(place);
  if (!ref) return null;
  const input: CheckInput = { ref };
  if (place.osmTags) {
    const previous = snapshotOf({ type: ref.type, id: ref.id, lat: place.lat, lon: place.lon, tags: { name: place.name, ...place.osmTags } });
    input.previous = previous;
  }
  if (resolution) input.resolution = resolution;
  return input;
}

/** What to write to the place cache after a check. */
export function patchFromResult(result: CheckResult): PlaceOsmData & { name?: string } {
  const patch: PlaceOsmData & { name?: string } = {
    status: result.assessment.status,
    closedSignals: result.assessment.signals,
    osmSyncedAt: Date.parse(result.checkedAt),
  };
  const p = result.place;
  if (p) {
    patch.osmTags = p.tags;
    patch.openingHours = p.openingHours ?? null;
    if (p.address.formatted) patch.address = p.address.formatted;
    patch.website = p.contact.website ?? null;
    patch.phone = p.contact.phones[0] ?? null;
    // A renamed place keeps my snapshot name until I see it; the new name is a closure signal.
  }
  return patch;
}

/** After the user's answer on the card. */
export function patchFromResolution(decision: UserResolution['decision'], signals: ClosureSignal[]): PlaceOsmData {
  if (decision === 'closed') return { status: 'closed', closedSignals: signals };
  return { status: 'open', closedSignals: [] };
}

const SIGNAL_CODES = new Set([
  'deleted', 'not_found', 'not_found_nearby', 'lifecycle_prefix', 'lifecycle_tag', 'shop_vacant', 'end_date_past', 'name_changed',
  'category_changed', 'opening_hours_removed', 'opening_hours_off', 'user_report', 'friend_report',
]);

/** Signals stored on a place (tolerant: anything else is skipped). */
export function readSignals(place: Pick<PlaceRecord, 'closedSignals'>): ClosureSignal[] {
  const list = place.closedSignals;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (s): s is ClosureSignal =>
      !!s && typeof s === 'object' && SIGNAL_CODES.has((s as ClosureSignal).code) && typeof (s as ClosureSignal).observedAt === 'string',
  );
}

/** Earliest date of the signals ("maybe closed since"). */
export function signalsSince(signals: readonly ClosureSignal[]): string | null {
  const dates = signals.map((s) => s.since ?? s.observedAt).filter(Boolean).sort();
  return dates[0] ?? null;
}

export function parseResolutions(raw: string | null | undefined): ResolutionMap {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: ResolutionMap = {};
    for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
      const d = (r as UserResolution | null)?.decision;
      const at = (r as UserResolution | null)?.decidedAt;
      if ((d === 'closed' || d === 'still_open' || d === 'moved') && typeof at === 'string' && !Number.isNaN(Date.parse(at))) {
        out[k] = { decision: d, decidedAt: at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Grouped notice: the maybe-closed places among mine, if one is due (at most monthly). */
export function noticeFor(
  maybeClosed: readonly { id: string; name: string }[],
  lastNoticeAt: string | null,
  now: Date,
): { places: { id: string; name: string }[] } | null {
  return shouldShowClosureNotice(lastNoticeAt, maybeClosed.length, now) ? { places: [...maybeClosed] } : null;
}
