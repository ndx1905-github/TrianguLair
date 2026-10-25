import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateListPure, normalizeFilter, type FilterSubject } from '../src/filter.ts';
import { saveIdFor } from '../src/ids.ts';
import type { Repository } from '../src/sqlite/repository.ts';
import type { ListFilter, ListRecord, PlaceStatus, PriceLevel, SaveStatus, Sharing } from '../src/types.ts';
import { FRIEND, ME, osmPoint, rect } from './helpers.ts';
import { ALL_MODES, openRepo, tagRec, writeMySave } from './fixtures.ts';

function list(id: string, filter: ListFilter, extra: Partial<ListRecord> = {}): ListRecord {
  return {
    id,
    ownerId: ME,
    name: id,
    description: '',
    visibility: 'link',
    linkKey: null,
    kind: 'filter',
    filter,
    manualItems: [],
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...extra,
  };
}

function subjects(repo: Repository): FilterSubject[] {
  return repo.db
    .all<{ id: string }>(`SELECT id FROM saves ORDER BY id`)
    .map(({ id }) => {
      const save = repo.getSave(id)!;
      return { save, place: repo.getPlace(save.placeId)! };
    });
}

const P = (n: number) => `osm:node/${n}`;
const S = (n: number) => saveIdFor(ME, P(n));

