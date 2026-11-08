/**
 * Which friends' places are shown (spec "Interface": the friends filter opens a panel with "All my
 * friends", "None" or a selection; the selection is remembered). Kept per device (versioned JSON,
 * parsed defensively) and shared by every screen through a tiny external store.
 */
import { useSyncExternalStore } from 'react';

import { getSetting, setSetting } from '../data/deviceSettings';

export type FriendsSelection = { mode: 'all' } | { mode: 'none' } | { mode: 'some'; ids: string[] };

export const ALL_FRIENDS: FriendsSelection = { mode: 'all' };
export const SETTING_KEY = 'friends-shown';

export function parseSelection(s: string | null): FriendsSelection {
  if (!s) return ALL_FRIENDS;
  try {
    const o = JSON.parse(s) as { v?: number; mode?: string; ids?: unknown };
    if (o.v !== 1) return ALL_FRIENDS;
    if (o.mode === 'none') return { mode: 'none' };
    if (o.mode === 'some' && Array.isArray(o.ids)) return { mode: 'some', ids: [...new Set(o.ids.filter((x): x is string => typeof x === 'string'))] };
    return ALL_FRIENDS;
  } catch {
    return ALL_FRIENDS;
  }
}

export function serializeSelection(s: FriendsSelection): string {
  return JSON.stringify(s.mode === 'some' ? { v: 1, mode: 'some', ids: [...s.ids].sort() } : { v: 1, mode: s.mode });
}

export function isShown(s: FriendsSelection, owner: string): boolean {
  return s.mode === 'all' || (s.mode === 'some' && s.ids.includes(owner));
}

/** Toggles one friend; from "all" the others stay chosen. An empty selection is "none". */
export function toggleFriend(s: FriendsSelection, owner: string, everyone: readonly string[]): FriendsSelection {
  const current = s.mode === 'all' ? [...everyone] : s.mode === 'none' ? [] : s.ids;
  const ids = current.includes(owner) ? current.filter((x) => x !== owner) : [...current, owner];
  if (ids.length === 0) return { mode: 'none' };
  if (everyone.length > 0 && everyone.every((x) => ids.includes(x))) return ALL_FRIENDS;
  return { mode: 'some', ids };
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
