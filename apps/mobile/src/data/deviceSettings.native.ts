/** Native per-device values, in expo-sqlite's key-value store (memory fallback, see deviceSettings.ts). */
import Storage from 'expo-sqlite/kv-store';

const memory = new Map<string, string>();

export function getSetting(key: string): string | null {
  // This session's writes first (they may have failed to reach the storage).
  const mem = memory.get(key);
  if (mem !== undefined) return mem;
  try {
    return Storage.getItemSync(key) ?? null;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: string): void {
  memory.set(key, value);
  try {
    Storage.setItemSync(key, value);
  } catch {
    // Ignored: worst case, the value is forgotten at the next launch.
  }
}
