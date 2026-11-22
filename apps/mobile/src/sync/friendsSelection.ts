/**
 * Whose places are shown (spec "Interface" > "Whose places"): mine or not, and all my friends, none
 * or a selection. Kept per device (versioned JSON, parsed defensively) and shared by every screen
 * through a tiny external store.
 *
 * Format 2 adds the "me shown" flag; a format 1 value (friends only) is read with my places shown,
 * and the map filter's old "Friends' places" visibility (mine hidden) moves here once
 * (`migrateFriendsOnly`).
 */
import { useSyncExternalStore } from 'react';

import { getSetting, setSetting } from '../data/deviceSettings';

/** Which friends are shown. */
export type FriendsPart = { mode: 'all' } | { mode: 'none' } | { mode: 'some'; ids: string[] };
/** Which friends are shown, and whether my own places are. */
export type FriendsSelection = FriendsPart & { me: boolean };

/** Everyone: my places and all my friends'. */
export const ALL_FRIENDS: FriendsSelection = { mode: 'all', me: true };
export const ONLY_MINE: FriendsSelection = { mode: 'none', me: true };
export const SETTING_KEY = 'friends-shown';
export const SELECTION_FORMAT = 2;

export function onlyFriend(owner: string): FriendsSelection {
  return { mode: 'some', ids: [owner], me: false };
}

function friendsPart(o: { mode?: unknown; ids?: unknown }): FriendsPart {
  if (o.mode === 'none') return { mode: 'none' };
  if (o.mode === 'some' && Array.isArray(o.ids)) {
    const ids = [...new Set(o.ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 300))].slice(0, 2000);
    return ids.length ? { mode: 'some', ids } : { mode: 'none' };
  }
  return { mode: 'all' };
}

/** Never "nobody": a stored value that would show no one shows my places. */
function nonEmpty(s: FriendsSelection): FriendsSelection {
  return !s.me && s.mode === 'none' ? { mode: 'none', me: true } : s;
}

export function parseSelection(s: string | null): FriendsSelection {
  if (!s) return ALL_FRIENDS;
  try {
    const o = JSON.parse(s) as { v?: number; mode?: string; ids?: unknown; me?: unknown };
    if (!o || typeof o !== 'object') return ALL_FRIENDS;
    // Format 1: friends only, my places always shown.
    if (o.v === 1) return { ...friendsPart(o), me: true };
    if (o.v === SELECTION_FORMAT) return nonEmpty({ ...friendsPart(o), me: o.me !== false });
    return ALL_FRIENDS;
  } catch {
    return ALL_FRIENDS;
  }
}

export function serializeSelection(s: FriendsSelection): string {
  const base = { v: SELECTION_FORMAT, me: s.me, mode: s.mode };
  return JSON.stringify(s.mode === 'some' ? { ...base, ids: [...s.ids].sort() } : base);
}

export function isShown(s: FriendsSelection, owner: string): boolean {
  return s.mode === 'all' || (s.mode === 'some' && s.ids.includes(owner));
}

/** Friends shown among `everyone`, in their order. */
export function shownFriends(s: FriendsSelection, everyone: readonly string[]): string[] {
  return everyone.filter((id) => isShown(s, id));
}

/**
 * Toggles one friend; from "all" the others stay chosen. No friend left is "none"; every friend is
 * "all". Deselecting the last one shown (my places hidden) does nothing: the map never shows nobody.
 */
export function toggleFriend(s: FriendsSelection, owner: string, everyone: readonly string[]): FriendsSelection {
  const current = s.mode === 'all' ? [...everyone] : s.mode === 'none' ? [] : s.ids;
  const ids = current.includes(owner) ? current.filter((x) => x !== owner) : [...current, owner];
  if (ids.length === 0) return s.me ? { mode: 'none', me: true } : s;
  if (everyone.length > 0 && everyone.every((x) => ids.includes(x))) return { mode: 'all', me: s.me };
  return { mode: 'some', ids, me: s.me };
}

/** Shows or hides my places; hiding them when no friend is shown does nothing. */
export function toggleMe(s: FriendsSelection, everyone: readonly string[]): FriendsSelection {
  if (s.me && shownFriends(s, everyone).length === 0) return s;
  return { ...s, me: !s.me };
}

export type SelectionKind = 'everyone' | 'mine' | 'friends' | 'one' | 'custom';

/** What the selection amounts to, for its label ("Everyone", "Only mine", "Only Léa"…). */
export function selectionKind(s: FriendsSelection, everyone: readonly string[]): { kind: SelectionKind; friend?: string; count: number } {
  const shown = shownFriends(s, everyone);
  const all = s.mode === 'all' || (everyone.length > 0 && shown.length === everyone.length);
  if (s.me && all) return { kind: 'everyone', count: shown.length };
  if (s.me && shown.length === 0) return { kind: 'mine', count: 0 };
  if (!s.me && all) return { kind: 'friends', count: shown.length };
  if (!s.me && shown.length === 1) return { kind: 'one', friend: shown[0]!, count: 1 };
  return { kind: 'custom', count: shown.length };
}

/** The selection with only this person's places ("Only Léa"); `null` is "Only mine". */
export function onlyOf(owner: string | null): FriendsSelection {
  return owner === null ? ONLY_MINE : onlyFriend(owner);
}

/**
 * The map filter's old "Friends' places" visibility (`friendsOnly`, friends' places only) belongs to
 * this selection now. Alone, it becomes "my places hidden"; with "private" or "shared" it added
 * friends' places to some of mine, which "Everyone" does. Returns the filter's visibility without it.
 */
export function migrateFriendsOnly<V extends string>(visibility: readonly V[] | undefined, s: FriendsSelection): { visibility: V[]; selection: FriendsSelection } | null {
  if (!visibility?.includes('friendsOnly' as V)) return null;
  const rest = visibility.filter((v) => v !== 'friendsOnly');
  const selection = rest.length === 0 ? nonEmpty({ ...(s.mode === 'none' ? { mode: 'all' as const } : s), me: false }) : s;
  return { visibility: rest, selection };
}

let current: FriendsSelection | null = null;
const listeners = new Set<() => void>();

export function getSelection(): FriendsSelection {
  current ??= parseSelection(getSetting(SETTING_KEY));
  return current;
}

export function setSelection(s: FriendsSelection): void {
  current = s;
  setSetting(SETTING_KEY, serializeSelection(s));
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useFriendsSelection(): FriendsSelection {
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}
