// SPDX-License-Identifier: MPL-2.0
/**
 * Duplicate suggestions for manually placed points (spec "No duplicates"):
 * "the app offers to merge when two points are within about thirty meters of
 * each other with a similar name; the user confirms." Pure functions; the
 * repository feeds them with the places found around the point.
 *
 * Two OSM objects are never suggested as duplicates of each other: OSM already
 * says they are different objects. At least one side must be a local point.
 */
import { haversineM } from './geo.ts';
import { isLocalPlaceId } from './ids.ts';
import { nameSimilarity } from './text.ts';

export interface DedupPoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface DedupOptions {
  /** Default 30 m. */
  maxDistanceM?: number;
  /** Default 0.6 (see `nameSimilarity`). */
  minSimilarity?: number;
}

export interface DuplicateSuggestion {
  id: string;
  distanceM: number;
  similarity: number;
}

export const DEDUP_DEFAULTS = { maxDistanceM: 30, minSimilarity: 0.6 } as const;

export function duplicateScore(a: DedupPoint, b: DedupPoint, opts: DedupOptions = {}): DuplicateSuggestion | null {
  const maxD = opts.maxDistanceM ?? DEDUP_DEFAULTS.maxDistanceM;
  const minS = opts.minSimilarity ?? DEDUP_DEFAULTS.minSimilarity;
  if (a.id === b.id) return null;
  if (!isLocalPlaceId(a.id) && !isLocalPlaceId(b.id)) return null;
  const distanceM = haversineM(a, b);
  if (!(distanceM <= maxD)) return null;
  const similarity = nameSimilarity(a.name, b.name);
  if (similarity < minS) return null;
  return { id: b.id, distanceM, similarity };
}

/** Candidates that look like the same place as `point`, best first. */
export function findDuplicateSuggestions(
  point: DedupPoint,
  candidates: Iterable<DedupPoint>,
  opts: DedupOptions = {},
): DuplicateSuggestion[] {
  const out: DuplicateSuggestion[] = [];
  for (const c of candidates) {
    const s = duplicateScore(point, c, opts);
    if (s) out.push(s);
  }
  return out.sort((x, y) => y.similarity - x.similarity || x.distanceM - y.distanceM || (x.id < y.id ? -1 : 1));
}
