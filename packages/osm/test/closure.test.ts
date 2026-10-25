import { describe, expect, it } from 'vitest';
import { ClosureChecker } from '../src/closure/checker.ts';
import {
  CHECK_INTERVAL_DAYS,
  isCheckDue,
  nextCheckAt,
  placesDueForCheck,
  shouldShowClosureNotice,
} from '../src/closure/schedule.ts';
import {
  type ClosureSignal,
  assessClosure,
  endDatePassed,
  osmSignals,
  reportSignals,
  sameName,
  snapshotOf,
} from '../src/closure/signals.ts';
import { OsmApiClient } from '../src/osmapi.ts';
import { OverpassClient } from '../src/overpass.ts';
import type { OsmElement } from '../src/types.ts';
import { fakeFetch, fixture, fixtureJson, testHttp } from './support/fake.ts';

const NOW = new Date('2026-10-26T09:00:00Z');
const refresh = fixtureJson<{ elements: OsmElement[] }>('overpass/elements-refresh.json').elements;
const el = (id: number) => refresh.find((e) => e.id === id)!;
const present = (id: number) => ({ kind: 'present' as const, element: el(id) });
const codes = (s: ClosureSignal[]) => s.map((x) => `${x.code}:${x.reliability}`);

describe('osmSignals on recorded OSM cases', () => {
  it('unchanged place: no signal', () => {
    const e = el(9123456702);
    expect(osmSignals(present(9123456702), snapshotOf(e), NOW)).toEqual([]);
  });

  it('disused:amenity=restaurant with the name moved to old_name: high, no duplicate name signal', () => {
    const s = osmSignals(present(9123456720), { name: 'Chez Paulette', category: 'restaurant', openingHours: 'Mo-Fr 12:00-14:00' }, NOW);
    expect(codes(s)).toEqual(['lifecycle_prefix:high']);
    expect(s[0]).toMatchObject({
      detail: 'Tagged disused:amenity=restaurant',
      since: '2026-09-14T09:03:12Z',
      osmVersion: 8,
      observedAt: NOW.toISOString(),
    });
  });

  it('shop=vacant: high', () => {
    expect(codes(osmSignals(present(9123456721), { name: 'Librairie Fictive', category: 'bookshop' }, NOW))).toEqual(['shop_vacant:high']);
  });

  it('new business at the same element: name and category changed (medium)', () => {
    const s = osmSignals(present(9123456722), { name: 'Café du Coin', category: 'cafe' }, NOW);
    expect(codes(s)).toEqual(['name_changed:medium', 'category_changed:medium']);
    expect(s[0]!.data).toEqual({ previous: 'Café du Coin', current: 'Tapioca Corner' });
    expect(s[1]!.data).toEqual({ previous: 'cafe', current: 'fast_food' });
  });

  it('end_date in the past: high', () => {
    expect(codes(osmSignals(present(9123456723), { name: 'Le Zinc Fictif', category: 'bar' }, NOW))).toEqual(['end_date_past:high']);
  });

  it('opening hours removed (low) or set to off (low)', () => {
    const e = el(9123456702);
    const noHours: OsmElement = { ...e, tags: { ...e.tags, opening_hours: undefined as unknown as string } };
    delete noHours.tags!.opening_hours;
    expect(codes(osmSignals({ kind: 'present', element: noHours }, snapshotOf(e), NOW))).toEqual(['opening_hours_removed:low']);
    const off: OsmElement = { ...e, tags: { ...e.tags, opening_hours: 'off' } };
    expect(codes(osmSignals({ kind: 'present', element: off }, snapshotOf(e), NOW))).toEqual(['opening_hours_off:low']);
  });

  it('a lifecycle prefix next to a live tag records a previous use (medium)', () => {
    const e: OsmElement = { type: 'node', id: 1, tags: { amenity: 'cafe', name: 'New', 'was:shop': 'books' } };
    expect(codes(osmSignals({ kind: 'present', element: e }, undefined, NOW))).toEqual(['lifecycle_prefix:medium']);
  });

  it('a renamed accent or case is not a new business', () => {
    const e: OsmElement = { type: 'node', id: 1, tags: { amenity: 'cafe', name: 'CAFE PENDULE' } };
    expect(osmSignals({ kind: 'present', element: e }, { name: 'Café Pendule', category: 'cafe' }, NOW)).toEqual([]);
    expect(sameName("L'Écume", 'l ecume')).toBe(true);
  });

  it('deleted (confirmed) and missing (unconfirmed)', () => {
    expect(osmSignals({ kind: 'deleted', deletedAt: '2026-09-03T17:41:20Z' }, undefined, NOW)).toEqual([
      { code: 'deleted', reliability: 'high', source: 'osm', detail: 'Deleted from OpenStreetMap', since: '2026-09-03T17:41:20Z', observedAt: NOW.toISOString() },
    ]);
    expect(codes(osmSignals({ kind: 'missing' }, undefined, NOW))).toEqual(['not_found:high']);
  });

  it('endDatePassed handles years, months, days', () => {
    expect(endDatePassed('2026-06-30', NOW)).toBe(true);
    expect(endDatePassed('2026-10', NOW)).toBe(false);
    expect(endDatePassed('2026', NOW)).toBe(false);
    expect(endDatePassed('2025', NOW)).toBe(true);
    expect(endDatePassed('soon', NOW)).toBe(false);
  });
});

