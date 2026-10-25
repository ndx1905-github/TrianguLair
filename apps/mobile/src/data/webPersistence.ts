/**
 * Web persistence of the sql.js database file in IndexedDB. Every call is
 * guarded: in a private window, with blocked site data or in a sandboxed
 * preview, IndexedDB may be missing or throw, and the app then keeps its
 * data in memory for the session (and says so).
 */
const DB_NAME = 'triangulair';
const STORE = 'files';
const KEY = 'main.sqlite';

function openIdb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return resolve(null);
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export interface WebFileStore {
  /** false when IndexedDB is unavailable (memory only). */
  persistent: boolean;
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<boolean>;
}

export async function openWebFileStore(): Promise<WebFileStore> {
  const db = await openIdb();
  if (!db) {
    return { persistent: false, load: async () => null, save: async () => false };
  }
  const tx = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> =>
    new Promise((resolve) => {
      try {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  return {
    persistent: true,
    async load() {
      const v = await tx<unknown>('readonly', (s) => s.get(KEY));
      return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
    },
    async save(bytes) {
      const r = await tx('readwrite', (s) => s.put(bytes, KEY));
      return r !== null;
    },
  };
}
