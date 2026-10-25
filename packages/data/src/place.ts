// SPDX-License-Identifier: MPL-2.0
import { assertValidGeometry } from './geo.ts';
import { isLocalPlaceId, isOsmType, parseOsmPlaceId, placeIdFromOsm } from './ids.ts';
import type { OsmType, PlaceGeometry, PlaceKind, PlaceSnapshot, ZoneEdge } from './types.ts';

export interface PlaceSnapshotInput {
  /** Required for a local place; derived from `osm` otherwise. */
  id?: string;
  osm?: { type: OsmType; id: number } | null;
  name: string;
  category?: string | null;
  kind?: PlaceKind;
  edge?: ZoneEdge;
  geometry: PlaceGeometry;
}

/**
 * Validates a snapshot and makes its identity consistent: an OSM place's id is
 * always `osm:<type>/<id>`, a local place's id is `local:<random>`.
 */
export function normalizeSnapshot(input: PlaceSnapshotInput | PlaceSnapshot): PlaceSnapshot {
  let osmType: OsmType | null = null;
  let osmId: number | null = null;
  if ('osm' in input && input.osm) {
    osmType = input.osm.type;
    osmId = input.osm.id;
  } else if ('osmType' in input && input.osmType != null) {
    osmType = input.osmType;
    osmId = input.osmId;
  } else if (input.id) {
    const parsed = parseOsmPlaceId(input.id);
    if (parsed) ({ osmType, osmId } = parsed);
  }
  let id: string;
  if (osmType !== null) {
    if (!isOsmType(osmType) || osmId === null) throw new TypeError('invalid OSM identity');
    id = placeIdFromOsm(osmType, osmId);
    if (input.id && input.id !== id) throw new TypeError(`place id ${input.id} does not match ${id}`);
  } else {
    if (!input.id || !isLocalPlaceId(input.id)) throw new TypeError('a place without OSM identity needs a local: id');
    id = input.id;
  }
  assertValidGeometry(input.geometry);
  const kind: PlaceKind = input.kind ?? (input.geometry.type === 'Point' ? 'place' : 'zone');
  if (kind === 'place' && input.geometry.type !== 'Point' && osmType === null) {
    throw new TypeError('a manual place must be a point');
  }
  return {
    id,
    osmType,
    osmId,
    name: String(input.name ?? '').trim(),
    category: input.category ?? null,
    kind,
    edge: input.edge ?? 'sharp',
    geometry: input.geometry,
  };
}
