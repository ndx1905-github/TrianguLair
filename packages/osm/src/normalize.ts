/**
 * Normalization of OSM elements into the typed place card data (PlaceInfo)
 * the app stores in `places` and shows on the card. Pure functions only.
 *
 * Per the spec, `wheelchair` and other accessibility tags are not interpreted
 * in v1 (no accessibility work); they stay available in `tags`.
 */
import { type CategoryGroup, type CategoryId, categorize, categoryGroup } from './categories.ts';
import { elementPoint } from './geo.ts';
import type { LatLon, OsmElement, OsmRef, OsmTags } from './types.ts';
import { osmUrl } from './types.ts';

export type YesNo = 'yes' | 'no';
export type DietValue = 'yes' | 'only' | 'no' | 'limited';
export const DIET_KINDS = ['vegetarian', 'vegan', 'gluten_free', 'halal', 'kosher', 'lactose_free'] as const;
export type DietKind = (typeof DIET_KINDS)[number];
export type Reservation = 'required' | 'recommended' | 'yes' | 'no' | 'members_only';

export interface Charge {
  raw: string;
  amount?: number;
  /** ISO 4217 code. */
  currency?: string;
  /** Text after the amount, e.g. "reduced", "children". */
  note?: string;
}

export interface Address {
  street?: string;
  housenumber?: string;
  postcode?: string;
  city?: string;
  /** ISO 3166-1 alpha-2, upper case. */
  country?: string;
  /** One line, e.g. "12 Rue de Rivoli, 75001 Paris". */
  formatted?: string;
}

export interface Contact {
  website?: string;
  phones: string[];
  email?: string;
  facebook?: string;
  instagram?: string;
  /** Other `contact:*` social links, by network. */
  social: Record<string, string>;
}

export interface PlaceInfo {
  ref: OsmRef;
  osmUrl: string;
  location: LatLon | null;
  name?: string;
  /** `name:xx` translations. */
  names: Record<string, string>;
  brand?: string;
  category: CategoryId;
  categoryGroup: CategoryGroup;
  /** The OSM tag that decided the category (`amenity=restaurant`). */
  primaryTag?: { key: string; value: string };
  /** Set when the only category tag is lifecycle-prefixed (`disused:shop=…`). */
  lifecyclePrefix?: string;
  cuisine: string[];
  diet: Partial<Record<DietKind, DietValue>>;
  outdoorSeating?: YesNo;
  /** Raw `happy_hours` (opening_hours syntax), see `happyHourStatus`. */
  happyHours?: string;
  reservation?: Reservation;
  /** `fee`: true = paid, false = free, undefined = unknown. */
  fee?: boolean;
  charge: Charge[];
  /** Sub-type for sub-filters: `museum=*`. */
  museum?: string;
  /** Sub-type for sub-filters: `shop=*`. */
  shop?: string;
  secondHand?: 'yes' | 'only' | 'no';
  organic?: 'yes' | 'only' | 'no';
  wifi?: YesNo;
  /** Raw `opening_hours`, see `openingStatus`. */
  openingHours?: string;
  address: Address;
  contact: Contact;
  wikidata?: string;
  wikipedia?: string;
  /** Raw tags, for `places.osm_tags` and anything not normalized here. */
  tags: OsmTags;
  /** From `out meta` / the OSM API. */
  version?: number;
  timestamp?: string;
}

const splitMulti = (v: string | undefined): string[] =>
  v === undefined
    ? []
    : v
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);

function yesNo(v: string | undefined): YesNo | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'yes' || s === 'true' || s === '1') return 'yes';
  if (s === 'no' || s === 'false' || s === '0') return 'no';
  // Terrace values like "sidewalk", "garden", "patio" mean yes.
  if (['sidewalk', 'garden', 'patio', 'terrace', 'veranda', 'balcony', 'roof', 'pedestrian_zone', 'parklet'].includes(s)) {
    return 'yes';
  }
  return undefined;
}

function yesOnlyNo(v: string | undefined): 'yes' | 'only' | 'no' | undefined {
  const s = v?.trim().toLowerCase();
  if (s === 'only') return 'only';
  if (s === 'yes' || s === 'no') return s;
  return undefined;
}

function dietValue(v: string | undefined): DietValue | undefined {
  const s = v?.trim().toLowerCase();
  if (s === 'yes' || s === 'only' || s === 'no' || s === 'limited') return s;
  return undefined;
}

function reservation(v: string | undefined): Reservation | undefined {
  const s = v?.trim().toLowerCase();
  if (s === 'required' || s === 'recommended' || s === 'yes' || s === 'no' || s === 'members_only') return s;
  return undefined;
}

