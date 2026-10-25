/**
 * Web (test build): SQLite through sql.js, the database file persisted to
 * IndexedDB after each write (debounced), memory only when unavailable.
 */
import initSqlJs from 'sql.js/dist/sql-wasm-inline.js';
import { DataStore } from '@triangulair/data';

import { deviceActor, LOCAL_ME_ID, newId } from './identity';
import type { AppStore } from './openStore.types';
import { SqlJsDriver } from './sqljsDriver';
import { openWebFileStore } from './webPersistence';

const SAVE_DELAY_MS = 400;

export async function openAppStore(): Promise<AppStore> {
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
    return DataStore.open({ driver, meId: LOCAL_ME_ID, actor: deviceActor(), newId });
  };

  let store: DataStore;
  try {
    store = open(bytes);
  } catch (e) {
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

  return {
    store,
    get persistence() {
      return persistent ? ('indexeddb' as const) : ('memory' as const);
    },
    flush,
  };
}
