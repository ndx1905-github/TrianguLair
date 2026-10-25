// SPDX-License-Identifier: MPL-2.0
/**
 * Identifiers.
 *
 * A place is keyed by its OpenStreetMap identity (spec "No duplicates"):
 * `osm:node/123`, `osm:way/456`, `osm:relation/789`. Two people (or two of my
 * devices) saving the same OSM object therefore always talk about the same
 * place id, which is what makes a single place card possible and lets the
 * Automerge documents of two devices meet on the same key.
 *
 * A place absent from OSM (manual point, drawn zone) gets `local:<random>`.
 */
import type { OsmType } from './types.ts';

const OSM_TYPES: readonly OsmType[] = ['node', 'way', 'relation'];
const OSM_ID_RE = /^osm:(node|way|relation)\/([1-9][0-9]{0,15})$/;

export function isOsmType(v: unknown): v is OsmType {
  return typeof v === 'string' && (OSM_TYPES as readonly string[]).includes(v);
}

export function placeIdFromOsm(osmType: OsmType, osmId: number): string {
  if (!isOsmType(osmType)) throw new TypeError(`invalid OSM type: ${String(osmType)}`);
  if (!Number.isSafeInteger(osmId) || osmId <= 0) throw new TypeError(`invalid OSM id: ${osmId}`);
  return `osm:${osmType}/${osmId}`;
}

/** Parses `osm:<type>/<id>`; returns null for local ids or malformed input. */
export function parseOsmPlaceId(id: string): { osmType: OsmType; osmId: number } | null {
  const m = OSM_ID_RE.exec(id);
  if (!m) return null;
  const osmId = Number(m[2]);
  if (!Number.isSafeInteger(osmId)) return null;
  return { osmType: m[1] as OsmType, osmId };
}

export function isLocalPlaceId(id: string): boolean {
  return /^local:[0-9a-z]{8,64}$/.test(id);
}

export type IdGenerator = () => string;

/** 128 random bits as 26 lowercase base-32 chars (Crockford alphabet). */
export const randomId: IdGenerator = () => {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) {
    // React Native: install a getRandomValues polyfill (expo-crypto) or pass `newId`.
    throw new Error('crypto.getRandomValues is not available; pass an id generator');
  }
  c.getRandomValues(bytes);
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
};

export function newLocalPlaceId(newId: IdGenerator = randomId): string {
  return `local:${newId()}`;
}

/**
 * SQLite id of a save: one save per owner and place, so the id is derived
 * from both (unique across owners in the local cache).
 */
export function saveIdFor(ownerId: string, placeId: string): string {
  return `${ownerId}|${placeId}`;
}
