/**
 * What to tell the user when an OSM service call fails. Pure, unit-tested.
 */
import { OsmError } from '@triangulair/osm';

export type OsmFailure = 'aborted' | 'offline' | 'busy' | 'unavailable';

export function classifyOsmError(e: unknown): OsmFailure {
  const code = e instanceof OsmError ? e.code : (e as { code?: string } | null)?.code;
  const name = (e as { name?: string } | null)?.name;
  if (code === 'aborted' || name === 'AbortError') return 'aborted';
  if (code === 'network' || code === 'timeout' || e instanceof TypeError) return 'offline';
  if (code === 'rate_limited') return 'busy';
  return 'unavailable';
}

/**
 * The message for a failure (i18n key). A failed search (Photon, then Nominatim as the fallback)
 * says so and points to the way that needs no service (spec "Error cases": "Search unavailable,
 * place the place on the map"); the nearby list falls back to the places saved on this device.
 */
export function osmFailureKey(f: OsmFailure, during: 'search' | 'nearby'): string {
  if (f === 'busy') return 'osm.busy';
  if (during === 'search') return 'osm.searchUnavailable';
  return f === 'offline' ? 'osm.offline' : 'osm.unavailable';
}
