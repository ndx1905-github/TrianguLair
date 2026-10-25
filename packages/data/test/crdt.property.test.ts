/**
 * Property-based tests of merging (spec "Testing strategy": randomly generated
 * data for merging and deduplication).
 *
 * Several devices of the same person apply random edits and merge in a random
 * order. Properties:
 * 1. After a full exchange every device holds the same document and the same
 *    SQLite projection, which also equals a fresh full projection.
 * 2. At every step, on every device, no list contains a private save (nor a
 *    trashed one), whatever the edits and merges.
 */
import * as A from '@automerge/automerge';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '../src/driver/node.ts';
import { DataStore } from '../src/store.ts';
import type { ListFilter, SaveStatus, Sharing } from '../src/types.ts';
import { fakeClock, hexActor, ME, osmPoint, seqIds } from './helpers.ts';

const PLACES = Array.from({ length: 6 }, (_, i) => osmPoint(i + 1, `Place ${i + 1}`, 45 + i / 100, 4 + i / 100, i % 2 ? 'amenity=bar' : 'amenity=restaurant'));
const placeId = (i: number) => `osm:node/${(i % PLACES.length) + 1}`;
const DAY = 24 * 3600 * 1000;

type Op =
  | { k: 'put'; dev: number; place: number; sharing: Sharing; status: SaveStatus | null; tag: number }
  | { k: 'comment'; dev: number; place: number; text: string }
  | { k: 'sharing'; dev: number; place: number; sharing: Sharing }
  | { k: 'status'; dev: number; place: number; status: SaveStatus | null }
  | { k: 'addTag' | 'removeTag'; dev: number; place: number; tag: number }
  | { k: 'delete' | 'restore'; dev: number; place: number }
  | { k: 'createTag'; dev: number; parent: number }
  | { k: 'reparent'; dev: number; tag: number; parent: number }
  | { k: 'deleteTag' | 'restoreTag'; dev: number; tag: number }
  | { k: 'createList'; dev: number; manual: boolean; tags: number[]; statuses: SaveStatus[]; place: number }
  | { k: 'listAdd' | 'listRemove'; dev: number; list: number; place: number }
  | { k: 'deleteList'; dev: number; list: number }
  | { k: 'purge'; dev: number }
  | { k: 'merge'; dev: number; from: number };

const status = fc.constantFrom<SaveStatus | null>(null, 'to_try', 'tried', 'favorite');
const sharing = fc.constantFrom<Sharing>('friends', 'private');

function opArb(devices: number): fc.Arbitrary<Op> {
  const dev = fc.integer({ min: 0, max: devices - 1 });
  const place = fc.integer({ min: 0, max: 5 });
  const n = fc.integer({ min: 0, max: 7 });
  return fc.oneof(
    { weight: 4, arbitrary: fc.record({ k: fc.constant('put' as const), dev, place, sharing, status, tag: n }) },
    { weight: 2, arbitrary: fc.record({ k: fc.constant('comment' as const), dev, place, text: fc.constantFrom('', 'good', 'very good', 'good, terrace', 'closed mondays') }) },
    { weight: 3, arbitrary: fc.record({ k: fc.constant('sharing' as const), dev, place, sharing }) },
    { weight: 1, arbitrary: fc.record({ k: fc.constant('status' as const), dev, place, status }) },
    { weight: 2, arbitrary: fc.record({ k: fc.constantFrom('addTag' as const, 'removeTag' as const), dev, place, tag: n }) },
    { weight: 2, arbitrary: fc.record({ k: fc.constantFrom('delete' as const, 'restore' as const), dev, place }) },
    { weight: 2, arbitrary: fc.record({ k: fc.constant('createTag' as const), dev, parent: n }) },
    { weight: 1, arbitrary: fc.record({ k: fc.constant('reparent' as const), dev, tag: n, parent: n }) },
    { weight: 1, arbitrary: fc.record({ k: fc.constantFrom('deleteTag' as const, 'restoreTag' as const), dev, tag: n }) },
    {
      weight: 2,
      arbitrary: fc.record({
        k: fc.constant('createList' as const),
        dev,
        manual: fc.boolean(),
        // Often unconstrained, so lists hold many saves and stale items would show.
        tags: fc.oneof(fc.constant<number[]>([]), fc.array(n, { maxLength: 2 })),
        statuses: fc.oneof(fc.constant<SaveStatus[]>([]), fc.subarray<SaveStatus>(['to_try', 'tried', 'favorite'])),
        place,
      }),
    },
    { weight: 2, arbitrary: fc.record({ k: fc.constantFrom('listAdd' as const, 'listRemove' as const), dev, list: n, place }) },
    { weight: 1, arbitrary: fc.record({ k: fc.constant('deleteList' as const), dev, list: n }) },
    { weight: 1, arbitrary: fc.record({ k: fc.constant('purge' as const), dev }) },
    { weight: 4, arbitrary: fc.record({ k: fc.constant('merge' as const), dev, from: dev }) },
  );
}

interface Device {
  store: DataStore;
  clock: ReturnType<typeof fakeClock>;
}

function makeDevices(count: number): Device[] {
  return Array.from({ length: count }, (_, i) => {
    const clock = fakeClock(1_760_000_000_000 + i * 7);
    const store = DataStore.open({
      driver: new NodeSqliteDriver(':memory:'),
      meId: ME,
      actor: hexActor(i + 1),
      now: clock.now,
      newId: seqIds(`d${i}-`),
      compactEvery: 1000,
    });
    return { store, clock };
  });
}

