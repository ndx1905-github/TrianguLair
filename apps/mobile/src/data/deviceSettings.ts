/**
 * Small per-device values (Automerge actor, demo seed flag). Web:
 * localStorage, guarded (it can throw or be empty). Native: expo-sqlite's
 * synchronous key-value store (see deviceSettings.native.ts).
 */
export function getSetting(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(`triangulair:${key}`) ?? null;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(`triangulair:${key}`, value);
  } catch {
    // Storage blocked: the value lives for this session only.
  }
}
