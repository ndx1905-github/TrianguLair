import { assertValidGeometry, pointInArea, type AreaGeometry } from '@triangulair/data';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { describe, expect, it } from 'vitest';

import type { LatLon } from '../components/map/types';
import { EMPTY_POINTS, pointsProblem, pointsToPolygon, tapPoints, undoPoint, type PointsDraft } from './drawing';
import { latLonToScreen, localFrame, metresPerPixel, ringSelfIntersects, screenToLatLon, signedArea, type XY } from './geo';
import {
  assembleRings,
  lightenArea,
  neighbourhoodQuery,
  parseNeighbourhoods,
  parseNominatimAreas,
  parseStreets,
  streetsQuery,
  type OverpassGeomElement,
} from './osmZones';
import { bufferLines, rasterize, strokesToArea, traceRings } from './raster';
import { chaikinRing, countPositions, simplifyLine, simplifyRing } from './simplify';
import { linesLengthM, segmentsToGeometry, StreetNetwork } from './streets';
import { loadZoneFixtures } from '../osm/zoneFixtures';

const O: LatLon = { lat: 48.86, lon: 2.36 };
const f = localFrame(O);
/** A point `x` m east and `y` m north of O. */
const at = (x: number, y: number): LatLon => f.toLatLon([x, y]);