/** `fee`: yes/no plus the common variants; charge present implies paid. */
export function parseFee(fee: string | undefined, charge: string | undefined): boolean | undefined {
  const s = fee?.trim().toLowerCase();
  if (s === 'no' || s === 'free' || s === 'donation') return false;
  if (s === 'yes' || s === 'paid') return true;
  if (s && /\d/.test(s)) return true; // fee=5 EUR (misused, but means paid)
  if (charge && /[1-9]/.test(charge)) return true;
  return undefined;
}

const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP', '¥': 'JPY', 'CHF': 'CHF', 'Fr.': 'CHF' };

/**
 * Parses `charge` ("12 EUR", "€12", "12.50 EUR; 8 EUR reduced", "EUR 5", "5,50 €").
 * Unparseable parts keep only `raw`.
 */
export function parseCharge(value: string | undefined): Charge[] {
  return splitMulti(value).map((raw) => {
    const sym = '(€|\\$|£|¥|CHF|Fr\\.|[A-Z]{3})';
    const num = '(\\d+(?:[.,]\\d{1,2})?)';
    const after = new RegExp(`^${num}\\s*${sym}\\s*(.*)$`, 'i').exec(raw);
    const before = new RegExp(`^${sym}\\s*${num}\\s*(.*)$`, 'i').exec(raw);
    let amount: string | undefined;
    let cur: string | undefined;
    let note: string | undefined;
    if (after) [, amount, cur, note] = after;
    else if (before) [, cur, amount, note] = before;
    if (amount === undefined || cur === undefined) return { raw };
    const currency = CURRENCY_SYMBOLS[cur] ?? cur.toUpperCase();
    const c: Charge = { raw, amount: Number(amount.replace(',', '.')), currency };
    const n = note?.replace(/^[\s,/()-]+|[\s)]+$/g, '').replace(/^\(/, '');
    if (n) c.note = n;
    return c;
  });
}

/** Lowest known admission price, for the "under €X" filter. */
export function minCharge(charges: Charge[], currency?: string): Charge | undefined {
  return charges
    .filter((c) => c.amount !== undefined && (!currency || c.currency === currency))
    .sort((a, b) => a.amount! - b.amount!)[0];
}

/**
 * Normalizes a website: adds https:// when the scheme is missing, refuses
 * anything that is not http(s) (a `javascript:` value must never reach a link).
 */
export function normalizeUrl(v: string | undefined): string | undefined {
  if (!v) return undefined;
  let s = v.trim().split(/\s*;\s*/)[0] ?? '';
  if (!s || /\s/.test(s)) return undefined;
  if (/^www\./i.test(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s)) s = `https://${s}`;
  if (!/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(s)) return undefined;
  return s;
}

