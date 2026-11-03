/**
 * List view query (T-104, basic): text search with a chosen sort. Pure,
 * unit-tested; the repository does the work (FTS5 or its fallback, indexes).
 */
import type { LatLon, PlaceQuery } from '@triangulair/data';

export type ListSort = 'recent' | 'distance' | 'name';

export const LIST_LIMIT = 500;

export function listQuery({ text, sort, from }: { text: string; sort: ListSort; from: LatLon }): PlaceQuery {
  const q = text.trim();
  return {
    ...(q ? { text: q } : {}),
    sort,
    // Always pass the reference point: rows show their distance whatever the sort.
    from,
    limit: LIST_LIMIT,
  };
}
