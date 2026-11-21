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

function urlList(value: string | undefined): string[] {
  return (value ?? '').split(/[\s,]+/).filter(Boolean);
}

/**
 * Fixture mode: OSM requests are answered with the osm package's test fixtures
 * (synthetic places in the Marais), for offline demos and screenshots.
 */
export const OSM_FIXTURES: boolean = process.env.EXPO_PUBLIC_OSM_FIXTURES === '1';

/**
 * Fallback base map styles (spec "Error cases", map tiles unavailable), tried in order when the
 * style above or its tiles cannot be loaded and the cache has nothing for the area: a mirror or a
 * self-hosted copy in the same OpenMapTiles schema. Comma or space separated. After the last one
 * the map shows a plain background (pins and zones still work) and says the base map is
 * unavailable. Empty by default: OpenFreeMap has a single public host, and the other public
 * services of the spec (OSM vector tiles, Protomaps) need a style of their own or a key. The
 * fixture build (end-to-end tests) uses an address that never resolves, answered by the tests.
 */
export const MAP_STYLE_FALLBACK_URLS: string[] = process.env.EXPO_PUBLIC_MAP_STYLE_FALLBACK_URLS
  ? urlList(process.env.EXPO_PUBLIC_MAP_STYLE_FALLBACK_URLS)
  : OSM_FIXTURES
    ? ['https://tiles.fallback.invalid/styles/positron']
    : [];

/** Fallback styles in dark mode; defaults to the light list when only that one is set. */
export const MAP_STYLE_FALLBACK_URLS_DARK: string[] = process.env.EXPO_PUBLIC_MAP_STYLE_FALLBACK_URLS_DARK
  ? urlList(process.env.EXPO_PUBLIC_MAP_STYLE_FALLBACK_URLS_DARK)
  : process.env.EXPO_PUBLIC_MAP_STYLE_FALLBACK_URLS
    ? MAP_STYLE_FALLBACK_URLS
    : OSM_FIXTURES
      ? ['https://tiles.fallback.invalid/styles/dark']
      : [];

/** Attribution that must stay visible on the map (spec "Base map"; the words are `map.attribution`). */
export const MAP_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
/** "Report an error": OpenStreetMap's own page for reporting a mistake on the map. */
export const MAP_REPORT_URL = 'https://www.openstreetmap.org/fixthemap';

/** Fallback camera (Paris), used when there is no place to fit. */
export const INITIAL_CENTER = { lat: 48.8586, lon: 2.3417 };
export const INITIAL_ZOOM = 12.3;

/** Max number of color bands drawn on a multi-tag pin. */
export const MAX_PIN_BANDS = 3;

/** Sent in the OSM services' User-Agent (their usage policies require a contact). */
export const APP_VERSION = '0.0.1';
export const APP_CONTACT_URL = 'https://github.com/triangulair/triangulair';

/** Force the UI language ("en" or "fr"); default: the device language. */
export const FORCED_LOCALE: string | undefined = process.env.EXPO_PUBLIC_LOCALE || undefined;
