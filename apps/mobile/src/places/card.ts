/**
 * Place card content from cached OSM data (T-107): category, address,
 * opening line ("Open, closes at 10 pm"), happy hour, practical chips.
 * Pure, unit-tested; wording comes from the i18n dictionaries.
 */
import type { PlaceRecord } from '@triangulair/data';
import {
  DIET_KINDS,
  formatClock,
  happyHourStatus,
  openingContextOf,
  openingStatus,
  type CategoryId,
  type OpeningStatus,
  type PlaceInfo,
} from '@triangulair/osm';

import type { Params } from '../i18n/core';

export interface Translator {
  t: (key: string, params?: Params) => string;
  has: (key: string) => boolean;
  locale: string;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function clock(d: Date, locale: string): string {
  return formatClock(d, locale);
}

/** "at 10 pm", "tomorrow at 9 am", "Monday at 9 am". */
export function describeWhen(d: Date, now: Date, tr: Translator): string {
  const time = clock(d, tr.locale);
  if (sameDay(d, now)) return tr.t('opening.at', { time });
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameDay(d, tomorrow)) return tr.t('opening.tomorrowAt', { time });
  const day = new Intl.DateTimeFormat(tr.locale, { weekday: 'long' }).format(d);
  return tr.t('opening.dayAt', { day, time });
}

export type OpeningTone = 'open' | 'closed' | 'unknown';

export function describeOpeningStatus(s: OpeningStatus, now: Date, tr: Translator): { text: string; tone: OpeningTone } | null {
  if (s.state === 'open') {
    return { text: s.closesAt ? tr.t('opening.openCloses', { when: describeWhen(s.closesAt, now, tr) }) : tr.t('opening.open247'), tone: 'open' };
  }
  if (s.state === 'closed') {
    return { text: s.opensAt ? tr.t('opening.closedOpens', { when: describeWhen(s.opensAt, now, tr) }) : tr.t('opening.closed'), tone: 'closed' };
  }
  if (s.reason === 'missing') return null;
  return { text: s.raw ? tr.t('opening.raw', { raw: s.raw }) : tr.t('opening.unknown'), tone: 'unknown' };
}

export function describeHappyHourLine(value: string | undefined, now: Date, tr: Translator, country?: string, info?: PlaceInfo): string | null {
  if (!value) return null;
  const s = happyHourStatus(value, now, info ? openingContextOf(info, country) : {});
  if (s.state !== 'active') return null;
  if (!s.until) return tr.t('happyHour.now');
  return sameDay(s.until, now)
    ? tr.t('happyHour.until', { time: clock(s.until, tr.locale) })
    : tr.t('happyHour.untilWhen', { when: describeWhen(s.until, now, tr) });
}

/** "Italian", or the raw OSM value made readable ("bubble_tea" -> "Bubble tea"). */
export function cuisineLabel(value: string, tr: Translator): string {
  const key = `cuisine.${value}`;
  if (tr.has(key)) return tr.t(key);
  const s = value.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function categoryLabel(category: CategoryId | null | undefined, tr: Translator): string {
  return tr.t(`category.${category ?? 'other'}`);
}

export interface CardChip {
  key: string;
  label: string;
}

export function practicalChips(info: PlaceInfo, tr: Translator): CardChip[] {
  const chips: CardChip[] = [];
  if (info.outdoorSeating === 'yes') chips.push({ key: 'terrace', label: tr.t('chip.terrace') });
  if (info.outdoorSeating === 'no') chips.push({ key: 'noTerrace', label: tr.t('chip.noTerrace') });
  for (const kind of DIET_KINDS) {
    const v = info.diet[kind];
    if (v === 'yes' || v === 'limited') chips.push({ key: `diet:${kind}`, label: tr.t(`diet.${kind}.options`) });
    if (v === 'only') chips.push({ key: `diet:${kind}`, label: tr.t(`diet.${kind}.only`) });
  }
  for (const c of info.cuisine) chips.push({ key: `cuisine:${c}`, label: cuisineLabel(c, tr) });
  if (info.reservation) chips.push({ key: 'reservation', label: tr.t(`reservation.${info.reservation}`) });
  if (info.fee === false) chips.push({ key: 'fee', label: tr.t('chip.free') });
  if (info.fee === true) {
    const price = info.charge[0]?.raw;
    chips.push({ key: 'fee', label: price ? tr.t('chip.paidPrice', { price }) : tr.t('chip.paid') });
  }
  if (info.wifi === 'yes') chips.push({ key: 'wifi', label: tr.t('chip.wifi') });
  if (info.secondHand === 'yes' || info.secondHand === 'only') chips.push({ key: 'secondHand', label: tr.t('chip.secondHand') });
  if (info.organic === 'yes' || info.organic === 'only') chips.push({ key: 'organic', label: tr.t('chip.organic') });
  return chips;
}

export interface CardInfo {
  category: string;
  address: string | null;
  opening: { text: string; tone: OpeningTone } | null;
  happyHour: string | null;
  chips: CardChip[];
  website: string | null;
  phone: string | null;
  /** OSM page, for OSM places only. */
  osmUrl: string | null;
  maybeClosed: boolean;
}

export function cardInfo(
  place: Pick<PlaceRecord, 'osmType' | 'address' | 'website' | 'phone' | 'openingHours' | 'status'>,
  info: PlaceInfo | null,
  now: Date,
  tr: Translator,
  country?: string,
): CardInfo {
  const hours = info?.openingHours ?? place.openingHours ?? undefined;
  const ctx = info ? openingContextOf(info, country) : {};
  return {
    category: categoryLabel(info?.category, tr),
    address: info?.address.formatted ?? place.address ?? null,
    opening: hours ? describeOpeningStatus(openingStatus(hours, now, ctx), now, tr) : null,
    happyHour: describeHappyHourLine(info?.happyHours, now, tr, country, info ?? undefined),
    chips: info ? practicalChips(info, tr) : [],
    website: info?.contact.website ?? place.website ?? null,
    phone: info?.contact.phones[0] ?? place.phone ?? null,
    osmUrl: place.osmType && info ? info.osmUrl : null,
    maybeClosed: place.status !== 'open',
  };
}

/** "120 m", "1.4 km" (metric for now; miles by region come with settings). */
export function formatDistance(m: number | null | undefined, tr: Translator): string | null {
  if (m === null || m === undefined || !Number.isFinite(m)) return null;
  if (m < 1000) return tr.t('units.m', { n: Math.max(1, Math.round(m / 10) * 10) });
  const km = m < 10_000 ? Math.round(m / 100) / 10 : Math.round(m / 1000);
  return tr.t('units.km', { n: new Intl.NumberFormat(tr.locale).format(km) });
}
