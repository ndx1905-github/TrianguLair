// SPDX-License-Identifier: MPL-2.0
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  cidFromFid,
  guessMapping,
  parseCsv,
  parseCsvRows,
  parseDate,
  parseGoogleMapsUrl,
  parseStatus,
  parseXml,
  readCsvWithMapping,
  readImportFile,
  type ParseResult,
  type ReadOutcome,
} from '../src/index.ts';
import { fixtureBytes, fixtureText } from './helpers.ts';

function parsed(o: ReadOutcome): ParseResult {
  if (o.kind !== 'parsed') throw new Error(`expected a parse result, got ${JSON.stringify(o).slice(0, 300)}`);
  return o.result;
}

const read = (rel: string, name = rel.split('/').pop()!) => readImportFile({ name, bytes: fixtureBytes(rel) });
const byName = (r: ParseResult, name: string) => {
  const p = r.places.find((x) => x.name === name);
  if (!p) throw new Error(`no ${name} in ${r.places.map((x) => x.name).join(', ')}`);
  return p;
};

describe('low-level readers', () => {
  it('CSV: quotes, embedded separators and newlines, CRLF, BOM, blank lines', () => {
    const { rows, delimiter } = parseCsvRows('﻿a,b,c\r\n"x, y","he said ""hi""","multi\nline"\r\n\r\n1,2,3');
    expect(delimiter).toBe(',');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'he said "hi"', 'multi\nline'],
      ['1', '2', '3'],
    ]);
  });

  it('CSV: sniffs ; and tab', () => {
    expect(parseCsv('a;b;c\n1;2;3').delimiter).toBe(';');
    expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t');
    // A comma inside a quoted header does not count.
    expect(parseCsv('"a,b";c;d\n1;2;3').headers).toEqual(['a,b', 'c', 'd']);
  });

  it('XML: namespaces, entities, CDATA, comments, self-closing, unclosed', () => {
    const doc = parseXml('<?xml version="1.0"?><!DOCTYPE x><kml:kml><!-- c --><a x="1 &amp; 2"><b/>t&lt;&#233;<![CDATA[<raw>]]></a><c>');
    const kml = doc.children[0]!;
    expect(kml.name).toBe('kml');
    const a = kml.children[0]!;
    expect(a.attrs.x).toBe('1 & 2');
    expect(a.text).toBe('t<é<raw>');
    expect(a.children[0]!.name).toBe('b');
    expect(kml.children[1]!.name).toBe('c');
  });

  it('Google Maps URLs: coordinates and ids', () => {
    expect(parseGoogleMapsUrl('https://www.google.com/maps/place/X/@48.1,2.1,17z/data=!3m1!4b1!4m6!3m5!1s0x47e66e1f06e2b70f:0x40b82c3688c9460!8m2!3d48.8584!4d2.2945')).toMatchObject({
      lat: 48.8584,
      lon: 2.2945,
      ids: { googleFid: '0x47e66e1f06e2b70f:0x40b82c3688c9460', googleCid: BigInt('0x40b82c3688c9460').toString() },
    });
    expect(parseGoogleMapsUrl('http://maps.google.com/?cid=1234567890123456789')).toEqual({ ids: { googleCid: '1234567890123456789' } });
    expect(parseGoogleMapsUrl('https://www.google.com/maps/search/?api=1&query=48.85%2C2.35&query_place_id=ChIJLU7jZClu5kcR4PcOOO6p3I0')).toMatchObject({
      lat: 48.85,
      lon: 2.35,
      ids: { googlePlaceId: 'ChIJLU7jZClu5kcR4PcOOO6p3I0' },
    });
    expect(parseGoogleMapsUrl('https://www.google.com/maps/search/48.85799,+2.36244')).toMatchObject({ lat: 48.85799, lon: 2.36244 });
    expect(parseGoogleMapsUrl('https://www.google.com/maps/place/Chez+Toto/data=!4m2!3m1!1s0x1:0x2')).toMatchObject({ name: 'Chez Toto', ids: { googleCid: '2' } });
    expect(parseGoogleMapsUrl('https://www.google.com/maps/place/Chez+Toto/data=!4m2').lat).toBeUndefined();
    expect(cidFromFid('0x0:0xffffffffffffffff')).toBe('18446744073709551615');
  });

  it('dates and statuses', () => {
    expect(parseDate('2021-06-12T19:03:11Z')).toBe(Date.UTC(2021, 5, 12, 19, 3, 11));
    expect(parseDate('12/06/2021 19:03')).toBe(Date.UTC(2021, 5, 12, 19, 3));
    expect(parseDate(1_600_000_000)).toBe(1_600_000_000_000);
    expect(parseDate('1600000000000')).toBe(1_600_000_000_000);
    expect(parseDate('soon')).toBeUndefined();
    expect(parseStatus('Want to go')).toBe('to_try');
    expect(parseStatus('à tester')).toBe('to_try');
    expect(parseStatus('testé')).toBe('tried');
    expect(parseStatus('Favourite')).toBe('favorite');
    expect(parseStatus('maybe')).toBeUndefined();
  });
});