describe.each(ALL_MODES)('list filters ($name)', ({ disable }) => {
  function seed() {
    const repo = openRepo(disable);
    repo.writeOwnTags([
      tagRec('food', 'Food'),
      tagRec('pizza', 'Pizza', 'food'),
      tagRec('neapolitan', 'Neapolitan', 'pizza'),
      tagRec('bar', 'Bar'),
    ]);
    writeMySave(repo, osmPoint(1, 'Napoli', 45.76, 4.83), { tagIds: ['neapolitan'], status: 'favorite', priceLevel: 2 });
    writeMySave(repo, osmPoint(2, 'Pizza Lyon', 45.75, 4.85), { tagIds: ['pizza'], status: 'to_try' });
    writeMySave(repo, osmPoint(3, 'Secret pizza', 45.75, 4.84), { tagIds: ['pizza'], sharing: 'private' });
    writeMySave(repo, osmPoint(4, 'Bar Lisboa', 38.72, -9.14, 'amenity=bar'), { tagIds: ['bar'], status: 'tried' });
    writeMySave(repo, osmPoint(5, 'Old pizza', 45.74, 4.84), { tagIds: ['pizza'], deletedAt: 5 });
    writeMySave(repo, osmPoint(6, 'Closed pizza', 45.745, 4.845), { tagIds: ['pizza'] });
    repo.updatePlaceOsmData(P(6), { status: 'closed' });
    repo.upsertForeignSave({
      id: 'friend-save', ownerId: FRIEND,
      place: { id: P(7), osmType: 'node', osmId: 7, name: 'Friend pizza', category: 'amenity=restaurant', kind: 'place', edge: 'sharp', geometry: { type: 'Point', coordinates: [4.84, 45.75] } },
      createdAt: 1, updatedAt: 1,
    });
    return repo;
  }

  const lyon = rect(4.7, 45.7, 4.95, 45.8);
  const portugal = { kind: 'osm' as const, osmType: 'relation' as const, osmId: 295480, name: 'Portugal', geometry: rect(-9.6, 36.9, -6.1, 42.2) };

  const cases: [string, ListFilter, Partial<ListRecord>, number[]][] = [
    ['a tag matches its sub-tags; private, trashed, friends never', { tags: ['food'] }, {}, [1, 2, 6]],
    ['sub-tag only', { tags: ['neapolitan'] }, {}, [1]],
    ['public list drops closed places', { tags: ['food'] }, { visibility: 'public' }, [1, 2]],
    ['statuses OR inside the group, AND across groups', { tags: ['pizza'], statuses: ['favorite', 'to_try'] }, {}, [1, 2]],
    ['price levels', { priceLevels: [2] }, {}, [1]],
    ['categories', { categories: ['amenity=bar'] }, {}, [4]],
    ['zones by name and drawn (Lyon + Portugal)', { zones: [{ kind: 'drawn', geometry: lyon }, portugal] }, {}, [1, 2, 4, 6]],
    ['zone AND tag', { zones: [portugal], tags: ['pizza'] }, {}, []],
    ['exceptions: include bypasses criteria, exclude wins', { tags: ['bar'], include: [P(1), P(2), P(3)], exclude: [P(2)] }, {}, [1, 4]],
    ['empty filter = all my shareable places', {}, {}, [1, 2, 4, 6]],
    ['a filter naming only deleted tags matches nothing', { tags: ['gone'] }, {}, []],
    ['manual list ignores criteria, never private/trashed', {}, { kind: 'manual', manualItems: [P(3), P(4), P(5), P(7)] }, [4]],
  ];

  it.each(cases)('%s', (_name, filter, extra, expected) => {
    const repo = seed();
    const def = list('l', filter, extra);
    const want = expected.map(S).sort();
    expect(repo.evaluateList(def)).toEqual(want);
    expect(evaluateListPure(def, subjects(repo), repo.filterContext())).toEqual(want);
    repo.writeOwnList(def);
    expect(repo.listItems('l')).toEqual(want);
  });

  it('materialized items are recomputed after changes', () => {
    const repo = seed();
    repo.writeOwnList(list('l', { tags: ['pizza'] }));
    expect(repo.listItems('l')).toEqual([1, 2, 6].map(S).sort());
    writeMySave(repo, osmPoint(2, 'Pizza Lyon', 45.75, 4.85), { tagIds: ['pizza'], sharing: 'private' });
    repo.markListsDirty();
    expect(repo.listItems('l')).toEqual([1, 6].map(S).sort());
    expect(repo.listsContaining(S(1))).toEqual(['l']);
    expect(repo.saveMatchesList(S(3), list('x', { tags: ['pizza'], include: [P(3)] }))).toBe(false);
  });

  it('the SQL evaluator equals the reference evaluator on random data', () => {
    const statusArb = fc.constantFrom<SaveStatus | null>(null, 'to_try', 'tried', 'favorite');
    const priceArb = fc.constantFrom<PriceLevel | null>(null, 1, 2, 3, 4);
    const sharingArb = fc.constantFrom<Sharing>('private', 'friends', 'friends');
    const tagIds = ['t0', 't1', 't2', 't3', 't4', 't5'];
    const cats = ['amenity=restaurant', 'amenity=bar', 'shop=books'];
    const placeArb = fc.record({
      lat: fc.integer({ min: 0, max: 100 }).map((x) => x / 10),
      lon: fc.integer({ min: 0, max: 100 }).map((x) => x / 10),
      zone: fc.boolean(),
      cat: fc.constantFrom(...cats, null),
      closed: fc.constantFrom<PlaceStatus>('open', 'open', 'closed', 'maybe_closed'),
      status: statusArb,
      price: priceArb,
      sharing: sharingArb,
      deleted: fc.boolean(),
      friend: fc.boolean(),
      tags: fc.subarray(tagIds, { maxLength: 3 }),
    });
    const rectArb = fc
      .tuple(fc.integer({ min: 0, max: 90 }), fc.integer({ min: 0, max: 90 }), fc.integer({ min: 5, max: 60 }), fc.integer({ min: 5, max: 60 }))
      .map(([x, y, w, h]) => rect(x / 10, y / 10, (x + w) / 10, (y + h) / 10));
    const filterArb = fc.record(
      {
        tags: fc.subarray([...tagIds, 'missing']),
        categories: fc.subarray(cats),
        statuses: fc.subarray<SaveStatus>(['to_try', 'tried', 'favorite']),
        priceLevels: fc.subarray<PriceLevel>([1, 2, 3, 4]),
        zones: fc.array(rectArb.map((g) => ({ kind: 'drawn' as const, geometry: g })), { maxLength: 2 }),
        include: fc.subarray(Array.from({ length: 25 }, (_, i) => P(i + 1))),
        exclude: fc.subarray(Array.from({ length: 25 }, (_, i) => P(i + 1))),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(
        fc.array(placeArb, { minLength: 1, maxLength: 25 }),
        fc.array(fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }), { minLength: 6, maxLength: 6 }),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        filterArb,
        fc.constantFrom('link', 'public' as const),
        fc.constantFrom('filter', 'manual' as const),
        (places, parents, tagDeleted, filter, visibility, kind) => {
          const repo = openRepo(disable);
          // Acyclic random tag tree (parent index < own index), some in the trash.
          const parentOf = (i: number) => {
            const p = parents[i];
            return p != null && p < i ? `t${p}` : null;
          };
          const active = (i: number): boolean => !tagDeleted[i] && (parentOf(i) === null || active(Number(parentOf(i)!.slice(1))));
          repo.writeOwnTags(tagIds.map((id, i) => tagRec(id, id, parentOf(i), { deletedAt: tagDeleted[i] ? 1 : null, active: active(i) })));
          places.forEach((p, i) => {
            const n = i + 1;
            const geometry = p.zone ? rect(p.lon, p.lat, p.lon + 0.5, p.lat + 0.3) : { type: 'Point' as const, coordinates: [p.lon, p.lat] };
            const snap = { osm: { type: 'node' as const, id: n }, name: `p${n}`, category: p.cat, kind: p.zone ? ('zone' as const) : ('place' as const), geometry };
            if (p.friend) {
              repo.upsertForeignSave({ id: `f${n}`, ownerId: FRIEND, place: { id: P(n), osmType: 'node', osmId: n, name: `p${n}`, category: p.cat, kind: snap.kind, edge: 'sharp', geometry }, createdAt: 1, updatedAt: 1 });
            } else {
              writeMySave(repo, snap, { status: p.status, priceLevel: p.price, sharing: p.sharing, deletedAt: p.deleted ? 1 : null, tagIds: p.tags });
            }
            if (p.closed !== 'open') repo.updatePlaceOsmData(P(n), { status: p.closed });
          });
          const def = list('l', filter, { visibility, kind, manualItems: filter.include ?? [] });
          const sql = repo.evaluateList(def);
          const pure = evaluateListPure(def, subjects(repo), repo.filterContext());
          expect(sql).toEqual(pure);
          // Never a private, trashed or foreign save; never a closed place in a public list.
          for (const id of sql) {
            const s = repo.getSave(id)!;
            expect(s.sharing).not.toBe('private');
            expect(s.deletedAt).toBeNull();
            expect(s.ownerId).toBe(ME);
            if (visibility === 'public') expect(repo.getPlace(s.placeId)!.status).not.toBe('closed');
          }
          repo.db.close();
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('normalizeFilter', () => {
  it('dedups, sorts, drops unknown values and empty groups, exclude wins', () => {
    expect(
      normalizeFilter({
        tags: ['b', 'a', 'b'],
        statuses: ['tried', 'bogus' as SaveStatus],
        priceLevels: [9 as PriceLevel, 2],
        categories: [],
        include: ['x', 'y'],
        exclude: ['y'],
      }),
    ).toEqual({ tags: ['a', 'b'], statuses: ['tried'], priceLevels: [2], include: ['x'], exclude: ['y'] });
  });
});
