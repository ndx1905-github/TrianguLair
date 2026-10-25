import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { MultiPolygon, Polygon } from 'geojson';
import {
  assertValidGeometry,
  bboxAround,
  geometryBBox,
  geometryIntersectsArea,
  haversineM,
  pointInArea,
  representativePoint,
  splitBBox,
} from '../src/geo.ts';
import { rect } from './helpers.ts';

describe('geo', () => {
  it('haversine: Paris–Lyon ≈ 392 km, symmetric, zero on self', () => {
    const paris = { lat: 48.8566, lon: 2.3522 };
    const lyon = { lat: 45.764, lon: 4.8357 };
    expect(haversineM(paris, lyon) / 1000).toBeCloseTo(391.5, 0);
    expect(haversineM(paris, lyon)).toBeCloseTo(haversineM(lyon, paris), 6);
    expect(haversineM(paris, paris)).toBe(0);
  });

  it('bboxAround contains every point within the radius', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -80, max: 80, noNaN: true }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: 1, max: 5000, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        (lat, lon, r, angle) => {
          const b = bboxAround({ lat, lon }, r);
          // A point at distance ≤ r in some direction.
          const dLat = ((r * 0.99) / 6_371_008.8) * (180 / Math.PI) * Math.sin(angle);
          const dLon = (((r * 0.99) / 6_371_008.8) * (180 / Math.PI) * Math.cos(angle)) / Math.cos((lat * Math.PI) / 180);
          const p = { lat: lat + dLat, lon: lon + dLon };
          if (p.lon > 180 || p.lon < -180) return true;
          const inside = splitBBox(b).some(([w, s, e, n]) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n);
          expect(inside).toBe(true);
        },
      ),
    );
  });

  it('splits a bbox crossing the antimeridian', () => {
    expect(splitBBox([170, -10, -170, 10])).toEqual([
      [170, -10, 180, 10],
      [-180, -10, -170, 10],
    ]);
    expect(splitBBox([1, 2, 3, 4])).toEqual([[1, 2, 3, 4]]);
  });

  it('point in polygon with a hole, multipolygon', () => {
    const donut: Polygon = { type: 'Polygon', coordinates: [rect(0, 0, 10, 10).coordinates[0]!, rect(4, 4, 6, 6).coordinates[0]!] };
    expect(pointInArea({ lon: 2, lat: 2 }, donut)).toBe(true);
    expect(pointInArea({ lon: 5, lat: 5 }, donut)).toBe(false);
    expect(pointInArea({ lon: 11, lat: 5 }, donut)).toBe(false);
    const multi: MultiPolygon = { type: 'MultiPolygon', coordinates: [rect(0, 0, 1, 1).coordinates, rect(5, 5, 6, 6).coordinates] };
    expect(pointInArea({ lon: 5.5, lat: 5.5 }, multi)).toBe(true);
    expect(pointInArea({ lon: 3, lat: 3 }, multi)).toBe(false);
  });

  it('intersections of lines and polygons with an area', () => {
    const area = rect(0, 0, 10, 10);
    expect(geometryIntersectsArea({ type: 'LineString', coordinates: [[-5, 5], [15, 5]] }, area)).toBe(true); // crosses, no vertex inside
    expect(geometryIntersectsArea({ type: 'LineString', coordinates: [[-5, -5], [-1, 20]] }, area)).toBe(false);
    expect(geometryIntersectsArea(rect(2, 2, 3, 3), area)).toBe(true); // inside
    expect(geometryIntersectsArea(rect(-5, -5, 15, 15), area)).toBe(true); // contains the area
    expect(geometryIntersectsArea(rect(20, 20, 30, 30), area)).toBe(false);
    expect(geometryIntersectsArea({ type: 'Point', coordinates: [5, 5] }, area)).toBe(true);
  });

  it('representative point: inside an L-shape, middle of the longest street segment', () => {
    const L: Polygon = {
      type: 'Polygon',
      coordinates: [[[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10], [0, 0]]],
    };
    const p = representativePoint(L);
    expect(pointInArea(p, L)).toBe(true);
    const street = representativePoint({ type: 'LineString', coordinates: [[0, 0], [0, 0.001], [0, 0.011]] });
    expect(street.lat).toBeCloseTo(0.006, 6);
  });

  it('representative point of any rectangle-union polygon is inside', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 20 })), { minLength: 3, maxLength: 12 }),
        (pts) => {
          // Star-shaped polygon around (10, 10): sort points by angle.
          const ring = pts
            .map(([x, y]) => [x + 0.5, y + 0.25] as [number, number])
            .filter(([x, y]) => x !== 10 || y !== 10)
            .sort((a, b) => Math.atan2(a[1] - 10, a[0] - 10) - Math.atan2(b[1] - 10, b[0] - 10));
          if (ring.length < 3) return true;
          const poly: Polygon = { type: 'Polygon', coordinates: [[...ring, ring[0]!]] };
          const [w, s, e, n] = geometryBBox(poly);
          if (e - w < 1e-9 || n - s < 1e-9) return true;
          const rp = representativePoint(poly);
          // Degenerate (zero-area) rings may have no interior: accept a vertex.
          const isVertex = ring.some(([x, y]) => x === rp.lon && y === rp.lat);
          expect(pointInArea(rp, poly) || isVertex).toBe(true);
        },
      ),
    );
  });

  it('rejects invalid geometries', () => {
    expect(() => assertValidGeometry({ type: 'Point', coordinates: [200, 0] })).toThrow();
    expect(() => assertValidGeometry({ type: 'Point', coordinates: [Number.NaN, 0] })).toThrow();
    expect(() => assertValidGeometry({ type: 'LineString', coordinates: [[0, 0]] })).toThrow();
    expect(() => assertValidGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] })).toThrow();
    expect(() => assertValidGeometry({ type: 'GeometryCollection', geometries: [] } as never)).toThrow();
    expect(() => assertValidGeometry(rect(0, 0, 1, 1))).not.toThrow();
  });
});