describe('reports and assessment', () => {
  it('one report is medium, two distinct reporters are high; latest report per person wins', () => {
    expect(codes(reportSignals([{ by: 'me', kind: 'closed', reportedAt: '2026-10-01T00:00:00Z' }], NOW))).toEqual(['user_report:medium']);
    expect(
      codes(
        reportSignals(
          [
            { by: 'me', kind: 'closed', reportedAt: '2026-10-01T00:00:00Z' },
            { by: 'alice', kind: 'closed', reportedAt: '2026-10-02T00:00:00Z' },
            { by: 'bob', kind: 'closed', reportedAt: '2026-10-02T00:00:00Z' },
            { by: 'bob', kind: 'open', reportedAt: '2026-10-05T00:00:00Z' },
          ],
          NOW,
        ),
      ),
    ).toEqual(['user_report:high', 'friend_report:high']);
  });

  it('no signal: open; any signal: maybe closed; never closed without the user', () => {
    expect(assessClosure([]).status).toBe('open');
    const s = osmSignals(present(9123456720), undefined, NOW);
    expect(assessClosure(s)).toMatchObject({ status: 'maybe_closed', reliability: 'high', since: '2026-09-14T09:03:12Z', suggestOsmEdit: false });
    expect(assessClosure(s, { decision: 'closed', decidedAt: '2026-10-26T10:00:00Z' }).status).toBe('closed');
  });

  it('"still open" dismisses signals up to the answer, but not newer evidence', () => {
    const s = osmSignals(present(9123456720), undefined, NOW);
    expect(assessClosure(s, { decision: 'still_open', decidedAt: '2026-10-01T00:00:00Z' }).status).toBe('open');
    expect(assessClosure(s, { decision: 'still_open', decidedAt: '2026-09-01T00:00:00Z' }).status).toBe('maybe_closed');
    // Undated evidence was seen by the user when answering.
    expect(assessClosure(osmSignals({ kind: 'missing' }, undefined, NOW), { decision: 'still_open', decidedAt: '2026-01-01T00:00:00Z' }).status).toBe('open');
  });

  it('offers to fix OSM when only people report the closure', () => {
    const r = reportSignals([{ by: 'alice', kind: 'closed', reportedAt: '2026-10-02T00:00:00Z' }], NOW);
    expect(assessClosure(r)).toMatchObject({ status: 'maybe_closed', suggestOsmEdit: true });
    expect(assessClosure([], { decision: 'closed', decidedAt: '2026-10-02T00:00:00Z' }).suggestOsmEdit).toBe(true);
  });

  it('minReliability filters weak signals', () => {
    const e = el(9123456702);
    const off: OsmElement = { ...e, tags: { ...e.tags, opening_hours: 'off' } };
    const s = osmSignals({ kind: 'present', element: off }, snapshotOf(e), NOW);
    expect(assessClosure(s, undefined, { minReliability: 'medium' }).status).toBe('open');
  });
});

