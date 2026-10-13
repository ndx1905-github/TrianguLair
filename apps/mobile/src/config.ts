/**
 * App configuration (single module). Values can be overridden at build time
 * with EXPO_PUBLIC_* environment variables (inlined by Expo's bundler).
 */

/** Base map style (OpenFreeMap Positron). */
export const MAP_STYLE_URL: string =
  process.env.EXPO_PUBLIC_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/positron';

/**
 * Style used in dark mode. Defaults to OpenFreeMap "dark" (a Positron-like dark
 * variant). Set it equal to MAP_STYLE_URL to keep a light map in dark mode.
 */
export const MAP_STYLE_URL_DARK: string =
  process.env.EXPO_PUBLIC_MAP_STYLE_URL_DARK ?? 'https://tiles.openfreemap.org/styles/dark';

/** Attribution that must stay visible on the map. */
export const MAP_ATTRIBUTION = '© OpenStreetMap contributors, OpenFreeMap';
export const MAP_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';

/** Fallback camera (Paris), used when there is no place to fit. */
export const INITIAL_CENTER = { lat: 48.8586, lon: 2.3417 };
export const INITIAL_ZOOM = 12.3;

/** Max number of color bands drawn on a multi-tag pin. */
export const MAX_PIN_BANDS = 3;