/** Splits `phone` (";" or "," separated), keeps characters a dialer understands. */
export function parsePhones(...values: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const p of (v ?? '').split(/[;,]/)) {
      const s = p.trim().replace(/[^\d+()\s.-]/g, '').trim();
      if (s.replace(/\D/g, '').length >= 3 && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

const SOCIAL_KEYS = ['facebook', 'instagram', 'twitter', 'mastodon', 'tiktok', 'youtube', 'linkedin', 'tripadvisor'];

function socialUrl(network: string, v: string): string | undefined {
  const url = normalizeUrl(v);
  if (url) return url;
  const handle = v.trim().replace(/^@/, '');
  if (!/^[\w.]+$/.test(handle)) return undefined;
  if (network === 'instagram') return `https://www.instagram.com/${handle}`;
  if (network === 'facebook') return `https://www.facebook.com/${handle}`;
  return undefined;
}

export function parseContact(tags: OsmTags): Contact {
  const contact: Contact = { phones: [], social: {} };
  const website = normalizeUrl(tags.website ?? tags['contact:website'] ?? tags.url);
  if (website) contact.website = website;
  contact.phones = parsePhones(tags.phone, tags['contact:phone'], tags['contact:mobile'], tags.mobile);
  const email = (tags.email ?? tags['contact:email'])?.split(';')[0]?.trim();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) contact.email = email;
  for (const net of SOCIAL_KEYS) {
    const v = tags[`contact:${net}`] ?? tags[net];
    if (!v) continue;
    const url = socialUrl(net, v);
    if (!url) continue;
    if (net === 'facebook') contact.facebook = url;
    else if (net === 'instagram') contact.instagram = url;
    else contact.social[net] = url;
  }
  return contact;
}

export function parseAddress(tags: OsmTags): Address {
  const a: Address = {};
  const street = tags['addr:street'] ?? tags['addr:place'];
  if (street) a.street = street;
  if (tags['addr:housenumber']) a.housenumber = tags['addr:housenumber'];
  if (tags['addr:postcode']) a.postcode = tags['addr:postcode'];
  const city = tags['addr:city'] ?? tags['addr:town'] ?? tags['addr:village'];
  if (city) a.city = city;
  const country = tags['addr:country'];
  if (country && /^[a-z]{2}$/i.test(country)) a.country = country.toUpperCase();
  const formatted = formatAddress(a);
  if (formatted) a.formatted = formatted;
  return a;
}

/** Country conventions for the number position: "12 Rue X" (FR, US, GB…) vs "Strasse 12" (DE, IT, ES…). */
const NUMBER_AFTER_STREET = new Set(['DE', 'AT', 'CH', 'IT', 'ES', 'PT', 'NL', 'BE', 'PL', 'CZ', 'SK', 'DK', 'SE', 'NO', 'FI', 'HR', 'SI', 'HU', 'BR', 'AR', 'MX']);

export function formatAddress(a: Address): string | undefined {
  let line1 = a.street ?? '';
  if (a.street && a.housenumber) {
    line1 = NUMBER_AFTER_STREET.has(a.country ?? '') ? `${a.street} ${a.housenumber}` : `${a.housenumber} ${a.street}`;
  }
  const line2 = [a.postcode, a.city].filter(Boolean).join(' ');
  const s = [line1, line2].filter(Boolean).join(', ');
  return s || undefined;
}

/** Normalizes a `cuisine` value: "Italian; pizza" → ["italian", "pizza"]. */
export function parseCuisine(v: string | undefined): string[] {
  return [...new Set(splitMulti(v).map((s) => s.toLowerCase().replace(/\s+/g, '_')))];
}

export function parseDiet(tags: OsmTags): Partial<Record<DietKind, DietValue>> {
  const out: Partial<Record<DietKind, DietValue>> = {};
  for (const kind of DIET_KINDS) {
    const v = dietValue(tags[`diet:${kind}`]);
    if (v) out[kind] = v;
  }
  return out;
}

/**
 * Normalizes an Overpass/OSM API element. Returns null for elements that are
 * not places one saves (no category and no name, e.g. a bare way of a building).
 */
export function normalizeElement(el: OsmElement): PlaceInfo | null {
  const tags = el.tags ?? {};
  const match = categorize(tags);
  if (!match && !tags.name) return null;
  const category = match?.category ?? 'other';
  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    const m = /^name:([a-z]{2,3}(?:-[A-Za-z]{2,4})?)$/.exec(k);
    if (m?.[1]) names[m[1]] = v;
  }
  const charge = parseCharge(tags.charge);
  const place: PlaceInfo = {
    ref: { type: el.type, id: el.id },
    osmUrl: osmUrl(el),
    location: elementPoint(el),
    names,
    category,
    categoryGroup: categoryGroup(category),
    cuisine: parseCuisine(tags.cuisine),
    diet: parseDiet(tags),
    charge,
    address: parseAddress(tags),
    contact: parseContact(tags),
    tags,
  };
  const name = tags.name ?? tags.brand;
  if (name) place.name = name;
  if (tags.brand) place.brand = tags.brand;
  if (match) place.primaryTag = { key: match.key, value: match.value };
  if (match?.lifecyclePrefix) place.lifecyclePrefix = match.lifecyclePrefix;
  const outdoor = yesNo(tags.outdoor_seating);
  if (outdoor) place.outdoorSeating = outdoor;
  if (tags.happy_hours) place.happyHours = tags.happy_hours;
  const res = reservation(tags.reservation);
  if (res) place.reservation = res;
  const fee = parseFee(tags.fee, tags.charge);
  if (fee !== undefined) place.fee = fee;
  if (tags.museum) place.museum = tags.museum;
  if (tags.shop) place.shop = tags.shop;
  const sh = yesOnlyNo(tags.second_hand);
  if (sh) place.secondHand = sh;
  const org = yesOnlyNo(tags.organic);
  if (org) place.organic = org;
  const ia = tags.internet_access?.toLowerCase();
  if (ia) place.wifi = ia === 'no' ? 'no' : ['wlan', 'yes', 'wifi', 'wireless'].includes(ia) ? 'yes' : undefined;
  if (place.wifi === undefined) delete place.wifi;
  if (tags.opening_hours) place.openingHours = tags.opening_hours.trim();
  if (tags.wikidata && /^Q\d+$/.test(tags.wikidata.trim())) place.wikidata = tags.wikidata.trim();
  if (tags.wikipedia) place.wikipedia = tags.wikipedia;
  if (el.version !== undefined) place.version = el.version;
  if (el.timestamp !== undefined) place.timestamp = el.timestamp;
  return place;
}