describe('monthly schedule', () => {
  const ref = { type: 'node' as const, id: 1 };
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

  it('due when never checked or older than a month; never for manual or confirmed-closed places', () => {
    expect(isCheckDue({ ref }, NOW)).toBe(true);
    expect(isCheckDue({ ref, lastCheckedAt: daysAgo(CHECK_INTERVAL_DAYS) }, NOW)).toBe(true);
    expect(isCheckDue({ ref, lastCheckedAt: daysAgo(29) }, NOW)).toBe(false);
    expect(isCheckDue({ ref: null }, NOW)).toBe(false);
    expect(isCheckDue({ ref, status: 'closed' }, NOW)).toBe(false);
    expect(isCheckDue({ ref, lastCheckedAt: daysAgo(-400) }, NOW)).toBe(true); // clock was wrong
  });

  it('batch: never-checked first, then oldest, capped', () => {
    const places = [
      { id: 'a', ref, lastCheckedAt: daysAgo(31) },
      { id: 'b', ref, lastCheckedAt: daysAgo(90) },
      { id: 'c', ref, lastCheckedAt: daysAgo(3) },
      { id: 'd', ref },
      { id: 'e', ref: null },
    ];
    expect(placesDueForCheck(places, NOW).map((p) => p.id)).toEqual(['d', 'b', 'a']);
    expect(placesDueForCheck(places, NOW, { maxBatch: 2 }).map((p) => p.id)).toEqual(['d', 'b']);
  });

  it('next check date and grouped notice at most once a month', () => {
    expect(nextCheckAt({ ref, lastCheckedAt: '2026-10-01T00:00:00.000Z' })?.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(shouldShowClosureNotice(null, 2, NOW)).toBe(true);
    expect(shouldShowClosureNotice(daysAgo(10), 2, NOW)).toBe(false);
    expect(shouldShowClosureNotice(daysAgo(31), 2, NOW)).toBe(true);
    expect(shouldShowClosureNotice(null, 0, NOW)).toBe(false);
  });
});

describe('ClosureChecker against recorded Overpass and OSM API responses', () => {
  const OP = 'https://overpass.test/api/interpreter';
  const API = 'https://osmapi.test';

  function setup(withApi = true) {
    const ff = fakeFetch()
      .on('node(id:', fixture('overpass/elements-refresh.json'))
      .on('around:20,48.85881,2.36177', fixture('overpass/successor-around.json'))
      .on('around:', fixture('overpass/empty.json'))
      .on(`${API}/api/0.6/node/9123456730.json`, new Response('', { status: 410 }))
      .on(`${API}/api/0.6/node/9123456730/history.json`, fixture('osmapi/history-node-9123456730.json'))
      .on(`${API}/api/0.6/node/9123456731.json`, fixture('osmapi/node-9123456731.json'));
    const http = testHttp(ff);
    const checker = new ClosureChecker({
      overpass: new OverpassClient({ http, endpoints: [OP] }),
      ...(withApi ? { osmApi: new OsmApiClient({ http, baseUrl: API }) } : {}),
      now: () => NOW,
    });
    return { ff, checker };
  }

  const inputs = [
    { ref: { type: 'node' as const, id: 9123456702 }, previous: snapshotOf(el(9123456702)) },
    { ref: { type: 'node' as const, id: 9123456720 }, previous: { name: 'Chez Paulette', category: 'restaurant' as const } },
    {
      ref: { type: 'node' as const, id: 9123456730 },
      previous: { name: 'Le Petit Fictif', category: 'restaurant' as const, location: { lat: 48.85881, lon: 2.36177 } },
    },
    { ref: { type: 'node' as const, id: 9123456731 }, previous: { name: 'Café Tout Neuf', category: 'cafe' as const } },
    { ref: { type: 'way' as const, id: 412345678 }, previous: { name: 'Musée des Cartes Anciennes', category: 'museum' as const } },
  ];

  it('one batch query, deletion confirmed with its date, successor found, cards refreshed', async () => {
    const { ff, checker } = setup();
    const r = await checker.check(inputs);
    const by = (id: number) => r.find((x) => x.ref.id === id)!;

    expect(ff.calls.filter((c) => c.url === OP && (c.body ?? '').includes('id%3A'))).toHaveLength(1);

    expect(by(9123456702).assessment.status).toBe('open');
    expect(by(9123456702).place?.name).toBe('Trattoria Da Lucia');
    expect(by(9123456702).snapshot).toMatchObject({ version: 5, category: 'restaurant' });

    expect(by(9123456720).assessment).toMatchObject({ status: 'maybe_closed', reliability: 'high' });

    const deleted = by(9123456730);
    expect(deleted.observation).toMatchObject({ kind: 'deleted', deletedAt: '2026-09-03T17:41:20Z' });
    expect(deleted.assessment).toMatchObject({ status: 'maybe_closed', since: '2026-09-03T17:41:20Z' });
    expect(deleted.successor?.name).toBe('Bao Fictif');
    expect(deleted.place).toBeNull();
    expect(deleted.snapshot?.name).toBe('Le Petit Fictif');

    // Missing from Overpass but present in the OSM API (Overpass lag): no signal.
    expect(by(9123456731).assessment.status).toBe('open');
    expect(by(9123456731).place?.name).toBe('Café Tout Neuf');

    expect(by(412345678).assessment.status).toBe('open');
    expect(r.every((x) => x.checkedAt === NOW.toISOString())).toBe(true);
  });

  it('without the OSM API, a missing element is "not found" (high)', async () => {
    const { checker } = setup(false);
    const r = await checker.check([inputs[2]!]);
    expect(codes(r[0]!.signals)).toEqual(['not_found:high']);
    expect(r[0]!.assessment.status).toBe('maybe_closed');
  });

  it('respects the OSM API budget', async () => {
    const { ff, checker } = setup();
    const c = new ClosureChecker({
      overpass: (checker as unknown as { o: { overpass: OverpassClient } }).o.overpass,
      osmApi: new OsmApiClient({ http: testHttp(ff), baseUrl: API }),
      maxDeletionChecks: 0,
      successorRadius: 0,
      now: () => NOW,
    });
    const r = await c.check([inputs[2]!]);
    expect(r[0]!.observation.kind).toBe('missing');
    expect(ff.calls.some((call) => call.url.startsWith(API))).toBe(false);
  });
});
