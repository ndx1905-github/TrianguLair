/**
 * Location on Android: the local module `modules/tl-location` (Android's own LocationManager:
 * GPS, network, passive and the platform's fused provider), so that it works on phones without
 * Google Play services (F-Droid). expo-location is not linked on Android (package.json
 * `expo.autolinking.android.exclude`): it would pull in play-services-location. See `locate.ts`.
 */
import { PermissionsAndroid } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

import type { LocationBackend, RawFix } from './locate';

interface TlLocationNative {
  hasPermission(): boolean;
  isEnabled(): boolean;
  providers(): string[];
  lastKnown(maxAgeMs: number): RawFix | null;
  current(timeoutMs: number): Promise<RawFix | null>;
}

let native: TlLocationNative | null | undefined;

function location(): TlLocationNative {
  if (native === undefined) {
    try {
      native = requireOptionalNativeModule<TlLocationNative>('TlLocation');
    } catch {
      native = null;
    }
  }
  if (!native) throw new Error('The TlLocation native module is not in this build');
  return native;
}

const { ACCESS_FINE_LOCATION: FINE, ACCESS_COARSE_LOCATION: COARSE } = PermissionsAndroid.PERMISSIONS;

export const backend: LocationBackend = {
  async requestPermission() {
    const m = location();
    if (m.hasPermission()) return 'granted';
    // Both at once: from Android 12 the user may choose "approximate" (coarse only), which is enough.
    const r = await PermissionsAndroid.requestMultiple([FINE, COARSE]);
    const granted = r[FINE] === PermissionsAndroid.RESULTS.GRANTED || r[COARSE] === PermissionsAndroid.RESULTS.GRANTED;
    return granted ? 'granted' : 'denied';
  },
  servicesEnabled: async () => location().isEnabled(),
  lastKnown: async (maxAgeMs) => location().lastKnown(maxAgeMs),
  current: (timeoutMs) => location().current(timeoutMs),
};
