import { describe, expect, it } from 'vitest';
import { normalizeElement, openingStatus } from '@triangulair/osm';

import { translate } from '../i18n/core';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import { cardInfo, cuisineLabel, describeOpeningStatus, formatDistance, practicalChips, type Translator } from './card';

const tr = (locale: 'en' | 'fr'): Translator => {
  const dict = locale === 'en' ? en : fr;
  return { locale, t: (k, p) => translate(locale, dict, en, k, p), has: (k) => k in dict || k in en };
};
// Saturday 24 October 2026, 19:30 local time.
const NOW = new Date(2026, 9, 24, 19, 30);
const info = (tags: Record<string, string>) =>
  normalizeElement({ type: 'node', id: 9123456702, lat: 48.859, lon: 2.362, tags: { name: 'Trattoria', amenity: 'restaurant', ...tags } })!;

describe('opening line', () => {
  it('"Open, closes at 10:30 pm" in English, 24 h clock in French', () => {
    const s = openingStatus('Tu-Su 12:00-14:30,19:00-22:30', NOW);
    expect(describeOpeningStatus(s, NOW, tr('en'))).toEqual({ text: 'Open, closes at 10:30 pm', tone: 'open' });
    expect(describeOpeningStatus(s, NOW, tr('fr'))!.text).toBe('Ouvert, ferme à 22:30');
  });

  it('closed: when it opens next (tomorrow, or a weekday)', () => {
    expect(describeOpeningStatus(openingStatus('Mo-Su 08:00-18:00', NOW), NOW, tr('en'))!.text).toBe('Closed, opens tomorrow at 8 am');
    expect(describeOpeningStatus(openingStatus('Mo 09:00-12:00', NOW), NOW, tr('en'))!.text).toBe('Closed, opens Monday at 9 am');
  });

  it('missing hours: no line; unparseable: shown raw', () => {
    expect(describeOpeningStatus(openingStatus(undefined, NOW), NOW, tr('en'))).toBeNull();
    const raw = describeOpeningStatus(openingStatus('ask the owner', NOW), NOW, tr('en'))!;
    expect(raw.tone).toBe('unknown');
    expect(raw.text).toContain('ask the owner');
  });
});

describe('card info', () => {
  it('collects category, address, happy hour and practical chips', () => {
    const i = info({
      cuisine: 'italian;bubble_tea',
      outdoor_seating: 'yes',
      'diet:vegetarian': 'yes',
      'diet:vegan': 'only',
      reservation: 'recommended',
      happy_hours: 'Mo-Sa 17:00-20:00',
      opening_hours: 'Mo-Su 12:00-23:00',
      'addr:housenumber': '12',
      'addr:street': 'Rue de Bretagne',
      'addr:postcode': '75003',
      'addr:city': 'Paris',
    });
    const card = cardInfo({ osmType: 'node', address: null, website: null, phone: null, openingHours: null, status: 'open' }, i, NOW, tr('en'));
    expect(card.category).toBe('Restaurant');
    expect(card.address).toContain('Rue de Bretagne');
    expect(card.opening!.text).toBe('Open, closes at 11 pm');
    expect(card.happyHour).toBe('Happy hour until 8 pm');
    expect(card.chips.map((c) => c.label)).toEqual([
      'Terrace',
      'Vegetarian options',
      'Vegan only',
      'Italian',
      'Bubble tea',
      'Reservation recommended',
    ]);
    expect(card.osmUrl).toBe('https://www.openstreetmap.org/node/9123456702');
    expect(card.maybeClosed).toBe(false);
  });

  it('fee and charge; French labels', () => {
    const chips = practicalChips(info({ tourism: 'museum', fee: 'yes', charge: '16 EUR' }), tr('fr'));
    expect(chips.map((c) => c.label)).toContain('Entrée 16 EUR');
    expect(cuisineLabel('italian', tr('fr'))).toBe('Italien');
    expect(cuisineLabel('new_style', tr('fr'))).toBe('New style');
  });

  it('a manual place without OSM data has no OSM link and no chips', () => {
    const card = cardInfo({ osmType: null, address: '1 rue X', website: null, phone: null, openingHours: null, status: 'maybe_closed' }, null, NOW, tr('en'));
    expect(card.osmUrl).toBeNull();
    expect(card.chips).toEqual([]);
    expect(card.address).toBe('1 rue X');
    expect(card.category).toBe('Place');
    expect(card.maybeClosed).toBe(true);
  });
});

describe('distances', () => {
  it('meters below 1 km, then km with locale decimals', () => {
    expect(formatDistance(123, tr('en'))).toBe('120 m');
    expect(formatDistance(1460, tr('en'))).toBe('1.5 km');
    expect(formatDistance(1460, tr('fr'))).toBe('1,5 km');
    expect(formatDistance(23_400, tr('en'))).toBe('23 km');
    expect(formatDistance(null, tr('en'))).toBeNull();
  });
});
