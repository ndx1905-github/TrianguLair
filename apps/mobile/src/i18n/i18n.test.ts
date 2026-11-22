import { describe, expect, it, vi } from 'vitest';

import { fallbackPluralCategory, pickLocale, placeholderMismatches, translate } from './core';
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

  it('has built-in plural rules matching Intl.PluralRules (Hermes has no Intl.PluralRules)', () => {
    const counts = [0, 1, 1.5, 2, 3, 10, 21, 100, 1000, 1_000_000, 2_000_000, 1_500_000, -1];
    for (const locale of ['en', 'en-GB', 'fr', 'fr-CA']) {
      const intl = new Intl.PluralRules(locale);
      for (const n of counts) expect([locale, n, fallbackPluralCategory(locale, n)]).toEqual([locale, n, intl.select(n)]);
    }
  });

  it('translates plurals without Intl.PluralRules', async () => {
    const real = Intl.PluralRules;
    // A fresh module, so its cache of rules is empty.
    vi.resetModules();
    (Intl as { PluralRules?: unknown }).PluralRules = undefined;
    try {
      const core = await import('./core');
      const d = { n: { one: '{count} lieu', other: '{count} lieux' } };
      expect(core.translate('fr', d, {}, 'n', { count: 1 })).toBe('1 lieu');
      expect(core.translate('fr', d, {}, 'n', { count: 3 })).toBe('3 lieux');
      expect(core.translate('en', { n: { one: '{count} place', other: '{count} places' } }, {}, 'n', { count: 1 })).toBe('1 place');
    } finally {
      (Intl as { PluralRules?: unknown }).PluralRules = real;
    }
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
