import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { duplicateScore, findDuplicateSuggestions } from '../src/dedup.ts';
import { haversineM } from '../src/geo.ts';
import { isLocalPlaceId, newLocalPlaceId, parseOsmPlaceId, placeIdFromOsm, randomId } from '../src/ids.ts';
import { ftsMatchQuery, nameSimilarity, normalizeText } from '../src/text.ts';

describe('OSM identity', () => {
  it('builds and parses osm:<type>/<id>', () => {
    expect(placeIdFromOsm('node', 123)).toBe('osm:node/123');
    expect(parseOsmPlaceId('osm:way/42')).toEqual({ osmType: 'way', osmId: 42 });
    expect(parseOsmPlaceId('osm:way/042')).toBeNull();
    expect(parseOsmPlaceId('osm:area/1')).toBeNull();
    expect(parseOsmPlaceId('local:abc')).toBeNull();
    expect(() => placeIdFromOsm('node', 0)).toThrow();
    expect(() => placeIdFromOsm('node', 1.5)).toThrow();
  });

  it('round-trips any valid identity', () => {
    fc.assert(
      fc.property(fc.constantFrom('node', 'way', 'relation' as const), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (t, id) => {
        expect(parseOsmPlaceId(placeIdFromOsm(t, id))).toEqual({ osmType: t, osmId: id });
      }),
    );
  });

  it('local ids are random and well-formed', () => {
    const a = newLocalPlaceId();
    expect(isLocalPlaceId(a)).toBe(true);
    expect(randomId()).toMatch(/^[0-9a-z]{26}$/);
    expect(new Set(Array.from({ length: 1000 }, randomId)).size).toBe(1000);
  });
});

describe('text', () => {
  it('normalizes accents, ligatures, punctuation', () => {
    expect(normalizeText('Café d’Orsay — L’Œuvre!')).toBe('cafe d orsay l oeuvre');
    expect(normalizeText('  Straße  ')).toBe('strasse');
  });
  it('builds a safe FTS prefix query', () => {
    expect(ftsMatchQuery('Piz "napo')).toBe('"piz"* "napo"*');
    expect(ftsMatchQuery(' -*" ')).toBeNull();
  });
  it('name similarity', () => {
    expect(nameSimilarity('Chez Paul', 'chez paul')).toBe(1);
    expect(nameSimilarity('Boulangerie Paul', 'Paul')).toBe(1); // whole-word containment
    expect(nameSimilarity('Bar des Amis', 'Bar')).toBeLessThan(1); // too short for containment
    expect(nameSimilarity('Le Comptoir du Relais', 'Comptoir du Relais')).toBe(1);
    expect(nameSimilarity('Café de Flore', 'Cafe Flore')).toBe(1);
    expect(nameSimilarity('Pizzeria Napoli', 'Pizzeria Napoly')).toBeGreaterThan(0.8);
    expect(nameSimilarity('Musée Rodin', 'Pizzeria Napoli')).toBeLessThan(0.3);
    expect(nameSimilarity('', 'x')).toBe(0);
  });
  it('name similarity is symmetric and in [0, 1]', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const s = nameSimilarity(a, b);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(nameSimilarity(b, a)).toBeCloseTo(s, 12);
      }),
    );
  });
});

describe('duplicate suggestions (~30 m, similar name)', () => {
  const base = { id: 'local:aaaaaaaa', name: 'Chez Paul', lat: 48.85, lon: 2.35 };
  const metersNorth = (m: number) => m / 111_195;

  it('suggests a nearby similar point, not a far or different one', () => {
    const near = { id: 'local:bbbbbbbb', name: 'Chez Paul bistrot', lat: 48.85 + metersNorth(20), lon: 2.35 };
    const far = { id: 'local:cccccccc', name: 'Chez Paul', lat: 48.85 + metersNorth(45), lon: 2.35 };
    const other = { id: 'local:dddddddd', name: 'Pharmacie', lat: 48.85, lon: 2.35 };
    const osm = { id: 'osm:node/5', name: 'Chez Paul', lat: 48.85 + metersNorth(5), lon: 2.35 };
    const out = findDuplicateSuggestions(base, [near, far, other, osm, base]);
    expect(out.map((s) => s.id)).toEqual(['osm:node/5', 'local:bbbbbbbb']);
    expect(out[0]!.distanceM).toBeCloseTo(5, 0);
  });

  it('never pairs two OSM objects', () => {
    const a = { id: 'osm:node/1', name: 'Chez Paul', lat: 48.85, lon: 2.35 };
    const b = { id: 'osm:node/2', name: 'Chez Paul', lat: 48.85, lon: 2.35 };
    expect(duplicateScore(a, b)).toBeNull();
  });

  const point = fc.record({
    name: fc.constantFrom('Chez Paul', 'Chez Paul bistrot', 'Le Baron Rouge', 'Baron rouge', 'Pharmacie', 'Café', 'Cafe'),
    lat: fc.double({ min: 48.849, max: 48.851, noNaN: true }),
    lon: fc.double({ min: 2.349, max: 2.351, noNaN: true }),
  });

  it('properties: symmetric, only within the distance, only with similar names', () => {
    fc.assert(
      fc.property(point, point, fc.boolean(), (p, q, qIsOsm) => {
        const a = { id: 'local:aaaaaaaa', ...p };
        const b = { id: qIsOsm ? 'osm:node/9' : 'local:bbbbbbbb', ...q };
        const ab = duplicateScore(a, b);
        const ba = duplicateScore(b, a);
        expect(ab === null).toBe(ba === null);
        const d = haversineM(a, b);
        if (d > 30) expect(ab).toBeNull();
        if (nameSimilarity(a.name, b.name) < 0.6) expect(ab).toBeNull();
        if (d <= 30 && nameSimilarity(a.name, b.name) >= 0.6) expect(ab).not.toBeNull();
      }),
    );
  });
});