describe('Google Takeout', () => {
  it('Saved Places.json, older layout', () => {
    const r = parsed(read('google/Saved Places.json'));
    expect(r.format).toBe('google-saved-geojson');
    expect(r.places).toHaveLength(3);
    const t = byName(r, 'Trattoria Da Lucia');
    expect(t).toMatchObject({
      lat: 48.8591004,
      lon: 2.3621507,
      address: '12 Rue de Bretagne, 75003 Paris, France',
      tags: ['Saved places'],
      ids: { googleCid: '1234567890123456789' },
      createdAt: Date.UTC(2021, 5, 12, 19, 3, 11),
    });
    expect(byName(r, 'Dropped pin')).toMatchObject({ lat: 48.8611, lon: 2.3538 });
  });

  it('Saved Places.json, newer layout; [0, 0] means no coordinates', () => {
    const r = parsed(read('google/saved-places-2024.json'));
    expect(r.format).toBe('google-saved-geojson');
    expect(byName(r, 'Café Pendule')).toMatchObject({ lat: 48.8590377, lon: 2.3619902, ids: { googleFid: '0x47e66e0390a6b3d1:0x5a2c8f0e2d6b7c11' } });
    const f = byName(r, 'Fromagerie Martin');
    expect(f.lat).toBeUndefined();
    expect(f.comment).toBeUndefined(); // Takeout's "No location information…" is not a comment
    expect(r.warnings).toContainEqual({ code: 'no-coordinates', at: f.key });
  });

  it('Labeled places.json', () => {
    const r = parsed(read('google/Labeled places.json'));
    expect(r.format).toBe('google-labeled-geojson');
    expect(r.places.map((p) => [p.name, p.tags[0]])).toEqual([
      ['Home', 'Labeled places'],
      ['Work', 'Labeled places'],
    ]);
  });

  it('Saved list CSV: list name from the file, status from the default list, coordinates from the URL when any', () => {
    const r = parsed(read('google/Want to go.csv'));
    expect(r.format).toBe('google-saved-csv');
    expect(r.places).toHaveLength(3);
    const t = byName(r, 'Trattoria Da Lucia');
    expect(t).toMatchObject({ tags: ['Want to go', 'italian'], status: 'to_try', comment: 'Best carbonara, ask for the terrace' });
    expect(t.lat).toBeUndefined();
    expect(t.ids.googleFid).toBe('0x47e66e1f06e2b70f:0x40b82c3688c9460');
    expect(byName(r, 'Musée des Cartes Anciennes')).toMatchObject({ lat: 48.85799, lon: 2.36244, comment: 'Free on the first Sunday' });
    const fav = parsed(read('google/Favorite places.csv'));
    expect(fav.places[0]).toMatchObject({ name: 'Le Comptoir des Archives', status: 'favorite', lat: 48.8596123, lon: 2.3631872, tags: ['Favorite places'] });
  });
});

describe('KML / KMZ', () => {
  it('My Maps: folders become tags with colors, CDATA description, lines and polygons become zones', () => {
    const r = parsed(read('kml/my-maps.kml'));
    expect(r.format).toBe('kml');
    expect(r.places.map((p) => p.name)).toEqual(['Trattoria Da Lucia', 'Chez Mamie Rose', 'Musée des Cartes', 'Walk along the canal', 'Le Marais']);
    expect(byName(r, 'Trattoria Da Lucia')).toMatchObject({ tags: ['Restaurants'], comment: 'Fresh pasta\nBook on weekends', status: 'tried', lat: 48.8591004 });
    expect(byName(r, 'Chez Mamie Rose').comment).toBe('Tiny family place, cash only & no sign');
    expect(r.tags).toContainEqual({ key: 'Restaurants', name: 'Restaurants', color: '#E65100' });
    expect(r.tags).toContainEqual({ key: 'Culture', name: 'Culture', color: '#0288D1' });
    expect(byName(r, 'Walk along the canal').shape?.geometry.type).toBe('LineString');
    const marais = byName(r, 'Le Marais');
    expect(marais.shape?.geometry.type).toBe('Polygon');
    expect(marais.lat).toBeGreaterThan(48.853);
  });

  it('KMZ (zip with doc.kml, built with fflate) reads like the KML', () => {
    const kmz = zipSync({ 'doc.kml': strToU8(fixtureText('kml/my-maps.kml')), 'images/icon.png': new Uint8Array([1, 2, 3]) });
    const r = parsed(readImportFile({ name: 'Paris weekend.kmz', bytes: kmz }));
    expect(r.format).toBe('kmz');
    expect(r.places).toHaveLength(5);
  });

  it('Organic Maps: named colors, document name as the tag, timestamps', () => {
    const r = parsed(read('kml/organic-maps.kml'));
    expect(r.places.map((p) => p.tags)).toEqual([['Cheese and books'], ['Cheese and books']]);
    expect(byName(r, 'Fromagerie Martin').createdAt).toBe(Date.UTC(2025, 8, 14, 9, 30));
    expect(r.tags[0]!.color).toBe('#3C8C3C');
  });
});

