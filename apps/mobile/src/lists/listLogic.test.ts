import { evaluateListPure, pointInArea, type FilterContext, type FilterSubject, type SaveRecord } from '@triangulair/data';
import { describe, expect, it } from 'vitest';

import {
  addByHand,
  clearException,
  draftDefinition,
  draftFromList,
  draftToFilter,
  EMPTY_DRAFT,
  explain,
  hasCriteria,
  placeToFilterZone,
  removeByHand,
  STREET_BUFFER_M,
  toggleZone,
  type ListDraft,
} from './listLogic';

const ME = 'me';
const ctx: FilterContext = { meId: ME, tagParents: new Map([['food', null], ['pizza', 'food'], ['bar', null]]) };
const square = (w: number, s: number, e: number, n: number) => ({
  type: 'Polygon' as const,
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

function subject(placeId: string, over: Partial<SaveRecord> = {}, place: Partial<FilterSubject['place']> = {}): FilterSubject {
  return {
    save: { id: `${ME}|${placeId}`, ownerId: ME, placeId, status: null, priceLevel: null, sharing: 'friends', tagIds: [], deletedAt: null, ...over },
    place: { category: null, status: 'open', geometry: { type: 'Point', coordinates: [2.35, 48.85] }, ...place },
  };
}

const draft = (d: Partial<ListDraft>): ListDraft => ({ ...EMPTY_DRAFT, name: 'L', ...d });

describe('list filter building', () => {
  it('builds a canonical filter from the draft (sorted, deduplicated, empty groups dropped)', () => {
    const f = draftToFilter(draft({ tags: ['pizza', 'bar', 'pizza'], statuses: ['tried', 'favorite'], include: ['b', 'a'], exclude: ['a'] }));
    expect(f).toEqual({ tags: ['bar', 'pizza'], statuses: ['favorite', 'tried'], include: ['b'], exclude: ['a'] });
    expect(draftToFilter(EMPTY_DRAFT)).toEqual({});
  });
  it('round-trips a stored list', () => {
    const d = draft({ tags: ['bar'], zones: [{ kind: 'drawn', name: 'Z', geometry: square(2, 48, 3, 49) }], items: ['x'] });
    const back = draftFromList({
      id: 'l',
      ownerId: ME,
      name: d.name,
      description: '',
      visibility: 'public',
      linkKey: null,
      kind: 'filter',
      filter: draftToFilter(d),
      manualItems: d.items,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    });
    expect(back).toMatchObject({ tags: ['bar'], items: ['x'], visibility: 'public' });
    expect(back.zones[0]).toMatchObject({ kind: 'drawn', name: 'Z' });
  });
  it('toggles zones by identity and knows when there is no criterion', () => {
    const z = { kind: 'osm' as const, osmType: 'relation' as const, osmId: 7, name: 'Paris', geometry: square(2, 48, 3, 49) };
    const once = toggleZone([], z);
    expect(once).toHaveLength(1);
    expect(toggleZone(once, { ...z, name: 'Paris (renamed)' })).toHaveLength(0);
    expect(hasCriteria(draft({}))).toBe(false);
    expect(hasCriteria(draft({ zones: once }))).toBe(true);
  });
  it('turns my saved zones into filter zones (street zones are buffered)', () => {
    const osmZone = placeToFilterZone({ osmType: 'relation', osmId: 5, name: 'Archives', geometry: square(2.35, 48.85, 2.37, 48.87) });
    expect(osmZone).toMatchObject({ kind: 'osm', osmType: 'relation', osmId: 5, name: 'Archives' });
    const drawn = placeToFilterZone({ osmType: null, osmId: null, name: 'Mine', geometry: square(2.35, 48.85, 2.37, 48.87) });
    expect(drawn).toMatchObject({ kind: 'drawn', name: 'Mine' });
    const street = placeToFilterZone({
      osmType: null,
      osmId: null,
      name: 'Rue de Bretagne',
      geometry: { type: 'LineString', coordinates: [[2.3605, 48.8631], [2.366, 48.8626]] },
    })!;
    expect(street.kind).toBe('drawn');
    expect(street.geometry.type).toBe('Polygon');
    // Marché des Enfants Rouges is about 20 m from the street.
    expect(pointInArea({ lat: 48.8628, lon: 2.3618 }, street.geometry)).toBe(true);
    expect(pointInArea({ lat: 48.8628 - (STREET_BUFFER_M * 3) / 111_000, lon: 2.3618 }, street.geometry)).toBe(false);
    expect(placeToFilterZone({ osmType: null, osmId: null, name: 'P', geometry: { type: 'Point', coordinates: [2, 48] } })).toBeNull();
  });
});

describe('exceptions', () => {
  it('adds and removes by hand on a filter list; exclusion wins and can be cleared', () => {
    let d = draft({ statuses: ['favorite'] });
    d = addByHand(d, 'p1');
    expect(d.include).toEqual(['p1']);
    d = removeByHand(d, 'p1');
    expect(d.include).toEqual([]);
    expect(d.exclude).toEqual(['p1']);
    d = addByHand(d, 'p1');
    expect(d.exclude).toEqual([]);
    expect(clearException(removeByHand(d, 'p1'), 'p1')).toMatchObject({ include: [], exclude: [] });
  });
  it('selects and unselects on a manual list', () => {
    let d = draft({ kind: 'manual' });
    d = addByHand(addByHand(d, 'a'), 'a');
    expect(d.items).toEqual(['a']);
    expect(removeByHand(d, 'a').items).toEqual([]);
    expect(d.include).toEqual([]);
  });
});

describe('why a place is in or out', () => {
  const subjects = [
    subject('pizzeria', { tagIds: ['pizza'], status: 'favorite' }, { category: 'amenity=restaurant' }),
    subject('secret', { tagIds: ['pizza'], status: 'favorite', sharing: 'private' }),
    subject('trashed', { tagIds: ['pizza'], deletedAt: 1 }),
    { ...subject('friend', { tagIds: ['pizza'] }), save: { ...subject('friend', { tagIds: ['pizza'] }).save, ownerId: 'lea' } },
    subject('closed', { tagIds: ['pizza'], status: 'favorite' }, { status: 'closed' }),
    subject('bar', { tagIds: ['bar'], status: 'tried' }),
    subject('far', { tagIds: ['pizza'], status: 'favorite' }, { geometry: { type: 'Point', coordinates: [5, 45] } }),
  ];

  it('agrees with the data package evaluator, and names the reason', () => {
    const d = draft({ tags: ['food'], statuses: ['favorite'], zones: [{ kind: 'drawn', geometry: square(2, 48, 3, 49) }], visibility: 'public' });
    const ins = evaluateListPure(draftDefinition(d), subjects, ctx);
    for (const s of subjects) expect(explain(s, d, ctx).in, s.save.placeId).toBe(ins.includes(s.save.id));
    const why = Object.fromEntries(subjects.map((s) => [s.save.placeId, explain(s, d, ctx)]));
    expect(why.pizzeria).toEqual({ in: true, why: 'criteria' });
    expect(why.secret).toEqual({ in: false, why: 'private' });
    expect(why.trashed).toEqual({ in: false, why: 'trash' });
    expect(why.friend).toEqual({ in: false, why: 'notMine' });
    expect(why.closed).toEqual({ in: false, why: 'closedPublic' });
    expect(why.bar).toEqual({ in: false, why: 'criteria', failed: ['tags', 'statuses'] });
    expect(why.far).toEqual({ in: false, why: 'criteria', failed: ['zones'] });
  });

  it('a private place stays out even when added by hand or selected', () => {
    const secret = subjects[1]!;
    const f = addByHand(draft({ tags: ['bar'] }), 'secret');
    expect(explain(secret, f, ctx)).toEqual({ in: false, why: 'private' });
    expect(evaluateListPure(draftDefinition(f), [secret], ctx)).toEqual([]);
    const m = addByHand(draft({ kind: 'manual' }), 'secret');
    expect(explain(secret, m, ctx)).toEqual({ in: false, why: 'private' });
    expect(evaluateListPure(draftDefinition(m), [secret], ctx)).toEqual([]);
  });

  it('reports exceptions and manual selection', () => {
    const bar = subjects[5]!;
    const pizzeria = subjects[0]!;
    let d = draft({ tags: ['food'] });
    expect(explain(bar, addByHand(d, 'bar'), ctx)).toEqual({ in: true, why: 'addedByHand' });
    expect(explain(pizzeria, removeByHand(d, 'pizzeria'), ctx)).toEqual({ in: false, why: 'removedByHand' });
    d = draft({ kind: 'manual', items: ['bar'] });
    expect(explain(bar, d, ctx)).toEqual({ in: true, why: 'selected' });
    expect(explain(pizzeria, d, ctx)).toEqual({ in: false, why: 'notSelected' });
  });
});
