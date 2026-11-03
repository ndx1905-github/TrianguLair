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

/** Sent in the OSM services' User-Agent (their usage policies require a contact). */
export const APP_VERSION = '0.0.1';
export const APP_CONTACT_URL = 'https://github.com/triangulair/triangulair';

/**
 * Fixture mode: OSM requests are answered with the osm package's test fixtures
 * (synthetic places in the Marais), for offline demos and screenshots.
 */
export const OSM_FIXTURES: boolean = process.env.EXPO_PUBLIC_OSM_FIXTURES === '1';

/** Force the UI language ("en" or "fr"); default: the device language. */
export const FORCED_LOCALE: string | undefined = process.env.EXPO_PUBLIC_LOCALE || undefined;
