// SPDX-License-Identifier: MPL-2.0
import { DecryptionError, RollbackError, StorageMovedError, UnsupportedVersionError, emptyVault, generateRecoveryPhrase, identityFromPhrase } from '@triangulair/crypto';
import { NodeSqliteDriver } from '@triangulair/data/node';
import { AuthError, NetworkError, PreconditionFailed, ProtocolError } from '@triangulair/storage';
import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ContactBook, mergeBooks } from '../src/contacts.ts';
import { DeviceRevokedError, NeedsKeyError, PayloadError, classifyError } from '../src/errors.ts';
import { parsePlaces, placesCollection, zOrder, type PlaceFeature } from '../src/features.ts';
import { decodePayload, encodePayload, utf8 } from '../src/payload.ts';
import { planPacks, type DesiredItem, type ExistingPack } from '../src/planner.ts';
import { SyncScheduler, type Timers } from '../src/scheduler.ts';
import { MemoryStateStore, SqliteStateStore } from '../src/state.ts';
import type { SyncReport } from '../src/engine.ts';

let n = 0;
const newId = () => `id${n++}`;
const items = (count: number, fp = 'A', from = 0): Map<string, DesiredItem> =>
  new Map(Array.from({ length: count }, (_, i) => [`p${from + i}`, { id: `p${from + i}`, fp, hash: 'h', sortKey: from + i }]));
const asExisting = (plan: ReturnType<typeof planPacks>, desired: Map<string, DesiredItem>): ExistingPack[] => [
  ...plan.keep,
  ...plan.write.map((w) => ({ id: w.id, fp: w.fp, file: `f-${w.id}-${Math.random()}`, items: Object.fromEntries(w.itemIds.map((i) => [i, desired.get(i)!.hash])) })),
];

describe('planner', () => {
  it('groups by recipient set and cuts packs at capacity, in geographic order', () => {
    const d = new Map([...items(250, 'A'), ...items(30, 'B', 1000)]);
    const p = planPacks([], d, { capacity: 100, newId });
    expect(p.write.map((w) => [w.fp, w.itemIds.length])).toEqual([['A', 100], ['A', 100], ['A', 50], ['B', 30]]);
    expect(p.write[0]!.itemIds).toContain('p0');
    expect(p.drop).toEqual([]);
  });

  it('rewrites only what changed, blurs a single replacement, and puts new items in the least filled pack', () => {
    const d = items(300);
    const first = planPacks([], d, { capacity: 100, newId });
    const existing = asExisting(first, d);
    // Nothing changed.
    expect(planPacks(existing, d, { capacity: 100, newId }).write).toEqual([]);
    // One item changed: its pack plus one blurred pack.
    const d2 = new Map(d);
    d2.set('p150', { ...d.get('p150')!, hash: 'h2' });
    const p2 = planPacks(existing, d2, { capacity: 100, newId, random: () => 0 });
    expect(p2.write.length).toBe(2);
    expect(p2.write.some((w) => w.itemIds.includes('p150'))).toBe(true);
    expect(p2.drop.length).toBe(2);
    expect(planPacks(existing, d2, { capacity: 100, newId, blur: false }).write.length).toBe(1);
    // A new item goes into one existing pack (not a new one).
    const d3 = new Map([...d, ...items(1, 'A', 5000)]);
    const p3 = planPacks(existing, d3, { capacity: 101, newId, blur: false });
    expect(p3.write.length).toBe(1);
    expect(p3.write[0]!.replaces).toBeDefined();
  });

  it('moves an item whose recipients changed, drops emptied packs, and merges small packs', () => {
    const d = items(10);
    const existing = asExisting(planPacks([], d, { capacity: 4, newId }), d); // 4 + 4 + 2
    const d2 = new Map(d);
    for (const id of ['p0', 'p1', 'p2', 'p3']) d2.set(id, { ...d.get(id)!, fp: 'B' });
    const p = planPacks(existing, d2, { capacity: 4, newId, blur: false });
    const byFp = p.write.reduce<Record<string, number>>((m, w) => ((m[w.fp] = (m[w.fp] ?? 0) + w.itemIds.length), m), {});
    expect(byFp['B']).toBe(4);
    expect(p.keep.length + p.write.filter((w) => w.fp === 'A').length).toBeGreaterThan(0);
    // Small packs: 4 packs of 1 item each in one group are merged.
    const smalls: ExistingPack[] = ['a', 'b', 'c', 'd'].map((x, i) => ({ id: x, fp: 'A', file: `f${x}`, items: { [`p${i}`]: 'h' } }));
    const m = planPacks(smalls, items(4), { capacity: 100, newId });
    expect(m.write.length).toBe(1);
    expect(m.write[0]!.itemIds).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(m.drop.sort()).toEqual(['fa', 'fb', 'fc', 'fd']);
  });

  it('a pack with an unknown recipient set is rewritten', () => {
    const d = items(3);
    const p = planPacks([{ id: 'x', fp: null, file: 'fx', items: { p0: 'h', p1: 'h', p2: 'h' } }], d, { capacity: 10, newId });
    expect(p.drop).toEqual(['fx']);
    expect(p.write[0]!.itemIds.length).toBe(3);
  });
});

