import { InvalidArgumentError } from './errors.ts';
import type { BBox, LatLon, OsmElement } from './types.ts';

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in meters. */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point of an Overpass/OSM element: its coordinates for a node, its center otherwise. */
export function elementPoint(el: OsmElement): LatLon | null {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

export function assertLatLon(p: LatLon): void {
  if (
    !Number.isFinite(p.lat) ||
    !Number.isFinite(p.lon) ||
    p.lat < -90 ||
    p.lat > 90 ||
    p.lon < -180 ||
    p.lon > 180
  ) {
    throw new InvalidArgumentError(`Invalid coordinates ${p.lat},${p.lon}`);
  }
}

export function assertBBox(b: BBox): void {
  assertLatLon({ lat: b.south, lon: b.west });
  assertLatLon({ lat: b.north, lon: b.east });
  if (b.south > b.north) throw new InvalidArgumentError('bbox south > north');
}

export function bboxCenter(b: BBox): LatLon {
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

/** A square bbox of `radius` meters around a point (for services that take a bbox). */
export function bboxAround(p: LatLon, radiusM: number): BBox {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.max(0.01, Math.cos(rad(p.lat))));
  return {
    south: Math.max(-90, p.lat - dLat),
    north: Math.min(90, p.lat + dLat),
    west: Math.max(-180, p.lon - dLon),
    east: Math.min(180, p.lon + dLon),
  };
}

/** Coordinates rounded for cache keys and queries (7 decimals ≈ 1 cm). */
export function fmtCoord(n: number, decimals = 7): string {
  return Number(n.toFixed(decimals)).toString();
}