describe('GeoJSON', () => {
  it('uMap: layers become tags with their colors', () => {
    const r = parsed(read('geojson/umap.umap', 'sorties.umap'));
    expect(r.format).toBe('geojson');
    expect(byName(r, 'Le Comptoir des Archives')).toMatchObject({ tags: ['Bars'], comment: 'Terrace in the courtyard' });
    expect(r.tags.find((t) => t.name === 'Cafés')?.color).toBe('#0D9488');
  });

  it('overpass-turbo: OSM ids are kept, a polygon becomes its representative point plus shape', () => {
    const r = parsed(read('geojson/overpass-turbo.geojson'));
    expect(byName(r, 'Librairie du Haut Marais').ids.osm).toEqual({ type: 'node', id: 9123456704 });
    expect(byName(r, 'Musée des Cartes Anciennes').ids.osm).toEqual({ type: 'way', id: 412345678 });
  });

  it('generic properties: title, notes, category list, status, marker color, lat/lng properties; unsupported geometries reported', () => {
    const r = parsed(read('geojson/simple.geojson'));
    expect(byName(r, 'Fromagerie Martin')).toMatchObject({ tags: ['Cheese', 'Shops'], comment: 'Comté 24 months', status: 'to_try', createdAt: Date.UTC(2025, 1, 14) });
    expect(r.tags.find((t) => t.name === 'Cheese')?.color).toBe('#D97706');
    expect(byName(r, 'Somewhere without geometry')).toMatchObject({ lat: 48.8601, lon: 2.35 });
    expect(r.warnings.some((w) => w.code === 'unsupported-geometry')).toBe(true);
  });
});

describe('generic CSV with column mapping', () => {
  it('French spreadsheet: ; separator, decimal comma, French headers, day-first date', () => {
    const o = read('csv/spreadsheet-fr.csv');
    expect(o.kind).toBe('needsMapping');
    if (o.kind !== 'needsMapping') return;
    const h = o.table.headers;
    expect(o.mapping).toMatchObject({
      name: h.indexOf('Nom'),
      address: h.indexOf('Adresse'),
      lat: h.indexOf('Latitude'),
      lon: h.indexOf('Longitude'),
      tags: [h.indexOf('Catégorie')],
      comment: [h.indexOf('Commentaire')],
      status: h.indexOf('Statut'),
      created: h.indexOf('Ajouté le'),
    });
    const r = readCsvWithMapping(o.table, o.mapping, o.fileName);
    expect(byName(r, 'Trattoria Da Lucia')).toMatchObject({
      lat: 48.8591004,
      lon: 2.3621507,
      tags: ['spreadsheet-fr', 'Restaurant', 'Italien'],
      status: 'tried',
      createdAt: Date.UTC(2021, 5, 12, 19, 3),
    });
    expect(byName(r, 'Le Comptoir des Archives')).toMatchObject({ comment: 'Terrasse ; happy hour', status: 'to_try' });
    const b = byName(r, 'Boulangerie inconnue');
    expect(b.lat).toBeUndefined();
  });

  it('a combined "lat, lon" column and a pipe-separated tag column', () => {
    const o = read('csv/combined-coords.csv');
    if (o.kind !== 'needsMapping') throw new Error(o.kind);
    expect(o.mapping.coords).toBe(1);
    expect(o.mapping.name).toBe(0);
    // "why" is not a known header: the user maps it on the mapping screen.
    expect(o.unmapped).toContain(2);
    const r = readCsvWithMapping(o.table, { ...o.mapping, comment: [2] });
    expect(byName(r, 'Café Pendule')).toMatchObject({ lat: 48.85904, lon: 2.36199, tags: ['coffee', 'work'], comment: 'Good flat white' });
  });

  it('headers that say nothing: coordinates and name guessed from the values (TSV)', () => {
    const o = read('csv/unnamed-columns.tsv');
    if (o.kind !== 'needsMapping') throw new Error(o.kind);
    expect(o.mapping).toMatchObject({ name: 0, lat: 1, lon: 2 });
    const r = readCsvWithMapping(o.table, o.mapping);
    expect(r.places).toHaveLength(2);
  });

  it('guessMapping does not take x/y headers when the values are not coordinates', () => {
    const t = parseCsv('name,x,y\nA,foo,bar\n');
    expect(guessMapping(t).mapping.lat).toBeUndefined();
  });
});

