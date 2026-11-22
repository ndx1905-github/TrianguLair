import { describe, expect, it } from 'vitest';

import { defaultFriendColor, FRIEND_COLORS, friendColor, hashId, parseColors, serializeColors, withColor } from './friendColors';
import {
  ALL_FRIENDS,
  ONLY_MINE,
  isShown,
  migrateFriendsOnly,
  onlyFriend,
  parseSelection,
  selectionKind,
  serializeSelection,
  shownFriends,
  toggleFriend,
  toggleMe,
  type FriendsSelection,
} from './friendsSelection';

const all = ['a', 'b', 'c'];

describe('whose places: the selection', () => {
  it('is remembered as versioned JSON, parsed defensively', () => {
    expect(parseSelection(null)).toEqual(ALL_FRIENDS);
    expect(parseSelection('{bad')).toEqual(ALL_FRIENDS);
    expect(parseSelection('null')).toEqual(ALL_FRIENDS);
    expect(parseSelection('{"v":9,"mode":"none","me":false}')).toEqual(ALL_FRIENDS);
    const s: FriendsSelection = { mode: 'some', ids: ['b', 'a', 'a'], me: false };
    expect(parseSelection(serializeSelection(s))).toEqual({ mode: 'some', ids: ['a', 'b'], me: false });
    expect(parseSelection(serializeSelection(ONLY_MINE))).toEqual(ONLY_MINE);
    expect(parseSelection(serializeSelection({ mode: 'all', me: false }))).toEqual({ mode: 'all', me: false });
    // Junk ids are dropped; no id left is "none".
    expect(parseSelection('{"v":2,"me":true,"mode":"some","ids":[1,null,""]}')).toEqual(ONLY_MINE);
  });

  it('migrates format 1 (friends only): my places shown', () => {
    expect(parseSelection('{"v":1,"mode":"all"}')).toEqual(ALL_FRIENDS);
    expect(parseSelection('{"v":1,"mode":"none"}')).toEqual(ONLY_MINE);
    expect(parseSelection('{"v":1,"mode":"some","ids":["b","a"]}')).toEqual({ mode: 'some', ids: ['b', 'a'], me: true });
  });

  it('never shows nobody', () => {
    expect(parseSelection('{"v":2,"me":false,"mode":"none"}')).toEqual(ONLY_MINE);
    // Deselecting the last one shown does nothing.
    expect(toggleMe(ONLY_MINE, all)).toEqual(ONLY_MINE);
    expect(toggleFriend(onlyFriend('a'), 'a', all)).toEqual(onlyFriend('a'));
    expect(toggleMe(onlyFriend('a'), [])).toEqual({ ...onlyFriend('a'), me: true });
  });

  it('toggles me and friends; all friends ticked is "all"', () => {
    let s = toggleFriend(ALL_FRIENDS, 'b', all);
    expect(s).toEqual({ mode: 'some', ids: ['a', 'c'], me: true });
    expect(isShown(s, 'b')).toBe(false);
    s = toggleFriend(s, 'b', all);
    expect(s).toEqual(ALL_FRIENDS);
    expect(toggleFriend({ mode: 'some', ids: ['a'], me: true }, 'a', all)).toEqual(ONLY_MINE);
    expect(toggleMe(ALL_FRIENDS, all)).toEqual({ mode: 'all', me: false });
    expect(toggleFriend(ONLY_MINE, 'c', all)).toEqual({ mode: 'some', ids: ['c'], me: true });
    expect(isShown(ONLY_MINE, 'a')).toBe(false);
    expect(shownFriends({ mode: 'some', ids: ['c', 'gone'], me: true }, all)).toEqual(['c']);
  });

  it('names what it amounts to', () => {
    expect(selectionKind(ALL_FRIENDS, all).kind).toBe('everyone');
    // Every friend ticked one by one is everyone too.
    expect(selectionKind({ mode: 'some', ids: ['a', 'b', 'c'], me: true }, all).kind).toBe('everyone');
    expect(selectionKind(ONLY_MINE, all).kind).toBe('mine');
    expect(selectionKind({ mode: 'all', me: false }, all).kind).toBe('friends');
    expect(selectionKind(onlyFriend('b'), all)).toEqual({ kind: 'one', friend: 'b', count: 1 });
    expect(selectionKind({ mode: 'some', ids: ['a', 'b'], me: true }, all)).toEqual({ kind: 'custom', count: 2 });
    expect(selectionKind({ mode: 'some', ids: ['a', 'b'], me: false }, all)).toEqual({ kind: 'custom', count: 2 });
    // A friend no longer followed does not count.
    expect(selectionKind({ mode: 'some', ids: ['gone'], me: true }, all).kind).toBe('mine');
  });

  it('moves the old "Friends\' places" visibility filter into the selection', () => {
    expect(migrateFriendsOnly(undefined, ALL_FRIENDS)).toBeNull();
    expect(migrateFriendsOnly(['private'], ALL_FRIENDS)).toBeNull();
    // Alone: friends' places only, i.e. my places hidden (and the friends chosen kept).
    expect(migrateFriendsOnly(['friendsOnly'], ALL_FRIENDS)).toEqual({ visibility: [], selection: { mode: 'all', me: false } });
    expect(migrateFriendsOnly(['friendsOnly'], { mode: 'some', ids: ['a'], me: true })).toEqual({ visibility: [], selection: onlyFriend('a') });
    // With no friend shown it meant every friend's place.
    expect(migrateFriendsOnly(['friendsOnly'], ONLY_MINE)).toEqual({ visibility: [], selection: { mode: 'all', me: false } });
    // With some of mine: everyone's, which the selection already does.
    expect(migrateFriendsOnly(['private', 'friendsOnly'], ALL_FRIENDS)).toEqual({ visibility: ['private'], selection: ALL_FRIENDS });
  });
});

describe('friend colours', () => {
  it('come from the tag palette, from the id only', () => {
    expect(FRIEND_COLORS).toHaveLength(15);
    expect(FRIEND_COLORS).not.toContain('#475569');
    for (const id of ['ed25519:abc', 'demo-friend-lea', 'follow:x', '']) {
      expect(FRIEND_COLORS).toContain(defaultFriendColor(id));
      expect(defaultFriendColor(id)).toBe(defaultFriendColor(id));
    }
    // FNV-1a reference values.
    expect(hashId('')).toBe(0x811c9dc5);
    expect(hashId('a')).toBe(0xe40c292c);
    // Spread over the palette: 200 ids use most of the colours.
    const used = new Set(Array.from({ length: 200 }, (_, i) => defaultFriendColor(`ed25519:friend-${i}`)));
    expect(used.size).toBeGreaterThanOrEqual(12);
  });

  it('can be changed per friend and kept as versioned JSON', () => {
    let o = withColor({}, 'a', '#16a34a');
    expect(friendColor('a', o)).toBe('#16A34A');
    expect(friendColor('b', o)).toBe(defaultFriendColor('b'));
    expect(parseColors(serializeColors(o))).toEqual(o);
    // The default colour, null or junk is no override.
    o = withColor(o, 'a', defaultFriendColor('a'));
    expect(o).toEqual({});
    expect(withColor({ a: '#16A34A' }, 'a', null)).toEqual({});
    expect(withColor({}, 'a', 'red')).toEqual({});
    expect(parseColors('{"v":1,"colors":{"a":"javascript:","b":"#ef4444"}}')).toEqual({ b: '#EF4444' });
    expect(parseColors('{"v":2,"colors":{"b":"#ef4444"}}')).toEqual({});
    expect(parseColors('nope')).toEqual({});
  });
});
