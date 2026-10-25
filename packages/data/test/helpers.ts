// SPDX-License-Identifier: MPL-2.0
import type { PlaceSnapshotInput } from '../src/place.ts';
import type { Polygon } from 'geojson';

export const ME = 'ed25519:me';
export const FRIEND = 'ed25519:friend';

/** Deterministic clock: each call advances by 1 s from `start`. */
export function fakeClock(start = 1_760_000_000_000): { now: () => number; set: (t: number) => void } {
  let t = start;
  return {
    now: () => (t += 1000),
    set: (v: number) => {
      t = v;
    },
  };
}

/** Deterministic id generator. */
export function seqIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(n++).toString(36).padStart(6, '0')}`;
}

export function osmPoint(id: number, name: string, lat: number, lon: number, category: string | null = 'amenity=restaurant'): PlaceSnapshotInput {
  return { osm: { type: 'node', id }, name, category, geometry: { type: 'Point', coordinates: [lon, lat] } };
}

export function localPoint(id: string, name: string, lat: number, lon: number): PlaceSnapshotInput {
  return { id: `local:${id}`, name, geometry: { type: 'Point', coordinates: [lon, lat] } };
}

/** Axis-aligned rectangle polygon. */
export function rect(w: number, s: number, e: number, n: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

export function hexActor(n: number): string {
  return n.toString(16).padStart(32, '0').replace(/^0/, 'a');
}
