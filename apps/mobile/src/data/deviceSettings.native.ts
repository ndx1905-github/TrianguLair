/** Native per-device values, in expo-sqlite's key-value store. */
import Storage from 'expo-sqlite/kv-store';

export function getSetting(key: string): string | null {
  try {
    return Storage.getItemSync(key);
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: string): void {
  try {
    Storage.setItemSync(key, value);
  } catch {
    // Ignored: worst case, a new actor id next launch.
  }
}
