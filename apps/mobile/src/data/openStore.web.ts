/**
 * Web (test build): SQLite through sql.js, the database file persisted to
 * IndexedDB after each write (debounced), memory only when unavailable.
 */
import initSqlJs from 'sql.js/dist/sql-wasm-inline.js';
import { databaseOwner, DataStore, reassignOwner } from '@triangulair/data';

import { deviceActor, LOCAL_ME_ID, newId } from './identity';
import type { AppStore } from './openStore.types';
import { SqlJsDriver } from './sqljsDriver';
import { openWebFileStore } from './webPersistence';

const SAVE_DELAY_MS = 400;

/** The saved database belongs to another identity than the one on this device. */
export class ForeignDatabaseError extends Error {
  constructor() {
    super('the saved places belong to another identity');
  }
}

/** `movedFrom`: identities this device left (theft of the primary device): their database moves to `meId`. */
export async function openAppStore(meId: string, movedFrom: readonly string[] = [], _secrets?: unknown): Promise<AppStore> {
  const [SQL, files] = await Promise.all([initSqlJs(), openWebFileStore()]);
  let bytes: Uint8Array | null = null;
  try {
    bytes = await files.load();
  } catch {
    bytes = null;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let driver: SqlJsDriver | null = null;
  let persistent = files.persistent;

  const save = async () => {
    timer = null;
    if (!driver || !persistent) return;
    try {
      persistent = await files.save(driver.export());
    } catch {
      persistent = false;
    }
  };
  const schedule = () => {
    if (!persistent || timer) return;
    timer = setTimeout(save, SAVE_DELAY_MS);
  };

  const open = (data: Uint8Array | null) => {
    driver = new SqlJsDriver(data ? new SQL.Database(data) : new SQL.Database(), schedule);
    const owner = databaseOwner(driver);
    if (owner !== null && owner !== meId && owner !== LOCAL_ME_ID && !movedFrom.includes(owner)) {
      // Another identity's places (keys cleared but not the data): never overwrite them.
      persistent = false;
      throw new ForeignDatabaseError();
    }
    // Data created before the identity existed (placeholder owner) moves to it once.
    if (reassignOwner(driver, LOCAL_ME_ID, meId).migrated) schedule();
    for (const old of movedFrom) if (databaseOwner(driver) === old && reassignOwner(driver, old, meId).migrated) schedule();
    return DataStore.open({ driver, meId, actor: deviceActor(), newId });
  };

  let store: DataStore;
  try {
    store = open(bytes);
  } catch (e) {
    if (e instanceof ForeignDatabaseError) throw e;
    // A corrupt or incompatible saved file must not brick the app: start empty.
    console.warn('Could not open the saved database, starting from an empty one', e);
    store = open(null);
  }

  const flush = async () => {
    if (timer) clearTimeout(timer);
    await save();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => void flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flush();
    });
  }

  let erased = false;
  return {
    store,
    async erase() {
      erased = true;
      if (timer) clearTimeout(timer);
      timer = null;
      persistent = false;
      await files.remove();
    },
    // The web test build is not encrypted (sql.js has no SQLCipher); the settings say so.
    encryption: 'web-test' as const,
    get persistence() {
      if (erased) return 'memory' as const;
      return persistent ? ('indexeddb' as const) : ('memory' as const);
    },
    flush,
  };
}