const pick = <T>(xs: readonly T[], i: number): T | undefined => (xs.length ? xs[i % xs.length] : undefined);

function apply(devices: Device[], op: Op): void {
  const { store: s, clock } = devices[op.dev]!;
  const doc = s.doc;
  const tags = Object.keys(doc.tags).sort();
  const lists = Object.keys(doc.lists).sort();
  const has = (p: number) => !!doc.saves[placeId(p)];
  switch (op.k) {
    case 'put': {
      const tag = pick(tags, op.tag);
      s.putSave({ place: PLACES[op.place]!, sharing: op.sharing, status: op.status, ...(tag && { tagIds: [tag] }) });
      return;
    }
    case 'comment':
      if (has(op.place)) s.updateSave(placeId(op.place), { comment: op.text });
      return;
    case 'sharing':
      if (has(op.place)) s.updateSave(placeId(op.place), { sharing: op.sharing });
      return;
    case 'status':
      if (has(op.place)) s.updateSave(placeId(op.place), { status: op.status });
      return;
    case 'addTag':
    case 'removeTag': {
      const tag = pick(tags, op.tag);
      if (!tag || !has(op.place)) return;
      if (op.k === 'addTag') s.addSaveTag(placeId(op.place), tag);
      else s.removeSaveTag(placeId(op.place), tag);
      return;
    }
    case 'delete':
      if (has(op.place)) s.deleteSave(placeId(op.place));
      return;
    case 'restore':
      if (has(op.place)) s.restoreSave(placeId(op.place));
      return;
    case 'createTag':
      s.createTag({ name: `tag ${tags.length}`, parentId: op.parent % 3 === 0 ? null : (pick(tags, op.parent) ?? null) });
      return;
    case 'reparent': {
      const tag = pick(tags, op.tag);
      const parent = pick(tags, op.parent);
      if (!tag || !parent) return;
      try {
        s.updateTag(tag, { parentId: parent });
      } catch {
        // local cycle refused
      }
      return;
    }
    case 'deleteTag':
    case 'restoreTag': {
      const tag = pick(tags, op.tag);
      if (!tag) return;
      if (op.k === 'deleteTag') s.deleteTag(tag);
      else s.restoreTag(tag);
      return;
    }
    case 'createList': {
      const filter: ListFilter = {
        tags: op.tags.map((t) => pick(tags, t)).filter((t): t is string => !!t),
        statuses: op.statuses,
        include: [placeId(op.place)],
      };
      s.createList(op.manual ? { name: 'm', kind: 'manual', items: [placeId(op.place)] } : { name: 'f', kind: 'filter', filter });
      return;
    }
    case 'listAdd':
    case 'listRemove': {
      const list = pick(lists, op.list);
      if (!list) return;
      if (op.k === 'listAdd') s.addToList(list, placeId(op.place));
      else s.removeFromList(list, placeId(op.place));
      return;
    }
    case 'deleteList': {
      const list = pick(lists, op.list);
      if (list) s.deleteList(list);
      return;
    }
    case 'purge':
      clock.set(clock.now() + 31 * DAY);
      s.purgeTrash();
      return;
    case 'merge':
      if (op.from !== op.dev) s.merge(devices[op.from]!.store.doc);
      return;
  }
}

function assertNoPrivateInLists(s: DataStore): void {
  for (const l of s.repo.lists()) {
    for (const id of s.repo.listItems(l.id)) {
      const save = s.repo.getSave(id)!;
      expect(save.sharing).toBe('friends');
      expect(save.deletedAt).toBeNull();
    }
  }
}

function fullSync(devices: Device[]): void {
  for (let round = 0; round < 4; round++) {
    for (const x of devices) for (const y of devices) if (x !== y) x.store.merge(y.store.doc);
  }
}

describe('merging across devices (property-based)', () => {
  it('devices converge to the same document and projection, equal to a fresh projection', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 3 }).chain((n) => fc.tuple(fc.constant(n), fc.array(opArb(n), { minLength: 1, maxLength: 40 }))), ([n, ops]) => {
        const devices = makeDevices(n);
        for (const op of ops) apply(devices, op);
        fullSync(devices);
        const [first, ...rest] = devices.map((d) => d.store);
        const heads = A.getHeads(first!.doc).sort();
        const dump = first!.repo.dumpOwnData();
        for (const s of rest) {
          expect(A.getHeads(s.doc).sort()).toEqual(heads);
          expect(s.repo.dumpOwnData()).toBe(dump);
        }
        // Incremental projection == full projection from scratch.
        const fresh = DataStore.open({ driver: new NodeSqliteDriver(':memory:'), meId: ME });
        fresh.merge(first!.doc);
        expect(fresh.repo.dumpOwnData()).toBe(dump);
        for (const s of devices.map((d) => d.store)) assertNoPrivateInLists(s);
        for (const s of [...devices.map((d) => d.store), fresh]) s.close();
      }),
      { numRuns: 250 },
    );
  });

  it('a private save never enters a list, at any step on any device', () => {
    fc.assert(
      fc.property(fc.array(opArb(2), { minLength: 1, maxLength: 50 }), (ops) => {
        const devices = makeDevices(2);
        for (const op of ops) {
          apply(devices, op);
          assertNoPrivateInLists(devices[op.dev]!.store);
        }
        fullSync(devices);
        for (const d of devices) assertNoPrivateInLists(d.store);
        for (const d of devices) d.store.close();
      }),
      { numRuns: 250 },
    );
  });
});
