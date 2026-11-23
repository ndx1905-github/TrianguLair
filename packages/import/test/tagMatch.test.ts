import { describe, expect, it } from 'vitest';

import { applyTagSuggestions, editDistance, pendingTagSuggestions, proposeTagActions, setTagAction, suggestTag, tagKey, TAG_SYNONYMS, type ImportPlan } from '../src/index.ts';

// The app's starter tags (apps/mobile/src/theme/tags.ts), named in French as a French phone has them.
const FR = ['Restaurant', 'Café', 'Boulangerie', 'Bar', 'Parc', 'Point de vue', 'Musée', 'Musique', 'Boutique', 'Hôtel'].map((name, i) => ({ id: `t${i}`, name }));
const EN = ['Restaurant', 'Café', 'Bakery', 'Bar', 'Park', 'Viewpoint', 'Museum', 'Music', 'Shop', 'Hotel'].map((name, i) => ({ id: `e${i}`, name }));
const id = (tags: typeof FR, name: string) => tags.find((t) => t.name === name)!.id;

describe('tag names compared (case, accents, emoji, spaces, punctuation, plural)', () => {
  it('reduces a name to its key', () => {
    expect(tagKey('Restaurants')).toBe('restaurant');
    expect(tagKey('CAFÉS')).toBe('cafe');
    expect(tagKey('🍝 Restaurant')).toBe('restaurant');
    expect(tagKey('Point-de-vue')).toBe(tagKey('point de vue'));
    expect(tagKey('Bureaux')).toBe('bureau');
    expect(tagKey('Grass')).toBe('grass');
    expect(tagKey('🍕🍕')).toBe('');
  });

  it('edit distance', () => {
    expect(editDistance('restaurant', 'restaurnat')).toBe(2);
    expect(editDistance('bar', 'bars')).toBe(1);
    expect(editDistance('kitten', 'sitting', 1)).toBe(2);
  });
});

describe('suggestTag', () => {
  it('same name: whatever the case, accents, emoji, spacing or plural', () => {
    expect(suggestTag('restaurants', FR)).toEqual({ tagId: id(FR, 'Restaurant'), reason: 'same' });
    expect(suggestTag('☕ cafés', FR)).toEqual({ tagId: id(FR, 'Café'), reason: 'same' });
    expect(suggestTag('POINT DE VUE !', FR)).toEqual({ tagId: id(FR, 'Point de vue'), reason: 'same' });
    expect(suggestTag('Musees', FR)).toEqual({ tagId: id(FR, 'Musée'), reason: 'same' });
  });

  it('synonyms, English and French, following the starter tags', () => {
    const cases: [string, string, typeof FR][] = [
      ['Resto', 'Restaurant', FR],
      ['Coffee shops', 'Café', FR],
      ['Bar à café', 'Café', FR],
      ['Museums', 'Musée', FR],
      ['Jardins', 'Parc', FR],
      ['Garden', 'Park', EN],
      ['Pubs', 'Bar', FR],
      ['Boulangeries', 'Bakery', EN],
      ['Bakery', 'Boulangerie', FR],
      ['Musée', 'Museum', EN],
      ['Hostels', 'Hôtel', FR],
      ['Concerts', 'Musique', FR],
      ['Belvédère', 'Viewpoint', EN],
    ];
    for (const [source, mine, tags] of cases) expect(suggestTag(source, tags), source).toEqual({ tagId: id(tags, mine), reason: 'synonym' });
  });

  it('close names: a typo, or one name containing the other', () => {
    expect(suggestTag('Restaurnat', FR)).toEqual({ tagId: id(FR, 'Restaurant'), reason: 'close' });
    expect(suggestTag('Musique live', FR)).toEqual({ tagId: id(FR, 'Musique'), reason: 'close' });
    expect(suggestTag('Boutiques de créateurs', FR)).toEqual({ tagId: id(FR, 'Boutique'), reason: 'close' });
  });

  it('nothing for unrelated or too short names', () => {
    expect(suggestTag('Sushi', FR)).toBeNull();
    expect(suggestTag('Want to go', EN)).toBeNull();
    // "bar" is in too many words to count as contained.
    expect(suggestTag('Barbecue', [{ id: 'b', name: 'Bar' }])).toBeNull();
    expect(suggestTag('🍕', FR)).toBeNull();
    expect(suggestTag('Bars', [])).toBeNull();
  });

  it('a top-level tag of mine wins over a sub-tag of the same name; the closest name wins', () => {
    const tags = [
      { id: 'sub', name: 'Pizza', parentId: 'r' },
      { id: 'r', name: 'Restaurant' },
      { id: 'top', name: 'Pizza' },
    ];
    expect(suggestTag('pizzas', tags)).toEqual({ tagId: 'top', reason: 'same' });
    expect(suggestTag('Restaurant', [{ id: 'a', name: 'Restaurants chics' }, { id: 'b', name: 'Restaurantz' }])).toEqual({ tagId: 'b', reason: 'close' });
  });

  it('the synonym table: no name in two groups', () => {
    const seen = new Map<string, number>();
    TAG_SYNONYMS.forEach((group, i) => {
      for (const name of group) {
        const k = tagKey(name);
        expect(seen.has(k) && seen.get(k) !== i, `${name} is in two groups`).toBe(false);
        seen.set(k, i);
      }
    });
  });
});