describe('payload', () => {
  it('round-trips, compresses when it helps, and refuses what it does not know', () => {
    const body = utf8('x'.repeat(10_000));
    const e = encodePayload('places', body);
    expect(e.length).toBeLessThan(200);
    expect(decodePayload(e)).toEqual({ kind: 'places', body });
    const tiny = encodePayload('manifest', utf8('{}'));
    expect(tiny[6]).toBe(0);
    const bad = e.slice();
    bad[4] = 2;
    expect(() => decodePayload(bad)).toThrow(PayloadError);
    expect(() => decodePayload(utf8('nope'))).toThrow(PayloadError);
  });

  it('stops decompression bombs at the limit', () => {
    const bomb = deflateSync(new Uint8Array(50 * 1024 * 1024));
    const env = new Uint8Array(7 + bomb.length);
    env.set([0x54, 0x4c, 0x53, 0x59, 1, 1, 1]);
    env.set(bomb, 7);
    expect(bomb.length).toBeLessThan(100_000);
    expect(() => decodePayload(env, { maxBytes: 1024 * 1024 })).toThrow(/limit/);
  });

  it('places: strict parsing (duplicate keys, unknown fields, bad ids, versions)', () => {
    const f: PlaceFeature = {
      type: 'Feature',
      id: 'osm:node/1',
      geometry: { type: 'Point', coordinates: [2.35, 48.85] },
      properties: { name: 'A', created: '2026-10-13T15:10:00.000Z', updated: '2026-10-13T15:10:00.000Z' },
    };
    expect(parsePlaces(placesCollection([f]))[0]!.feature).toEqual(f);
    const text = new TextDecoder().decode(placesCollection([f]));
    expect(() => parsePlaces(utf8(text.replace('"name":"A"', '"name":"A","name":"B"')))).toThrow(/written form/);
    expect(() => parsePlaces(utf8(text.replace('"name":"A"', '"name":"A","evil":1')))).toThrow(/unknown property/);
    // A higher minor: unknown fields are ignored.
    expect(parsePlaces(utf8(text.replace('"version":1}', '"version":1,"minor":3}').replace('"name":"A"', '"name":"A","future":1'))).length).toBe(1);
    expect(() => parsePlaces(utf8(text.replace('"version":1}', '"version":2}')))).toThrow(expect.objectContaining({ unsupported: true }));
    expect(() => parsePlaces(utf8(text.replace('osm:node/1', '../../etc')))).toThrow(/place id/);
    expect(() => parsePlaces(utf8(text.replace('[2.35,48.85]', '[2.35,"x"]')))).toThrow(PayloadError);
    expect(() => parsePlaces(utf8(text.replace(' ', '')).slice(0, 10))).toThrow(PayloadError);
  });

  it('Z-order keeps neighbours together', () => {
    expect(Math.abs(zOrder(48.85, 2.35) - zOrder(48.851, 2.351))).toBeLessThan(Math.abs(zOrder(48.85, 2.35) - zOrder(43.3, 5.4)));
  });
});

