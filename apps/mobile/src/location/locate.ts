/**
 * "Where am I?", once (spec: "position is used only to center the map", no continuous geolocation,
 * no history). The platform part is a `LocationBackend`:
 * - Android (`backend.android.ts`): the local module `modules/tl-location`, on Android's own
 *   LocationManager, so that it works without Google Play services (F-Droid);
 * - iOS and web (`backend.ts`): expo-location (CoreLocation, the browser's geolocation).
 * This file is the shared, platform-free logic: permission, a recent last known position first,
 * else one fresh fix with a timeout, else an older last known position.
 */

export interface Fix {
  lat: number;
  lon: number;
  /** Radius in meters, when the platform gives one. */
  accuracyM: number | null;
  /** How old the fix is, in milliseconds, when known. */
  ageMs: number | null;
}

/** What a backend returns: checked by `toFix` before use. */
export interface RawFix {
  latitude?: unknown;
  longitude?: unknown;
  accuracy?: unknown;
  ageMs?: unknown;
}

export interface LocationBackend {
  /** Asks for the permission if it is not granted yet. */
  requestPermission(): Promise<'granted' | 'denied'>;
  /** Location turned on in the system settings. */
  servicesEnabled(): Promise<boolean>;
  /** The newest position the system already knows, if not older than maxAgeMs. */
  lastKnown(maxAgeMs: number): Promise<RawFix | null>;
  /** One fresh position, or null when none came within timeoutMs. */
  current(timeoutMs: number): Promise<RawFix | null>;
}

export type LocateFailure = 'denied' | 'disabled' | 'unavailable';

export type LocateResult =
  | { ok: true; fix: Fix; /** An older last known position: no fresh fix came in time. */ stale: boolean }
  | { ok: false; reason: LocateFailure };

export interface LocateOptions {
  /** A last known position younger than this is used at once. */
  freshMs: number;
  /** How long to wait for a fresh fix. */
  timeoutMs: number;
  /** When no fresh fix comes: a last known position younger than this is still better than nothing. */
  staleMs: number;
}

export const LOCATE_DEFAULTS: LocateOptions = { freshMs: 2 * 60_000, timeoutMs: 15_000, staleMs: 24 * 3600_000 };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A usable position from what a backend returned, or null. */
export function toFix(raw: RawFix | null | undefined): Fix | null {
  if (!raw || typeof raw !== 'object') return null;
  const lat = num(raw.latitude);
  const lon = num(raw.longitude);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const accuracy = num(raw.accuracy);
  const age = num(raw.ageMs);
  return { lat, lon, accuracyM: accuracy !== null && accuracy >= 0 ? accuracy : null, ageMs: age !== null && age >= 0 ? age : null };
}

/** Resolves to `fallback` when `work` fails or takes longer than `ms` (a platform call can hang). */
export function within<T>(work: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    let p: Promise<T>;
    try {
      p = work();
    } catch {
      clearTimeout(timer);
      resolve(fallback);
      return;
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Extra time given to a backend past its own timeout before giving up on it. */
const GRACE_MS = 3_000;

export async function locate(backend: LocationBackend, opts: LocateOptions = LOCATE_DEFAULTS): Promise<LocateResult> {
  let permission: 'granted' | 'denied';
  try {
    permission = await backend.requestPermission();
  } catch {
    // No location support at all here (e.g. no native module).
    return { ok: false, reason: 'unavailable' };
  }
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const recent = toFix(await within(() => backend.lastKnown(opts.freshMs), GRACE_MS, null));
  if (recent) return { ok: true, fix: recent, stale: false };

  if (!(await within(() => backend.servicesEnabled(), GRACE_MS, true))) return { ok: false, reason: 'disabled' };

  const fresh = toFix(await within(() => backend.current(opts.timeoutMs), opts.timeoutMs + GRACE_MS, null));
  if (fresh) return { ok: true, fix: fresh, stale: false };

  const old = toFix(await within(() => backend.lastKnown(opts.staleMs), GRACE_MS, null));
  if (old) return { ok: true, fix: old, stale: true };
  return { ok: false, reason: 'unavailable' };
}

/** The zoom to center on a position: close enough to see the street, never zooming out. */
export function zoomForFix(fix: Fix, currentZoom: number | null | undefined): number {
  // A coarse fix (network, approximate permission) gets a wider view.
  const target = fix.accuracyM !== null && fix.accuracyM > 1000 ? 13 : 16;
  return Math.max(currentZoom ?? 0, target);
}
