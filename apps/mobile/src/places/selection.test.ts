import { describe, expect, it } from 'vitest';

import { shownIds, splitSelection, toggle, toggleAll, type SelectableRow } from './selection';

const rows: SelectableRow[] = [
  { id: 'a', mine: true, match: 'match' },
  { id: 'b', mine: true, match: 'nomatch' },
  { id: 'c', mine: false, match: 'match' },
  { id: 'd', mine: true, match: 'unknown' },
  { id: 'e', mine: true, match: 'hidden' },
];

describe('the list\'s "Select" mode', () => {
  it('"Select all" takes the places shown: with a filter on, only the matching ones', () => {
    expect(shownIds(rows, false)).toEqual(['a', 'b', 'c', 'd']);
    expect(shownIds(rows, true)).toEqual(['a', 'c']);
  });

  it('only my saves are edited; friends\' places are counted as skipped', () => {
    expect(splitSelection(new Set(['a', 'c', 'd', 'gone']), rows)).toEqual({ mine: ['a', 'd'], friends: 1 });
    expect(splitSelection(new Set(), rows)).toEqual({ mine: [], friends: 0 });
  });

  it('toggles one place, and all of them', () => {
    expect([...toggle(new Set(['a']), 'b')]).toEqual(['a', 'b']);
    expect([...toggle(new Set(['a']), 'a')]).toEqual([]);
    expect([...toggleAll(new Set(['a']), ['a', 'c'])]).toEqual(['a', 'c']);
    expect([...toggleAll(new Set(['a', 'c']), ['a', 'c'])]).toEqual([]);
    expect([...toggleAll(new Set(), [])]).toEqual([]);
  });
});
