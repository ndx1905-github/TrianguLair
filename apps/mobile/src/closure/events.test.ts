import { describe, expect, it } from 'vitest';
import type { ClosureSignal } from '@triangulair/osm';
import { MemoryStateStore } from '@triangulair/sync';

import { translate } from '../i18n/core';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import { filterEntries, placesOf, WhatsNewLog } from '../sync/whatsNew';
import { ClosureEventLog, isNewFlag, mainSignal, MAX_CLOSURE_ENTRIES, onClosureEvents, OWN_ENTRY_OWNER, type Detection } from './events';

const DAY = 24 * 3600_000;
const T0 = Date.parse('2026-10-23T16:30:00Z');

const sig = (code: ClosureSignal['code'], reliability: ClosureSignal['reliability'], extra: Partial<ClosureSignal> = {}): ClosureSignal => ({
  code,
  reliability,
  source: 'osm',
  detail: code,
  observedAt: new Date(T0).toISOString(),
  ...extra,
});
const det = (placeId: string, name: string, signals: ClosureSignal[] = [sig('lifecycle_prefix', 'high', { data: { key: 'disused:amenity', value: 'restaurant' } })]): Detection => ({ placeId, name, signals });

describe('closed-place news (What’s new)', () => {
  it('one entry per newly flagged place, none while it stays flagged, a new one after "Still open"', () => {
    const log = new ClosureEventLog(new MemoryStateStore());
    let calls = 0;
    const off = onClosureEvents(() => calls++);
    const first = log.recordChecks([det('osm:node/1', 'Chez Paulette'), det('osm:node/2', 'Le Zinc')], {}, T0);
    expect(first.map((e) => [e.kind, e.placeId, e.name, e.at, e.owner])).toEqual([
      ['closure', 'osm:node/1', 'Chez Paulette', T0, OWN_ENTRY_OWNER],
      ['closure', 'osm:node/2', 'Le Zinc', T0, OWN_ENTRY_OWNER],
    ]);
    expect(first[0]!.signal?.code).toBe('lifecycle_prefix');
    expect(calls).toBe(1);

    // The next monthly check still flags them: nothing new.
    expect(log.recordChecks([det('osm:node/1', 'Chez Paulette'), det('osm:node/2', 'Le Zinc')], {}, T0 + 31 * DAY)).toEqual([]);
    expect(calls).toBe(1);
    // "Confirm closed" (never checked again anyway), or an answer older than the flag: still nothing.
    const closed = { 'osm:node/1': { decision: 'closed' as const, decidedAt: new Date(T0 + DAY).toISOString() } };
    expect(log.recordChecks([det('osm:node/1', 'Chez Paulette')], closed, T0 + 40 * DAY)).toEqual([]);
    const old = { 'osm:node/2': { decision: 'still_open' as const, decidedAt: new Date(T0 - DAY).toISOString() } };
    expect(log.recordChecks([det('osm:node/2', 'Le Zinc')], old, T0 + 40 * DAY)).toEqual([]);
    // "Still open", then flagged again later: a new entry, dated then.
    const open = { 'osm:node/2': { decision: 'still_open' as const, decidedAt: new Date(T0 + 2 * DAY).toISOString() } };
    const again = log.recordChecks([det('osm:node/2', 'Le Zinc')], open, T0 + 60 * DAY);
    expect(again.map((e) => [e.placeId, e.at])).toEqual([['osm:node/2', T0 + 60 * DAY]]);
    // ...and not a third time for the same answer.
    expect(log.recordChecks([det('osm:node/2', 'Le Zinc')], open, T0 + 90 * DAY)).toEqual([]);
    expect(log.entries().map((e) => e.placeId)).toEqual(['osm:node/2', 'osm:node/2', 'osm:node/1']);
    expect(calls).toBe(2);
    off();

    // No signal, or the same place twice in one batch: one entry at most.
    expect(log.recordChecks([det('osm:node/3', 'X', []), det('osm:node/4', 'Y'), det('osm:node/4', 'Y')], {}, T0).map((e) => e.placeId)).toEqual(['osm:node/4']);
  });

  it('an import: one grouped entry, or the place itself when there is one; flagged places are not repeated', () => {
    const log = new ClosureEventLog(new MemoryStateStore());
    log.recordChecks([det('osm:node/1', 'Chez Paulette')], {}, T0);
    const nearby = [sig('not_found_nearby', 'low', { data: { category: 'Restaurant' } })];
    const grouped = log.recordImport([det('osm:node/1', 'Chez Paulette'), det('local:a', 'Crêperie', nearby), det('local:b', 'Bistrot', nearby)], {}, T0 + DAY)!;
    expect(grouped).toMatchObject({ kind: 'closureImport', count: 2, placeIds: ['local:a', 'local:b'], at: T0 + DAY });
    expect(placesOf([grouped])).toEqual(['local:a', 'local:b']);
    const single = log.recordImport([det('local:a', 'Crêperie', nearby), det('local:c', 'Le Comptoir', nearby)], {}, T0 + 2 * DAY)!;
    expect(single).toMatchObject({ kind: 'closure', placeId: 'local:c', name: 'Le Comptoir' });
    expect(single.signal?.code).toBe('not_found_nearby');
    expect(log.recordImport([det('local:a', 'Crêperie', nearby)], {}, T0 + 3 * DAY)).toBeNull();
  });

  it('keeps the newest entries only', () => {
    const log = new ClosureEventLog(new MemoryStateStore());
    for (let i = 0; i < MAX_CLOSURE_ENTRIES + 20; i++) log.recordChecks([det(`osm:node/${i}`, `P${i}`)], {}, T0 + i);
    const all = log.entries();
    expect(all).toHaveLength(MAX_CLOSURE_ENTRIES);
    expect(all[0]!.placeId).toBe(`osm:node/${MAX_CLOSURE_ENTRIES + 19}`);
  });

  it('the reason is the most reliable signal, then the oldest', () => {
    const a = sig('opening_hours_removed', 'medium', { since: '2026-01-01T00:00:00Z' });
    const b = sig('deleted', 'high', { since: '2026-05-01T00:00:00Z' });
    const c = sig('lifecycle_tag', 'high', { since: '2026-03-01T00:00:00Z' });
    expect(mainSignal([a, b, c])).toBe(c);
    expect(mainSignal([])).toBeUndefined();
    expect(isNewFlag(undefined, undefined)).toBe(true);
    expect(isNewFlag(T0, { decision: 'still_open', decidedAt: 'nope' })).toBe(false);
  });

  it('What’s new lists them with friends’ news: newest first, unseen, the "Closed?" type, not a friend', () => {
    const kv = new MemoryStateStore();
    const wn = new WhatsNewLog(kv);
    wn.record(
      [{ owner: 'lea', status: 'updated', whatsNew: { added: ['p1'], changed: [], removed: [] }, downloaded: { packs: 0, bytes: 0 } } as never],
      { now: T0, firstRead: new Set(), placeName: () => 'Le Zinc', theirSave: () => undefined },
    );
    wn.markVisited(T0 + 1);
    wn.closures.recordChecks([det('osm:node/1', 'Chez Paulette')], {}, T0 + DAY);
    expect(wn.entries().map((e) => e.kind)).toEqual(['closure', 'added']);
    expect(wn.unseen()).toBe(1);
    expect(wn.friendEntries().map((e) => e.kind)).toEqual(['added']);
    expect(filterEntries(wn.entries(), { type: 'closures', owner: null }).map((e) => e.placeId)).toEqual(['osm:node/1']);
    expect(filterEntries(wn.entries(), { type: 'places', owner: null }).map((e) => e.kind)).toEqual(['added']);
    expect(filterEntries(wn.entries(), { type: 'all', owner: 'lea' }).map((e) => e.kind)).toEqual(['added']);
    // Friends' news recorded later do not swallow mine; forgetting a friend leaves mine.
    wn.record(
      [{ owner: 'lea', status: 'updated', whatsNew: { added: ['p2'], changed: [], removed: [] }, downloaded: { packs: 0, bytes: 0 } } as never],
      { now: T0 + 2 * DAY, firstRead: new Set(), placeName: () => 'Bistrot', theirSave: () => undefined },
    );
    wn.forget('lea');
    expect(wn.entries().map((e) => e.kind)).toEqual(['closure']);
    // Junk in the store is skipped.
    kv.set('app:whatsnew:closures', [null, { kind: 'added', at: 1 }, 'x']);
    expect(wn.closures.entries()).toEqual([]);
  });

  it('wording (French and English)', () => {
    expect(translate('fr', fr, en, 'wn.closure', { place: 'Chez Paulette' })).toBe('« Chez Paulette » n’existe peut-être plus d’après OpenStreetMap');
    expect(translate('en', en, en, 'wn.closure', { place: 'Chez Paulette' })).toBe('“Chez Paulette” may no longer exist according to OpenStreetMap');
    expect(translate('fr', fr, en, 'wn.closureImport', { count: 3 })).toBe('3 lieux importés n’existent peut-être plus d’après OpenStreetMap');
    expect(translate('en', en, en, 'wn.type.closures')).toBe('Closed?');
  });
});