function rings(g: Polygon | MultiPolygon): Position[][][] {
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

function ringArea(r: Position[]): number {
  return signedArea(r.slice(0, -1).map(([lon, lat]) => f.toXY({ lat: lat!, lon: lon! })));
}

/** RFC 7946: closed rings of 4+ positions, exterior CCW, holes CW. */
function expectValidArea(g: Polygon | MultiPolygon | null): asserts g is Polygon | MultiPolygon {
  expect(g).not.toBeNull();
  assertValidGeometry(g!);
  for (const poly of rings(g!)) {
    poly.forEach((r, i) => {
      expect(r.length).toBeGreaterThanOrEqual(4);
      expect(r[0]).toEqual(r[r.length - 1]);
      if (i === 0) expect(ringArea(r)).toBeGreaterThan(0);
      else expect(ringArea(r)).toBeLessThan(0);
    });
  }
}

describe('screen <-> map (Web Mercator, north-up)', () => {
  const v = { bbox: [2.34, 48.85, 2.38, 48.87] as const, width: 400, height: 500 };
  it('round-trips and maps corners', () => {
    const tl = screenToLatLon(v, 0, 0);
    expect(tl.lon).toBeCloseTo(2.34, 9);
    expect(tl.lat).toBeCloseTo(48.87, 9);
    const br = screenToLatLon(v, 400, 500);
    expect(br.lat).toBeCloseTo(48.85, 9);
    const p = screenToLatLon(v, 123, 321);
    const s = latLonToScreen(v, p);
    expect(s.x).toBeCloseTo(123, 6);
    expect(s.y).toBeCloseTo(321, 6);
  });
  it('gives metres per pixel', () => {
    // 0.04° of longitude at 48.86° ≈ 2 927 m over 400 px.
    expect(metresPerPixel(v)).toBeCloseTo(7.32, 1);
  });
  it('handles a bbox across the antimeridian', () => {
    const w = { bbox: [179, -1, -179, 1] as const, width: 200, height: 200 };
    expect(screenToLatLon(w, 100, 100).lon).toBeCloseTo(180, 6);
    expect(screenToLatLon(w, 150, 100).lon).toBeCloseTo(-179.5, 6);
  });
});

describe('simplification', () => {
  it('Douglas–Peucker drops points within the tolerance and keeps the ends', () => {
    const line: XY[] = [
      [0, 0],
      [1, 0.1],
      [2, -0.1],
      [3, 5],
      [4, 0],
    ];
    expect(simplifyLine(line, 0.5)).toEqual([
      [0, 0],
      [2, -0.1],
      [3, 5],
      [4, 0],
    ]);
    expect(simplifyLine(line, 10)).toEqual([
      [0, 0],
      [4, 0],
    ]);
  });
  it('simplifies a ring regardless of its starting point and keeps a triangle', () => {
    const square: XY[] = [];
    for (let i = 0; i < 10; i++) square.push([i, 0]);
    for (let i = 0; i < 10; i++) square.push([10, i]);
    for (let i = 10; i > 0; i--) square.push([i, 10]);
    for (let i = 10; i > 0; i--) square.push([0, i]);
    const s = simplifyRing(square, 0.1);
    expect(s).toHaveLength(4);
    const rotated = [...square.slice(13), ...square.slice(0, 13)];
    expect(simplifyRing(rotated, 0.1)).toHaveLength(4);
    expect(simplifyRing([[0, 0], [1, 0], [0, 0]], 0.1)).toEqual([]);
  });
  it('Chaikin keeps the orientation and stays inside the original hull', () => {
    const tri: XY[] = [
      [0, 0],
      [10, 0],
      [0, 10],
    ];
    const r = chaikinRing(tri, 2);
    expect(r).toHaveLength(12);
    expect(signedArea(r)).toBeGreaterThan(0);
    expect(signedArea(r)).toBeLessThan(signedArea(tri));
  });
});

describe('painting: strokes to a smoothed, simplified area', () => {
  it('one stroke gives one valid polygon covering the stroke', () => {
    const stroke = { points: [at(0, 0), at(100, 0), at(100, 80)], radiusM: 15 };
    const g = strokesToArea([stroke]);
    expectValidArea(g);
    expect(g.type).toBe('Polygon');
    for (const p of [at(0, 0), at(50, 0), at(100, 40), at(100, 80), at(50, 10)]) expect(pointInArea(p, g as AreaGeometry)).toBe(true);
    for (const p of [at(50, 40), at(-30, 0), at(130, 40)]) expect(pointInArea(p, g as AreaGeometry)).toBe(false);
    // Simplified: a few dozen positions, not thousands of grid corners.
    expect(countPositions(g)).toBeLessThan(80);
  });
  it('overlapping strokes merge; separate strokes give a MultiPolygon', () => {
    const a = { points: [at(0, 0), at(60, 0)], radiusM: 10 };
    const b = { points: [at(50, 0), at(50, 60)], radiusM: 10 };
    const c = { points: [at(300, 300), at(320, 300)], radiusM: 10 };
    expect(strokesToArea([a, b])!.type).toBe('Polygon');
    const g = strokesToArea([a, b, c]);
    expectValidArea(g);
    expect(g.type).toBe('MultiPolygon');
    expect((g as MultiPolygon).coordinates).toHaveLength(2);
  });
  it('a painted ring keeps its hole, and the eraser cuts', () => {
    const loop: LatLon[] = [];
    for (let i = 0; i <= 32; i++) loop.push(at(Math.cos((i / 32) * 2 * Math.PI) * 100, Math.sin((i / 32) * 2 * Math.PI) * 100));
    const g = strokesToArea([{ points: loop, radiusM: 15 }]);
    expectValidArea(g);
    expect((g as Polygon).coordinates).toHaveLength(2);
    expect(pointInArea(at(0, 0), g as AreaGeometry)).toBe(false);
    expect(pointInArea(at(100, 0), g as AreaGeometry)).toBe(true);
    const cut = strokesToArea([
      { points: [at(0, 0), at(200, 0)], radiusM: 15 },
      { points: [at(100, -40), at(100, 40)], radiusM: 10, erase: true },
    ]);
    expectValidArea(cut);
    expect(cut.type).toBe('MultiPolygon');
  });
  it('erasing everything leaves nothing; no strokes give null', () => {
    expect(strokesToArea([])).toBeNull();
    expect(
      strokesToArea([
        { points: [at(0, 0), at(10, 0)], radiusM: 5 },
        { points: [at(0, 0), at(10, 0)], radiusM: 30, erase: true },
      ]),
    ).toBeNull();
  });
  it('cells touching only by a corner are traced as separate rings', () => {
    const grid = { cols: 2, rows: 2, cell: 1, x0: 0, y0: 0, data: Uint8Array.from([1, 0, 0, 1]) };
    const r = traceRings(grid);
    expect(r).toHaveLength(2);
    for (const ring of r) expect(signedArea(ring)).toBe(1);
  });
  it('bounds the grid size for large areas', () => {
    const g = rasterize([{ points: [[0, 0], [20_000, 20_000]], radius: 5 }], 50_000)!;
    expect(g.cols * g.rows).toBeLessThan(60_000);
  });
});

describe('street segments', () => {
  const fx = loadZoneFixtures();
  const net = new StreetNetwork(parseStreets(fx.streets.elements));

  it('parses named ways with their nodes', () => {
    expect([...net.ways.values()].map((w) => w.name).sort()).toContain('Rue de Bretagne');
  });
  it('a path follows the streets through intersections', () => {
    // From Rue des Archives (south part) to Rue de Turenne (north part).
    const from = net.snap({ lat: 48.8585, lon: 2.3561 }, 50)!;
    const to = net.snap({ lat: 48.864, lon: 2.3662 }, 50)!;
    expect(net.ways.get(from.wayId)!.name).toBe('Rue des Archives');
    expect(net.ways.get(to.wayId)!.name).toBe('Rue de Turenne');
    const path = net.path(from, to);
    expect(path.length).toBeGreaterThan(3);
    // Every intermediate point is a street node; the path is not much longer than the straight line.
    const direct = linesLengthM([[from.point, to.point]]);
    expect(linesLengthM([path])).toBeLessThan(direct * 1.6);
    expect(linesLengthM([path])).toBeGreaterThanOrEqual(direct);
  });
  it('cuts a single street between two points on the same segment', () => {
    const a = net.snap({ lat: 48.8631, lon: 2.3610 }, 30)!;
    const b = net.snap({ lat: 48.8630, lon: 2.3625 }, 30)!;
    expect(net.path(a, b)).toEqual([a.point, b.point]);
  });
  it('builds LineString / MultiLineString, chaining contiguous segments', () => {
    const s1 = [at(0, 0), at(50, 0)];
    const s2 = [at(50, 0), at(50, 50)];
    const s3 = [at(200, 0), at(250, 0)];
    const one = segmentsToGeometry([s1, s2])!;
    expect(one.type).toBe('LineString');
    expect(one.coordinates).toHaveLength(3);
    const many = segmentsToGeometry([s1, s3])!;
    expect(many.type).toBe('MultiLineString');
    assertValidGeometry(many);
    expect(segmentsToGeometry([[at(0, 0)]])).toBeNull();
  });
  it('buffers street lines into a polygon for list zones', () => {
    const g = bufferLines([[at(0, 0), at(200, 0)]], 25);
    expectValidArea(g);
    expect(pointInArea(at(100, 20), g as AreaGeometry)).toBe(true);
    expect(pointInArea(at(100, 35), g as AreaGeometry)).toBe(false);
    expect(pointInArea(at(-20, 0), g as AreaGeometry)).toBe(true); // round cap
  });
  it('queries carry a marker and a bbox in Overpass order', () => {
    expect(streetsQuery([2.35, 48.85, 2.37, 48.87])).toContain('/* tl:streets */');
    expect(neighbourhoodQuery([2.35, 48.85, 2.37, 48.87])).toContain('(48.850000,2.350000,48.870000,2.370000)');
  });
});

describe('freehand by points', () => {
  const hit = 5;
  const tapAll = (pts: LatLon[], d: PointsDraft = EMPTY_POINTS) => pts.reduce((s, p) => tapPoints(s, p, hit), d);

  it('adds vertices, closes on the first point, saves a valid CCW polygon', () => {
    // Drawn clockwise on purpose.
    let d = tapAll([at(0, 0), at(0, 100), at(100, 100), at(100, 0)]);
    expect(d.closed).toBe(false);
    expect(pointsProblem(d)).toBe('notClosed');
    d = tapPoints(d, at(1, 1), hit);
    expect(d.closed).toBe(true);
    const g = pointsToPolygon(d);
    expectValidArea(g);
    expect(g.coordinates[0]).toHaveLength(5);
  });
  it('moves a vertex (select then tap) and inserts a vertex on an edge', () => {
    let d = tapAll([at(0, 0), at(100, 0), at(100, 100), at(0, 100), at(0, 0)]);
    d = tapPoints(d, at(100, 100), hit);
    expect(d.selected).toBe(2);
    d = tapPoints(d, at(150, 150), hit);
    expect(d.selected).toBeNull();
    expect(f.toXY(d.points[2]!)[0]).toBeCloseTo(150, 3);
    d = tapPoints(d, at(50, 0), hit);
    expect(d.points).toHaveLength(5);
    d = undoPoint(tapPoints(d, at(50, 0), hit));
    expect(d.points).toHaveLength(4);
  });
  it('refuses a self-intersecting (bow-tie) shape', () => {
    const d = tapAll([at(0, 0), at(100, 100), at(100, 0), at(0, 100), at(0, 0)]);
    expect(d.closed).toBe(true);
    expect(pointsProblem(d)).toBe('selfIntersecting');
    expect(pointsToPolygon(d)).toBeNull();
    expect(ringSelfIntersects(d.points.map(f.toXY))).toBe(true);
  });
  it('drops collinear points before saving', () => {
    const d = tapAll([at(0, 0), at(50, 0.1), at(100, 0), at(100, 100), at(0, 100), at(0, 0)]);
    expect(pointsToPolygon(d)!.coordinates[0]).toHaveLength(5);
  });
});

describe('OSM neighbourhoods', () => {
  it('assembles rings from ways in any direction', () => {
    const a = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
    ];
    const b = [
      { lat: 1, lon: 1 },
      { lat: 0, lon: 1 },
    ]; // reversed
    const c = [
      { lat: 1, lon: 1 },
      { lat: 1, lon: 0 },
      { lat: 0, lon: 0 },
    ];
    const r = assembleRings([a, b, c]);
    expect(r).toHaveLength(1);
    expect(r[0]).toHaveLength(5);
    expect(assembleRings([a])).toEqual([]);
  });
  it('parses the fixture neighbourhoods (ways and a multipolygon relation) as valid areas', () => {
    const areas = parseNeighbourhoods(loadZoneFixtures().neighbourhoods.elements);
    expect(areas.map((a) => a.name)).toEqual(['Archives', 'Arts-et-Métiers', 'Enfants-Rouges', 'Sainte-Avoie']);
    for (const a of areas) expectValidArea(a.geometry);
    const archives = areas.find((a) => a.name === 'Archives')!;
    expect(archives).toMatchObject({ osmType: 'relation', category: 'place=quarter' });
    // The Trattoria (fixture place) is in the Archives quarter.
    expect(pointInArea({ lat: 48.8591, lon: 2.36215 }, archives.geometry)).toBe(true);
  });
  it('skips unnamed or unclosed elements', () => {
    const els: OverpassGeomElement[] = [
      { type: 'way', id: 1, tags: { place: 'quarter' }, geometry: [{ lat: 0, lon: 0 }] },
      { type: 'way', id: 2, tags: { name: 'X' }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }] },
    ];
    expect(parseNeighbourhoods(els)).toEqual([]);
  });
  it('lightens a large Nominatim area under the point budget', () => {
    const ring: Position[] = [];
    for (let i = 0; i < 20_000; i++) {
      const a = (i / 20_000) * 2 * Math.PI;
      const r = 4 + 0.02 * Math.sin(a * 400);
      ring.push([2 + r * Math.cos(a), 46 + r * 0.7 * Math.sin(a)]);
    }
    ring.push(ring[0]!);
    const g = lightenArea({ type: 'Polygon', coordinates: [ring] }, 1500)!;
    expectValidArea(g);
    expect(countPositions(g)).toBeLessThanOrEqual(1500);
    expect(pointInArea({ lat: 46, lon: 2 }, g as AreaGeometry)).toBe(true);
    const parsed = parseNominatimAreas([
      { osm_type: 'relation', osm_id: 7, name: 'Big', class: 'boundary', type: 'administrative', geojson: { type: 'Polygon', coordinates: [ring] } },
      { osm_type: 'node', osm_id: 8, name: 'Point', geojson: { type: 'Point', coordinates: [2, 46] } },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ osmType: 'relation', osmId: 7, category: 'boundary=administrative' });
  });
});