describe('contacts in the vault', () => {
  it('policies merge per contact, latest wins, removal is not undone by a merge', () => {
    const owner = identityFromPhrase(generateRecoveryPhrase()).owner;
    const a = new ContactBook(emptyVault(owner));
    const b = new ContactBook(emptyVault(owner));
    a.setPolicy('ed25519:x', { share: true, follow: true }, 1000);
    b.setPolicy('ed25519:y', { share: false, follow: true }, 1000);
    b.setPolicy('ed25519:x', { share: { lists: ['l1'] } }, 2000);
    const m1 = new ContactBook(mergeBooks(a.records, b.records));
    const m2 = new ContactBook(mergeBooks(b.records, a.records));
    expect(m1.policy('ed25519:x').share).toEqual({ lists: ['l1'] });
    expect(m1.policy('ed25519:y').follow).toBe(true);
    expect(JSON.stringify(m1.records.app)).toBe(JSON.stringify(m2.records.app));
    a.remove('ed25519:x', 3000);
    expect(new ContactBook(mergeBooks(b.records, a.records)).policy('ed25519:x').removed).toBe(true);
  });
});

describe('state stores', () => {
  for (const [name, make] of [
    ['memory', () => new MemoryStateStore()],
    ['sqlite', () => new SqliteStateStore(new NodeSqliteDriver(':memory:'))],
  ] as const) {
    it(name, () => {
      const s = make();
      expect(s.get('a')).toBeUndefined();
      s.set('a:1', { x: [1, 'y'] });
      s.setBytes('a:2', new Uint8Array([1, 2, 3]));
      s.set('b', 1);
      expect(s.get('a:1')).toEqual({ x: [1, 'y'] });
      expect([...s.getBytes('a:2')!]).toEqual([1, 2, 3]);
      expect(s.keys('a:')).toEqual(['a:1', 'a:2']);
      s.delete('a:1');
      expect(s.keys('a:')).toEqual(['a:2']);
    });
  }
});

describe('error cases (spec table)', () => {
  it('maps errors to the rows of the table', () => {
    const k = (e: unknown, about: 'own' | 'friend' = 'own', online = true) => classifyError(e, about, online);
    expect(k(new NetworkError('x'), 'own', false)).toMatchObject({ kind: 'offline', situation: 'No network', retryable: true });
    expect(k(new NetworkError('x'))).toMatchObject({ kind: 'unreachable', situation: 'My storage unreachable', retryable: true });
    expect(k(new NetworkError('x'), 'friend')).toMatchObject({ situation: 'A friend\'s storage unreachable' });
    expect(k(new AuthError('x'))).toMatchObject({ kind: 'auth', situation: 'Credentials rejected', blocksWrites: true, message: 'Reconnect your storage' });
    expect(k(new ProtocolError('x', { status: 507 }))).toMatchObject({ kind: 'quota', situation: 'Quota full' });
    expect(k(new PreconditionFailed('index.json'))).toMatchObject({ kind: 'conflict', situation: 'Two of my devices write at the same time' });
    expect(k(new StorageMovedError('https://new.example/'), 'friend')).toMatchObject({ kind: 'moved', situation: 'A friend changes storage' });
    expect(k(new DecryptionError('x'), 'friend')).toMatchObject({ kind: 'tampered', situation: 'Tampered content (invalid signature)' });
    expect(k(new RollbackError('x'), 'friend')).toMatchObject({ kind: 'rollback' });
    expect(k(new UnsupportedVersionError('x' as never, 5 as never, [4] as never), 'friend')).toMatchObject({ kind: 'unsupported', message: 'Update the app to see {name}\'s places' });
    expect(k(new PayloadError('x', true), 'friend')).toMatchObject({ kind: 'unsupported' });
    expect(k(new NeedsKeyError(2))).toMatchObject({ kind: 'needs-key', situation: 'Key missing from the phone\'s vault', blocksWrites: true });
    expect(k(new DeviceRevokedError())).toMatchObject({ kind: 'device-revoked', blocksWrites: true });
  });
});

