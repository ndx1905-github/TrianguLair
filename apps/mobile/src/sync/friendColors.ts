/**
 * A colour per friend (spec "Interface" > "Whose places"): the dot next to their pins, their chip in
 * the filter bar and on the place card. By default it comes from the tag palette, chosen from the
 * friend's id (the same on every device, for ever); it can be changed on the friend's page, and that
 * choice is kept on this device (versioned JSON, parsed defensively).
 */
import { useSyncExternalStore } from 'react';

import { getSetting, setSetting } from '../data/deviceSettings';
import { PALETTE } from '../theme/tags';

/**
 * The palette without slate (the colour of untagged places) and ink (too close to the icon's
 * outline to tell apart as a small dot): 15 colours.
 */
export const FRIEND_COLORS: readonly string[] = Object.entries(PALETTE)
  .filter(([name]) => name !== 'slate' && name !== 'ink')
  .map(([, hex]) => hex);

export const COLORS_SETTING_KEY = 'friend-colors';
const FORMAT = 1;
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** FNV-1a (32 bits): small, fast and the same everywhere. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The default colour of a friend: one of FRIEND_COLORS, from their id only. */
export function defaultFriendColor(id: string): string {
  return FRIEND_COLORS[hashId(id) % FRIEND_COLORS.length]!;
}

export type ColorOverrides = Readonly<Record<string, string>>;

export function parseColors(raw: string | null): ColorOverrides {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as { v?: unknown; colors?: unknown };
    if (!o || o.v !== FORMAT || !o.colors || typeof o.colors !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [id, c] of Object.entries(o.colors as Record<string, unknown>)) {
      if (id && typeof c === 'string' && HEX.test(c)) out[id] = c.toUpperCase();
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeColors(c: ColorOverrides): string {
  const sorted = Object.fromEntries(Object.entries(c).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ v: FORMAT, colors: sorted });
}

export function friendColor(id: string, overrides: ColorOverrides): string {
  return overrides[id] ?? defaultFriendColor(id);
}

/** Sets (or, with null or the default colour, resets) one friend's colour. */
export function withColor(c: ColorOverrides, id: string, color: string | null): ColorOverrides {
  const next = { ...c };
  if (color === null || color.toUpperCase() === defaultFriendColor(id).toUpperCase() || !HEX.test(color)) delete next[id];
  else next[id] = color.toUpperCase();
  return next;
}

let current: ColorOverrides | null = null;
const listeners = new Set<() => void>();

export function getColorOverrides(): ColorOverrides {
  current ??= parseColors(getSetting(COLORS_SETTING_KEY));
  return current;
}

export function setFriendColor(id: string, color: string | null): void {
  current = withColor(getColorOverrides(), id, color);
  setSetting(COLORS_SETTING_KEY, serializeColors(current));
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The colour of each friend (`colorOf(id)`), updated when one changes. */
export function useFriendColors(): (id: string) => string {
  const overrides = useSyncExternalStore(subscribe, getColorOverrides, getColorOverrides);
  return colorFn(overrides);
}

const memo = new WeakMap<ColorOverrides, (id: string) => string>();
function colorFn(o: ColorOverrides): (id: string) => string {
  let f = memo.get(o);
  if (!f) {
    f = (id: string) => friendColor(id, o);
    memo.set(o, f);
  }
  return f;
}
