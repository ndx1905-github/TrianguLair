/**
 * Location on iOS and web: expo-location (CoreLocation on iOS, the browser's geolocation on web).
 * Android uses `backend.android.ts` instead (no Google Play services). See `locate.ts`.
 */
import * as Location from 'expo-location';

import type { LocationBackend, RawFix } from './locate';

const raw = (p: Location.LocationObject): RawFix => ({
  latitude: p.coords.latitude,
  longitude: p.coords.longitude,
  accuracy: p.coords.accuracy,
  ageMs: Math.max(0, Date.now() - p.timestamp),
});

export const backend: LocationBackend = {
  async requestPermission() {
    const p = await Location.requestForegroundPermissionsAsync();
    return p.granted ? 'granted' : 'denied';
  },
  servicesEnabled: () => Location.hasServicesEnabledAsync(),
  async lastKnown(maxAgeMs) {
    const p = await Location.getLastKnownPositionAsync({ maxAge: maxAgeMs });
    return p ? raw(p) : null;
  },
  async current(timeoutMs) {
    const p = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return p ? raw(p) : null;
  },
};
