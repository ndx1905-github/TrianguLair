import { describe, expect, it } from 'vitest';
import type { FriendTagRow } from '@triangulair/data';

import type { AppTag } from '../places/model';
import { PALETTE } from '../theme/tags';
import { buildFriendTagIndex, friendTagKey, normalizeTagName, resolveFriendTag } from './friendTags';
import { suggestTagStyle } from './suggest';
import { buildTagTree, canReparent, descendantIds, parentOptions, placeCounts, tagPath, validateTagName } from './tree';

const tag = (id: string, name: string, parentId: string | null = null, color: string = PALETTE.red): AppTag => ({ id, name, color, icon: 'restaurant', parentId, osmCategories: [] });
const TAGS = [tag('r', 'Restaurant'), tag('p', 'Pizza', 'r', PALETTE.orange), tag('n', 'Napolitaine', 'p'), tag('b', 'Bar', null, PALETTE.violet), tag('a', 'Asiatique', 'r')];

describe('tag tree', () => {
  it('orders parents before children, siblings by name, with paths and depth', () => {
    expect(buildTagTree(TAGS).map((n) => `${'  '.repeat(n.depth)}${n.tag.name}`)).toEqual(['Bar', 'Restaurant', '  Asiatique', '  Pizza', '    Napolitaine']);
    expect(buildTagTree(TAGS).find((n) => n.tag.id === 'r')?.childCount).toBe(2);
    expect(tagPath('n', new Map(TAGS.map((t) => [t.id, t])))).toBe('Restaurant › Pizza › Napolitaine');
  });

  it('survives a cycle and an unknown parent (shown at the root)', () => {
    const cyc = [tag('x', 'X', 'y'), tag('y', 'Y', 'x'), tag('z', 'Z', 'gone')];
    const tree = buildTagTree(cyc);
    expect(tree).toHaveLength(3);
    expect(tree.filter((n) => n.depth === 0).map((n) => n.tag.id).sort()).toEqual(['x', 'z']);
    expect(tagPath('x', new Map(cyc.map((t) => [t.id, t])))).toBe('Y › X');
  });

  it('never offers a parent that would create a cycle', () => {
    expect([...descendantIds('r', TAGS)].sort()).toEqual(['a', 'n', 'p']);
    expect(canReparent('r', 'n', TAGS)).toBe(false);
    expect(canReparent('r', 'r', TAGS)).toBe(false);
    expect(canReparent('n', 'b', TAGS)).toBe(true);
    expect(canReparent('n', null, TAGS)).toBe(true);
    expect(parentOptions('p', TAGS).map((n) => n.tag.id)).toEqual(['b', 'r', 'a']);
    expect(parentOptions(null, TAGS)).toHaveLength(5);
  });

  it('checks names: empty, too long, duplicate among siblings only (accents and case ignored)', () => {
    expect(validateTagName('  ', null, TAGS)).toBe('empty');
    expect(validateTagName('x'.repeat(41), null, TAGS)).toBe('tooLong');
    expect(validateTagName('bar', null, TAGS)).toBe('duplicate');
    expect(validateTagName('PIZZA', 'r', TAGS)).toBe('duplicate');
    expect(validateTagName('Pizza', 'b', TAGS)).toBeNull();
    expect(validateTagName('Pizza', 'r', TAGS, 'p')).toBeNull(); // renaming itself
  });

  it('counts places per tag, sub-tags included, each place once', () => {
    const counts = placeCounts(TAGS, [['n'], ['p', 'n'], ['b'], ['a', 'b'], []]);
    expect(Object.fromEntries(counts)).toEqual({ n: 2, p: 2, r: 3, b: 2, a: 1 });
  });
});

describe('suggested color and icon', () => {
  it('from keywords, English and French, accents ignored', () => {
    expect(suggestTagStyle('Pizzerias').icon).toBe('pizza');
    expect(suggestTagStyle('Musées').icon).toBe('museum');
    expect(suggestTagStyle('Sushi bar').icon).toBe('noodles');
    expect(suggestTagStyle('Bars à cocktails').icon).toBe('bar');
    expect(suggestTagStyle('Coins secrets').icon).toBe('fallback');
  });

  it('avoids a color another tag already uses', () => {
    expect(suggestTagStyle('Pizza', []).color).toBe(PALETTE.red);
    expect(suggestTagStyle('Pizza', [{ color: PALETTE.red }]).color).toBe(PALETTE.pink);
    expect(suggestTagStyle('Coins secrets', [{ color: PALETTE.red }, { color: PALETTE.pink }]).color).toBe(PALETTE.fuchsia);
  });
});

describe("friends' tags", () => {
  it('normalizes case, accents, plurals and synonyms', () => {
    expect(normalizeTagName('Restos')).toBe('restaurant');
    expect(normalizeTagName('BARS')).toBe('bar');
    expect(normalizeTagName('Musées')).toBe('museum');
    expect(normalizeTagName('Gâteaux')).toBe(normalizeTagName('gâteau'));
    expect(normalizeTagName('Journaux')).toBe('journal');
    expect(normalizeTagName('Point de vue')).toBe('viewpoint');
    expect(friendTagKey('lea', 'Rooftop')).toBe(friendTagKey('lea', 'ROOFTOP'));
  });

  it('manual mapping first, then name; a mapping to a deleted tag is ignored', () => {
    const maps = [{ personId: 'lea', theirTag: 'Bouffe', myTagId: 'b' }, { personId: 'lea', theirTag: 'Old', myTagId: 'gone' }];
    expect(resolveFriendTag('lea', 'bouffe', TAGS, maps)).toEqual({ tagId: 'b', via: 'manual' });
    expect(resolveFriendTag('max', 'Bouffe', TAGS, maps)).toEqual({ tagId: 'r', via: 'name' }); // synonym of restaurant
    expect(resolveFriendTag('lea', 'Pizzas', TAGS, maps)).toEqual({ tagId: 'p', via: 'name' });
    expect(resolveFriendTag('lea', 'Old', TAGS, maps)).toBeNull();
    expect(resolveFriendTag('lea', 'Rooftop', TAGS, maps)).toBeNull();
  });

  it('indexes places: mapped tags become mine, the others keep their color; clashes flagged', () => {
    const rows: FriendTagRow[] = [
      { personId: 'lea', saveId: 's1', placeId: 'p1', name: 'Bars', color: null, icon: null },
      { personId: 'lea', saveId: 's1', placeId: 'p1', name: 'Rooftop', color: PALETTE.violet, icon: 'view' },
      { personId: 'lea', saveId: 's2', placeId: 'p2', name: 'Rooftop', color: PALETTE.violet, icon: 'view' },
    ];
    const idx = buildFriendTagIndex(rows, TAGS, [], (id) => (id === 'lea' ? 'Léa' : id));
    expect(idx.byPlace.get('p1')).toEqual({
      mapped: ['b'],
      unmapped: [{ key: friendTagKey('lea', 'Rooftop'), personId: 'lea', name: 'Rooftop', color: PALETTE.violet, icon: 'view' }],
    });
    expect(idx.entries.map((e) => [e.name, e.count, e.match?.tagId ?? null, e.clashWith])).toEqual([
      ['Rooftop', 2, null, 'b'], // same violet as my Bar
      ['Bars', 1, 'b', null],
    ]);
    expect(idx.entries[0]!.personName).toBe('Léa');
  });
});
