import type { DataStore } from '@triangulair/data';

export interface AppStore {
  store: DataStore;
  /** Where the data lives: expo-sqlite file (native), IndexedDB or memory only (web). */
  readonly persistence: 'sqlite' | 'indexeddb' | 'memory';
  /** Writes pending changes now (web; no-op on native). */
  flush(): Promise<void>;
  /** Remote wipe, after `DataStore.wipe()`: deletes the database file itself (and stops saving it). */
  erase(): Promise<void>;
}