describe('scheduler', () => {
  function fakeTimers() {
    let t = 0;
    const q: { at: number; fn: () => void; id: number }[] = [];
    let id = 0;
    const timers: Timers = {
      setTimeout: (fn, ms) => (q.push({ at: t + ms, fn, id: ++id }), id),
      clearTimeout: (h) => {
        const i = q.findIndex((x) => x.id === h);
        if (i >= 0) q.splice(i, 1);
      },
      now: () => t,
    };
    const advance = async (ms: number) => {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const next = q[0];
        if (!next || next.at > end) break;
        q.shift();
        t = next.at;
        next.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
      t = end;
    };
    return { timers, advance, pending: () => q.length };
  }
  const ok = (): SyncReport => ({ own: null, friends: [], problems: [], ok: true, startedAt: 0, durationMs: 0 });

  it('syncs on launch, regularly while in use, debounces changes, finishes on close, then nothing', async () => {
    const ft = fakeTimers();
    const runs: string[] = [];
    const s = new SyncScheduler({ run: async (r) => (runs.push(r), ok()), timers: ft.timers, intervalMs: 60_000, debounceMs: 3000 });
    await s.appForeground('launch');
    expect(runs).toEqual(['launch']);
    await ft.advance(60_000);
    expect(runs).toEqual(['launch', 'interval']);
    s.localChange();
    s.localChange();
    expect(s.getStatus().pending).toBe(2);
    await ft.advance(2000);
    s.localChange();
    await ft.advance(3000);
    expect(runs.filter((r) => r === 'change').length).toBe(1);
    expect(s.getStatus().pending).toBe(0);
    s.localChange();
    await s.appBackground();
    expect(runs.at(-1)).toBe('background');
    expect(ft.pending()).toBe(0); // no periodic task after closing
    await ft.advance(24 * 3600_000);
    expect(runs.at(-1)).toBe('background');
  });

  it('offline: changes wait, a pass runs when the network is back', async () => {
    const ft = fakeTimers();
    const runs: string[] = [];
    const s = new SyncScheduler({ run: async (r) => (runs.push(r), ok()), timers: ft.timers });
    await s.appForeground('launch');
    s.setOnline(false);
    s.localChange();
    s.localChange();
    await ft.advance(10_000);
    expect(s.getStatus()).toMatchObject({ state: 'offline', pending: 2 });
    expect(runs).toEqual(['launch']);
    s.setOnline(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toEqual(['launch', 'online']);
    expect(s.getStatus().pending).toBe(0);
  });

  it('retries transient failures with backoff, shows the banner after 24 h, stops on blocking problems', async () => {
    const ft = fakeTimers();
    let fail: 'network' | 'auth' | null = 'network';
    const runs: number[] = [];
    const s = new SyncScheduler({
      timers: ft.timers,
      backoffMs: [1000, 3_600_000],
      run: async () => {
        runs.push(ft.timers.now());
        if (!fail) return ok();
        const problem = classifyError(fail === 'network' ? new NetworkError('down') : new AuthError('401'), 'own');
        return { ...ok(), ok: false, problems: [{ about: 'own', problem }] };
      },
    });
    await s.appForeground('launch');
    await ft.advance(1000);
    expect(runs).toEqual([0, 1000]);
    await ft.advance(25 * 3_600_000);
    expect(s.getStatus().banner).toBe(true);
    fail = 'auth';
    await ft.advance(3_600_000);
    expect(s.getStatus()).toMatchObject({ state: 'blocked' });
    const count = runs.length;
    s.localChange();
    await ft.advance(10 * 3_600_000);
    expect(runs.length).toBe(count); // writes stop until the user reconnects
    fail = null;
    await s.resume();
    expect(s.getStatus()).toMatchObject({ state: 'idle', banner: false, problem: null });
  });
});
