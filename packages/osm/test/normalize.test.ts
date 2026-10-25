import { describe, expect, it } from 'vitest';
import {
  formatAddress,
  minCharge,
  normalizeElement,
  normalizeUrl,
  parseCharge,
  parseContact,
  parseCuisine,
  parseFee,
  parsePhones,
} from '../src/normalize.ts';
import type { OsmElement } from '../src/types.ts';
import { fixtureJson } from './support/fake.ts';

const nearby = fixtureJson<{ elements: OsmElement[] }>('overpass/nearby-marais.json').elements;
const byId = (id: number) => nearby.find((e) => e.id === id)!;

describe('normalizeElement on recorded Overpass elements', () => {
  it('restaurant: cuisine, diets, terrace, reservation, contact, address', () => {
    const p = normalizeElement(byId(9123456702))!;
    expect(p).toMatchObject({
      ref: { type: 'node', id: 9123456702 },
      osmUrl: 'https://www.openstreetmap.org/node/9123456702',
      name: 'Trattoria Da Lucia',
      names: { it: 'Trattoria Da Lucia' },
      category: 'restaurant',
      categoryGroup: 'food_drink',
      primaryTag: { key: 'amenity', value: 'restaurant' },
      cuisine: ['italian', 'pizza'],
      diet: { vegetarian: 'yes', vegan: 'limited', gluten_free: 'no' },
      outdoorSeating: 'yes',
      reservation: 'recommended',
      openingHours: 'Tu-Su 12:00-14:30,19:00-22:30; PH off',
      contact: {
        website: 'https://www.trattoria-dalucia.example',
        phones: ['+33 1 42 00 00 01', '+33 6 00 00 00 02'],
      },
      address: { formatted: '12 Rue de Bretagne, 75003 Paris' },
    });
    expect(p.location).toEqual({ lat: 48.8591004, lon: 2.3621507 });
    // Accessibility is not interpreted in v1, but the raw tag is kept.
    expect(p).not.toHaveProperty('wheelchair');
    expect(p.tags.wheelchair).toBe('limited');
  });

  it('bar: happy hours and a terrace given as "sidewalk"', () => {
    const p = normalizeElement(byId(9123456701))!;
    expect(p.category).toBe('bar');
    expect(p.happyHours).toBe('Mo-Sa 17:00-20:00');
    expect(p.outdoorSeating).toBe('yes');
    expect(p.contact.instagram).toBe('https://www.instagram.com/comptoirdesarchives');
  });

  it('museum way: center, fee, charges, sub-type, wikidata', () => {
    const p = normalizeElement(byId(412345678))!;
    expect(p).toMatchObject({
      ref: { type: 'way', id: 412345678 },
      location: { lat: 48.8579912, lon: 2.3624401 },
      category: 'museum',
      categoryGroup: 'culture',
      museum: 'history',
      fee: true,
      wikidata: 'Q99999901',
    });
    expect(p.charge).toEqual([
      { raw: '12 EUR', amount: 12, currency: 'EUR' },
      { raw: '8 EUR reduced', amount: 8, currency: 'EUR', note: 'reduced' },
    ]);
    expect(minCharge(p.charge)?.amount).toBe(8);
  });

  it('café, bookshop, cheese shop: wifi, vegan only, second hand, organic', () => {
    expect(normalizeElement(byId(9123456703))).toMatchObject({ wifi: 'yes', diet: { vegan: 'only' } });
    expect(normalizeElement(byId(9123456704))).toMatchObject({ category: 'bookshop', shop: 'books', secondHand: 'yes' });
    expect(normalizeElement(byId(9123456706))).toMatchObject({ category: 'food_shop', organic: 'only' });
  });

  it('a named parking keeps the name but has no place category', () => {
    expect(normalizeElement(byId(9123456705))?.category).toBe('other');
  });

  it('returns null for an unnamed element without a place category', () => {
    expect(normalizeElement({ type: 'way', id: 1, tags: { building: 'yes' } })).toBeNull();
    expect(normalizeElement({ type: 'node', id: 2 })).toBeNull();
  });

  it('keeps version and timestamp from meta output', () => {
    const p = normalizeElement({ type: 'node', id: 3, lat: 1, lon: 2, version: 7, timestamp: '2026-01-01T00:00:00Z', tags: { amenity: 'cafe' } });
    expect(p).toMatchObject({ version: 7, timestamp: '2026-01-01T00:00:00Z', category: 'cafe' });
  });
});

describe('field parsers', () => {
  it('parseCharge handles symbols, prefixes, decimals and unparseable values', () => {
    expect(parseCharge('€12')).toEqual([{ raw: '€12', amount: 12, currency: 'EUR' }]);
    expect(parseCharge('5,50 €')).toEqual([{ raw: '5,50 €', amount: 5.5, currency: 'EUR' }]);
    expect(parseCharge('EUR 5 (children)')).toEqual([{ raw: 'EUR 5 (children)', amount: 5, currency: 'EUR', note: 'children' }]);
    expect(parseCharge('£7.50')).toEqual([{ raw: '£7.50', amount: 7.5, currency: 'GBP' }]);
    expect(parseCharge('donation')).toEqual([{ raw: 'donation' }]);
    expect(parseCharge(undefined)).toEqual([]);
  });

  it('parseFee: free, paid, unknown', () => {
    expect(parseFee('no', undefined)).toBe(false);
    expect(parseFee('yes', undefined)).toBe(true);
    expect(parseFee(undefined, '10 EUR')).toBe(true);
    expect(parseFee(undefined, undefined)).toBeUndefined();
    expect(parseFee('donation', undefined)).toBe(false);
  });

  it('normalizeUrl adds https and refuses non-web schemes', () => {
    expect(normalizeUrl('example.org/menu')).toBe('https://example.org/menu');
    expect(normalizeUrl('http://example.org')).toBe('http://example.org');
    expect(normalizeUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeUrl('not a url')).toBeUndefined();
    expect(normalizeUrl('https://a.example;https://b.example')).toBe('https://a.example');
  });

  it('parsePhones splits, dedupes and strips junk', () => {
    expect(parsePhones('+33 1 23 45 67 89; +33 1 23 45 67 89', '+33 (0)6 11 22 33 44 ext')).toEqual([
      '+33 1 23 45 67 89',
      '+33 (0)6 11 22 33 44',
    ]);
  });

  it('parseContact reads contact:* and social links', () => {
    expect(
      parseContact({ 'contact:website': 'https://x.example', 'contact:email': 'hi@x.example', 'contact:facebook': 'https://facebook.com/x', 'contact:mastodon': 'https://m.example/@x' }),
    ).toEqual({
      website: 'https://x.example',
      email: 'hi@x.example',
      phones: [],
      facebook: 'https://facebook.com/x',
      social: { mastodon: 'https://m.example/@x' },
    });
  });

  it('parseCuisine lowercases and dedupes', () => {
    expect(parseCuisine('Italian; pizza;italian')).toEqual(['italian', 'pizza']);
  });

  it('formatAddress follows the country convention for the house number', () => {
    expect(formatAddress({ street: 'Hauptstraße', housenumber: '5', postcode: '10115', city: 'Berlin', country: 'DE' })).toBe(
      'Hauptstraße 5, 10115 Berlin',
    );
    expect(formatAddress({ street: 'Rue X', housenumber: '5', country: 'FR' })).toBe('5 Rue X');
    expect(formatAddress({})).toBeUndefined();
  });
});