describe('the import tag step', () => {
  const mine = FR.map((t) => ({ ...t, parentId: null, color: '#000000', icon: null, osmCategories: [], active: true, deletedAt: null, createdAt: 0, updatedAt: 0 })) as never[];

  function plan(tags: string[]): ImportPlan {
    const sourceTags = tags.map((name) => ({ key: name, name }));
    const places = tags.map((name, i) => ({ key: `p${i}`, name: `Place ${i}`, lat: 48, lon: 2, tags: [name], ids: {} }));
    return { format: 'csv', verified: true, items: [], tags: proposeTagActions(sourceTags, places, mine), warnings: [], mergeExisting: false, observedAt: '2026-01-01T00:00:00.000Z' };
  }

  it('preselects my tag for the same name, only suggests synonyms and close names, creates the others', () => {
    const p = plan(['Restaurants 🍝', 'Resto', 'Restaurnat', 'Sushi']);
    const by = new Map(p.tags.map((t) => [t.source.name, t]));
    expect(by.get('Restaurants 🍝')!.action).toEqual({ kind: 'map', tagId: id(FR, 'Restaurant') });
    expect(by.get('Resto')!.action.kind).toBe('create');
    expect(by.get('Resto')!.suggestion).toEqual({ tagId: id(FR, 'Restaurant'), reason: 'synonym' });
    expect(by.get('Restaurnat')!.suggestion?.reason).toBe('close');
    expect(by.get('Sushi')!.suggestion).toBeNull();
    expect(pendingTagSuggestions(p)).toBe(2);
  });

  it('"Same as my tags where possible": applies every suggestion at once, keeps "Don\'t import"', () => {
    let p = plan(['Resto', 'Restaurnat', 'Coffee', 'Sushi']);
    p = setTagAction(p, 'Coffee', { kind: 'skip' });
    const after = applyTagSuggestions(p);
    const by = new Map(after.tags.map((t) => [t.source.name, t.action]));
    expect(by.get('Resto')).toEqual({ kind: 'map', tagId: id(FR, 'Restaurant') });
    expect(by.get('Restaurnat')).toEqual({ kind: 'map', tagId: id(FR, 'Restaurant') });
    expect(by.get('Coffee')).toEqual({ kind: 'skip' });
    expect(by.get('Sushi')?.kind).toBe('create');
    expect(pendingTagSuggestions(after)).toBe(0);
  });
});
