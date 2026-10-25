import { describe, expect, it } from 'vitest';

import { pickLocale, placeholderMismatches, translate } from './core';
import { en } from './en';
import { fr } from './fr';

describe('i18n core', () => {
  it('picks a supported locale from device tags', () => {
    expect(pickLocale(['fr-CA', 'en-US'])).toBe('fr');
    expect(pickLocale(['de-DE', 'en-GB'])).toBe('en');
    expect(pickLocale([undefined, 'es'])).toBe('en');
    expect(pickLocale(['FR_fr'])).toBe('fr');
  });

  it('interpolates and keeps unknown placeholders visible', () => {
    expect(translate('en', { k: 'Hi {name}, {x}' }, {}, 'k', { name: 'Léa' })).toBe('Hi Léa, {x}');
  });

  it('chooses plural forms with the locale rules', () => {
    const d = { n: { one: '{count} lieu', other: '{count} lieux' } };
    expect(translate('fr', d, {}, 'n', { count: 0 })).toBe('0 lieu'); // French: 0 is singular
    expect(translate('fr', d, {}, 'n', { count: 2 })).toBe('2 lieux');
    expect(translate('en', { n: { one: '{count} place', other: '{count} places' } }, {}, 'n', { count: 0 })).toBe('0 places');
  });

  it('falls back to English, then to the key', () => {
    expect(translate('fr', {}, { a: 'A' }, 'a')).toBe('A');
    expect(translate('fr', {}, {}, 'missing.key')).toBe('missing.key');
  });
});

describe('dictionaries', () => {
  it('French has every English key and no extra one', () => {
    expect(Object.keys(en).filter((k) => !(k in fr))).toEqual([]);
    expect(Object.keys(fr).filter((k) => !(k in en))).toEqual([]);
  });

  it('placeholders match between languages', () => {
    expect(placeholderMismatches(en, fr)).toEqual([]);
  });

  it('every OSM category id has a label', async () => {
    const { CATEGORY_IDS } = await import('@triangulair/osm');
    for (const id of CATEGORY_IDS) expect(en[`category.${id}`], id).toBeDefined();
  });
});
