/**
 * i18n for the app: English and French, device language by default
 * (EXPO_PUBLIC_LOCALE forces one; on web `?lang=fr` too, handy for testing).
 */
import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { FORCED_LOCALE } from '../config';
import { getSetting, setSetting } from '../data/deviceSettings';
import { pickLocale, translate, type Locale, type Messages, type Params } from './core';
import { en } from './en';
import { fr } from './fr';

const DICTS: Record<Locale, Messages> = { en, fr };

export type TFunction = (key: string, params?: Params) => string;

export interface I18n {
  locale: Locale;
  /** Region of the device (ISO 3166-1), for holidays and units; may be undefined. */
  region: string | undefined;
  t: TFunction;
  has: (key: string) => boolean;
  setLocale: (l: Locale) => void;
  /** The language chosen in the settings, or null to follow the device. */
  chosen: Locale | null;
  /** Choose a language (null: follow the device), kept per device. */
  choose: (l: Locale | null) => void;
}

function deviceTags(): string[] {
  const tags: string[] = [];
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    try {
      const q = new URLSearchParams(window.location.search).get('lang');
      if (q) tags.push(q);
    } catch {
      // ignore
    }
    if (typeof navigator !== 'undefined') tags.push(...(navigator.languages ?? []), navigator.language);
  }
  try {
    tags.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    // ignore
  }
  return tags.filter(Boolean);
}

function deviceRegion(): string | undefined {
  for (const tag of deviceTags()) {
    const m = /^[a-z]{2,3}[-_]([A-Z]{2})\b/i.exec(tag);
    if (m) return m[1]!.toUpperCase();
  }
  return undefined;
}

export function makeI18n(
  locale: Locale,
  setLocale: (l: Locale) => void = () => {},
  chosen: Locale | null = null,
  choose: (l: Locale | null) => void = () => {},
): I18n {
  const dict = DICTS[locale];
  return {
    locale,
    region: deviceRegion(),
    t: (key, params) => translate(locale, dict, en, key, params),
    has: (key) => dict[key] !== undefined || en[key] !== undefined,
    setLocale,
    chosen,
    choose,
  };
}

function savedLocale(): Locale | null {
  const v = getSetting('locale');
  return v === 'en' || v === 'fr' ? v : null;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<Locale | null>(savedLocale);
  const [locale, setLocale] = useState<Locale>(() => pickLocale([FORCED_LOCALE, savedLocale(), ...deviceTags()]));
  const value = useMemo(
    () =>
      makeI18n(locale, setLocale, chosen, (l) => {
        setSetting('locale', l ?? 'auto');
        setChosen(l);
        setLocale(l ?? pickLocale([FORCED_LOCALE, ...deviceTags()]));
      }),
    [locale, chosen],
  );
  return createElement(I18nContext.Provider, { value }, children);
}

const fallback = makeI18n('en');

export function useI18n(): I18n {
  return useContext(I18nContext) ?? fallback;
}
