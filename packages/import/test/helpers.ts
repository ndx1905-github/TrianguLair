// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DataStore } from '@triangulair/data';
import { NodeSqliteDriver } from '@triangulair/data/node';

import type { OsmCandidate, OsmLookup, SearchHit } from '../src/index.ts';

export const ME = 'ed25519:me';

export function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));
}

export function fixtureText(rel: string): string {
  return readFileSync(fixturePath(rel), 'utf8');
}

export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(rel)));
}

export function seqIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(n++).toString(36).padStart(6, '0')}`;
}

export function fakeClock(start = 1_760_000_000_000): () => number {
  let t = start;
  return () => (t += 1000);
}

export function openStore(prefix = 'id'): DataStore {
  return DataStore.open({ driver: new NodeSqliteDriver(':memory:'), meId: ME, now: fakeClock(), newId: seqIds(prefix) });
}

interface RawElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'historic', 'boundary', 'place'];

/** The osm package's synthetic Overpass answer for the Marais, as candidates. */
export function maraisCandidates(): OsmCandidate[] {
  const url = new URL('../../osm/test/fixtures/overpass/nearby-marais.json', import.meta.url);
  const raw = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as { elements: RawElement[] };
  return raw.elements
    .filter((e) => e.tags?.name)
    .map((e) => {
      const lat = e.lat ?? e.center!.lat;
      const lon = e.lon ?? e.center!.lon;
      const k = KEYS.find((x) => e.tags![x]);
      const street = e.tags!['addr:street'];
      return {
        ref: { type: e.type, id: e.id },
        name: e.tags!.name!,
        lat,
        lon,
        category: k ? `${k}=${e.tags![k]}` : null,
        ...(street && { address: `${e.tags!['addr:housenumber'] ?? ''} ${street}`.trim() }),
        tags: e.tags!,
      };
    });
}

/** Offline lookup over the Marais fixture: bbox filter, and a word search like the app's fixture fetch. */
export function fixtureLookup(opts: { failBBox?: boolean } = {}): OsmLookup & { bboxCalls: number; searchCalls: string[] } {
  const all = maraisCandidates();
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const l = {
    bboxCalls: 0,
    searchCalls: [] as string[],
    async inBBox(b: { south: number; west: number; north: number; east: number }) {
      l.bboxCalls++;
      if (opts.failBBox) throw new Error('offline');
      return all.filter((c) => c.lat >= b.south && c.lat <= b.north && c.lon >= b.west && c.lon <= b.east);
    },
    async search(q: string): Promise<SearchHit[]> {
      l.searchCalls.push(q);
      const words = fold(q.split(',')[0]!).split(/\s+/).filter(Boolean);
      return all
        .filter((c) => words.every((w) => fold(c.name).includes(w)))
        .map((c) => ({ ref: c.ref, name: c.name, lat: c.lat, lon: c.lon, category: c.category, kind: 'poi' as const, ...(c.address && { address: c.address }) }));
    },
  };
  return l;
}
