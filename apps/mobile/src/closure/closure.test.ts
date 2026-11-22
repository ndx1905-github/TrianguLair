import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { DataStore, placeIdFromOsm, type PlaceRecord } from '@triangulair/data';
import { createOsmClient, type CheckResult, type ClosureSignal } from '@triangulair/osm';

import { FIXTURE_CLOSED_PLACE, FIXTURE_SAVED_PLACE, seedDemoData } from '../data/demo';
import { SqlJsDriver } from '../data/sqljsDriver';
import { translate } from '../i18n/core';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import { createFixtureFetch } from '../osm/fixtureFetch';
import { loadFixtures } from '../osm/fixtures';
import { TAGS } from '../theme/tags';
import { checkInputOf, dueCandidates, isDueOnCardOpen, noticeFor, parseResolutions, patchFromResolution, patchFromResult, readSignals, signalsSince } from './glue';
import { signalText } from './labels';
import { loadResolutions, myOsmPlaces, resolveClosure, runDueChecks } from './run';

const DAY = 24 * 3600_000;
const NOW = new Date('2026-10-23T16:30:00Z');

const rec = (over: Partial<PlaceRecord>): PlaceRecord =>
  ({
    id: 'osm:node/1', osmType: 'node', osmId: 1, name: 'P', category: 'amenity=restaurant', kind: 'place', edge: 'sharp',
    geometry: { type: 'Point', coordinates: [2.35, 48.85] }, lat: 48.85, lon: 2.35, bbox: [2.35, 48.85, 2.35, 48.85],
    address: null, openingHours: null, website: null, phone: null, osmTags: null, photos: null, status: 'open', closedSignals: null, osmSyncedAt: null,
    ...over,
  }) as PlaceRecord;

describe('closed-place schedule glue', () => {
  it('due places: OSM only, never-checked first, then the oldest; confirmed closed ones skipped', () => {
    const places = [
      rec({ id: 'osm:node/1', osmId: 1, osmSyncedAt: NOW.getTime() - 40 * DAY }),
      rec({ id: 'osm:node/2', osmId: 2, osmSyncedAt: null }),
      rec({ id: 'osm:node/3', osmId: 3, osmSyncedAt: NOW.getTime() - 3 * DAY }),
      rec({ id: 'local:abc', osmType: null, osmId: null, osmSyncedAt: null }),
      rec({ id: 'osm:node/5', osmId: 5, osmSyncedAt: null, status: 'closed' }),
      rec({ id: 'osm:node/6', osmId: 6, osmSyncedAt: NOW.getTime() - 90 * DAY }),
    ];
    expect(dueCandidates(places, NOW).map((c) => c.placeId)).toEqual(['osm:node/2', 'osm:node/6', 'osm:node/1']);
    expect(dueCandidates(places, NOW, 1).map((c) => c.placeId)).toEqual(['osm:node/2']);
    expect(isDueOnCardOpen(places[2]!, NOW)).toBe(false);
    expect(isDueOnCardOpen(places[0]!, NOW)).toBe(true);
  });

  it('the previous snapshot comes from the cached OSM tags', () => {
    const input = checkInputOf(rec({ name: 'Chez Paulette', osmTags: { amenity: 'restaurant', opening_hours: 'Mo 10:00-12:00' } }), { decision: 'still_open', decidedAt: '2026-01-01T00:00:00Z' })!;
    expect(input.ref).toEqual({ type: 'node', id: 1 });
    expect(input.previous).toMatchObject({ name: 'Chez Paulette', category: 'restaurant', openingHours: 'Mo 10:00-12:00' });
    expect(input.resolution?.decision).toBe('still_open');
    expect(checkInputOf(rec({ id: 'local:x', osmType: null, osmId: null }), undefined)).toBeNull();
  });

  it('results and answers become place-cache patches; stored signals are read defensively', () => {
    const signal: ClosureSignal = { code: 'lifecycle_prefix', reliability: 'high', source: 'osm', detail: 'x', observedAt: NOW.toISOString(), since: '2026-09-14T09:03:12Z', data: { key: 'disused:amenity', value: 'restaurant' } };
    const result = {
      ref: { type: 'node', id: 1 },
      checkedAt: NOW.toISOString(),
      observation: { kind: 'missing' },
      place: null,
      snapshot: undefined,
      signals: [signal],
      assessment: { status: 'maybe_closed', signals: [signal], suggestOsmEdit: false },
    } as unknown as CheckResult;
    expect(patchFromResult(result)).toEqual({ status: 'maybe_closed', closedSignals: [signal], osmSyncedAt: NOW.getTime() });
    expect(patchFromResolution('closed', [signal])).toEqual({ status: 'closed', closedSignals: [signal] });
    expect(patchFromResolution('still_open', [signal])).toEqual({ status: 'open', closedSignals: [] });
    expect(readSignals(rec({ closedSignals: [signal, { code: 'nope' }, null, 'x'] }))).toEqual([signal]);
    expect(signalsSince([signal])).toBe('2026-09-14T09:03:12Z');
    const tr = { t: (k: string, p?: Record<string, string | number>) => translate('fr', fr, en, k, p), has: (k: string) => k in fr, locale: 'fr' };
    expect(signalText(signal, tr)).toBe('Marqué « plus en activité » dans OpenStreetMap (disused:amenity=restaurant)');
  });

  it('resolutions parse defensively; the grouped notice comes at most once a month', () => {
    expect(parseResolutions('{"a":{"decision":"closed","decidedAt":"2026-10-01T00:00:00Z"},"b":{"decision":"x"},"c":3}')).toEqual({
      a: { decision: 'closed', decidedAt: '2026-10-01T00:00:00Z' },
    });
    expect(parseResolutions('nope')).toEqual({});
    const places = [{ id: 'a', name: 'A' }];
    expect(noticeFor(places, null, NOW)).toEqual({ places });
    expect(noticeFor(places, new Date(NOW.getTime() - 10 * DAY).toISOString(), NOW)).toBeNull();
    expect(noticeFor(places, new Date(NOW.getTime() - 31 * DAY).toISOString(), NOW)).toEqual({ places });
    expect(noticeFor([], null, NOW)).toBeNull();
  });
});

