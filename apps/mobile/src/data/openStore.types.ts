import type { DataStore } from '@triangulair/data';

export interface AppStore {
  store: DataStore;
  /** Where the data lives: expo-sqlite file (native), IndexedDB or memory only (web). */
  readonly persistence: 'sqlite' | 'indexeddb' | 'memory';
  /**
   * `sqlcipher`: encrypted with the `db-key` of the secret store (native); `unavailable`: a native build without
   * SQLCipher (unencrypted); `web-test`: the web test build, unencrypted (gap #7).
   */
  readonly encryption: 'sqlcipher' | 'unavailable' | 'web-test';
  /** Writes pending changes now (web; no-op on native). */
  flush(): Promise<void>;
  /** Remote wipe, after `DataStore.wipe()`: deletes the database file itself (and stops saving it). */
  erase(): Promise<void>;
}
