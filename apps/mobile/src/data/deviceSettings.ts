/**
 * Small per-device values (document actor, demo seed flag, filter bar state,
 * closed-place answers). Web: localStorage, guarded (it can throw, be full or
 * be missing); when it fails, values live in memory for this session, so a
 * read after a write always sees the write. Native: expo-sqlite's synchronous
 * key-value store (see deviceSettings.native.ts), same fallback.
 */
const memory = new Map<string, string>();

export function getSetting(key: string): string | null {
  // This session's writes first (they may have failed to reach the storage).
  const mem = memory.get(key);
  if (mem !== undefined) return mem;
  try {
    return globalThis.localStorage?.getItem(`triangulair:${key}`) ?? null;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: string): void {
  memory.set(key, value);
  try {
    globalThis.localStorage?.setItem(`triangulair:${key}`, value);
  } catch {
    // Storage blocked or full: the value lives for this session only.
  }
}