describe('closed-place check against the fixtures (run.ts)', () => {
  it('flags the disused restaurant, then "still open" sticks across the next monthly check', async () => {
    const SQL = await initSqlJs();
    let n = 0;
    const store = DataStore.open({ driver: new SqlJsDriver(new SQL.Database()), meId: 'ed25519:test-owner', actor: 'bb'.repeat(16), newId: () => `id${++n}` });
    seedDemoData(store, { tagName: (id) => TAGS[id].label, fixtures: true, now: NOW.getTime() });
    const osm = createOsmClient({
      userAgent: 'TrianguLair-tests/0.0.1 (+https://github.com/ndx1905-github/TrianguLair)',
      fetch: createFixtureFetch(loadFixtures(), { delayMs: 0 }),
      platform: 'web',
      rateLimits: { overpass: { minIntervalMs: 0, maxConcurrent: 4 }, osmApi: { minIntervalMs: 0, maxConcurrent: 4 } },
      closure: { now: () => NOW },
    });
    const mutate = <T,>(fn: (s: DataStore) => T): T => fn(store);
    const closedId = placeIdFromOsm('node', FIXTURE_CLOSED_PLACE.osm.id);

    // Only my OSM places are candidates; the Trattoria was synced at the seed, so only Chez Paulette is due.
    expect(myOsmPlaces(store.repo).map((p) => p.id).sort()).toEqual([closedId, placeIdFromOsm('node', FIXTURE_SAVED_PLACE.osm.id)].sort());
    expect(await runDueChecks(store.repo, osm, mutate, new AbortController().signal, NOW)).toBe(1);
    let place = store.repo.getPlace(closedId)!;
    expect(place.status).toBe('maybe_closed');
    expect(readSignals(place).map((s) => s.code)).toContain('lifecycle_prefix');
    expect(place.osmTags?.['disused:amenity']).toBe('restaurant');

    resolveClosure(place, 'still_open', mutate, NOW);
    expect(loadResolutions()[closedId]?.decision).toBe('still_open');
    expect(store.repo.getPlace(closedId)!.status).toBe('open');

    // A month later the same (older) evidence does not come back.
    const later = new Date(NOW.getTime() + 31 * DAY);
    expect(await runDueChecks(store.repo, osm, mutate, new AbortController().signal, later)).toBeGreaterThan(0);
    place = store.repo.getPlace(closedId)!;
    expect(place.status).toBe('open');

    resolveClosure(place, 'closed', mutate, later);
    expect(store.repo.getPlace(closedId)!.status).toBe('closed');
    // Confirmed closed: never checked again.
    expect(dueCandidates(myOsmPlaces(store.repo), new Date(later.getTime() + 60 * DAY)).map((c) => c.placeId)).not.toContain(closedId);
  });
});
