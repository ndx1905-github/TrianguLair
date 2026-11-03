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