describe('HYPOTHETICAL app exports (unverified layouts, T-009)', () => {
  it('Mapstr CSV: tags with colors, user and public comments; flagged unverified', () => {
    const r = parsed(read('hypothetical/mapstr-export.csv'));
    expect(r.format).toBe('mapstr');
    expect(r.warnings[0]).toEqual({ code: 'unverified-format', detail: 'mapstr' });
    expect(byName(r, 'Trattoria Da Lucia')).toMatchObject({
      tags: ['Restaurant', 'Italian'],
      mainTag: 'Restaurant',
      comment: 'Order the carbonara\n\nFamily-run trattoria',
      createdAt: Date.UTC(2020, 8, 1, 12),
      ids: { sourceId: 'mp_001' },
    });
    expect(r.tags.find((t) => t.name === 'Italian')?.color).toBe('#43A047');
    expect(r.tags.find((t) => t.name === 'Bar')?.color).toBe('#3949AB');
  });

  it('Mapstr GeoJSON: tags as objects with colors, userComment', () => {
    const r = parsed(read('hypothetical/mapstr-export.geojson'));
    expect(r.format).toBe('mapstr');
    expect(r.places[0]).toMatchObject({ name: 'Café Pendule', tags: ['Coffee', 'Work spot'], comment: 'Quiet before 10' });
    expect(r.tags.find((t) => t.name === 'Coffee')?.color).toBe('#6D4C41');
  });

  it('Pin Drop CSV: group as a tag, visited as status; flagged unverified', () => {
    const r = parsed(read('hypothetical/pindrop-export.csv'));
    expect(r.format).toBe('pindrop');
    expect(r.warnings[0]?.code).toBe('unverified-format');
    expect(byName(r, 'Fromagerie Martin')).toMatchObject({ tags: ['Food shops', 'cheese'], status: 'tried', comment: 'Comté', address: 'Rue de Bretagne, Paris' });
    expect(byName(r, 'Librairie du Haut Marais').status).toBeUndefined();
  });

  it('Pin Drop KML: read by the KML reader, flagged unverified', () => {
    const r = parsed(read('hypothetical/pindrop-export.kml'));
    expect(r.format).toBe('pindrop');
    expect(r.places[0]).toMatchObject({ name: 'Le Comptoir des Archives', tags: ['Paris bars'], comment: 'Great terrace' });
  });

  it('an unknown Mapstr-like CSV variant still goes through the generic path', () => {
    const r = parsed(readImportFile({ name: 'mapstr.csv', text: 'Lieu;Lat;Lng;Notes\nCafé Pendule;48,8590377;2,3619902;Calme\n' }));
    expect(r.places[0]).toMatchObject({ name: 'Café Pendule', lat: 48.8590377, comment: 'Calme' });
  });
});

describe('errors', () => {
  it('empty, unreadable and unknown files', () => {
    expect(readImportFile({ name: 'x.csv', text: '  ' })).toEqual({ kind: 'error', code: 'empty' });
    expect(readImportFile({ name: 'x.json', text: '{oops' })).toMatchObject({ kind: 'error', code: 'unreadable' });
    expect(readImportFile({ name: 'x.xml', text: '<svg></svg>' })).toMatchObject({ kind: 'error', code: 'unknown-format' });
    expect(readImportFile({ name: 'x.kmz', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]) })).toMatchObject({ kind: 'error', code: 'unreadable' });
    expect(readImportFile({ name: 'x.json', text: '{"triangulair":{"format":"triangulair-export","version":99},"type":"FeatureCollection","features":[]}' })).toMatchObject({
      kind: 'error',
      code: 'too-new',
    });
  });
});
