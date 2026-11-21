/**
 * Native: expo-sqlite (synchronous JSI API) through the data package's
 * driver. R*Tree needs the expo-sqlite config plugin flag (app.json), and so
 * does SQLCipher (`useSQLCipher`): the database is encrypted with a key kept in
 * the secret store (`dbEncryption.ts`, gap #7).
 *
 * Not run yet on a device (needs a development build).
 */
import { deleteDatabaseSync, defaultDatabaseDirectory, openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { File, Paths } from 'expo-file-system';
import { databaseOwner, DataStore, reassignOwner } from '@triangulair/data';
import { ExpoSqliteDriver } from '@triangulair/data/expo';

import type { SecretStore } from '../identity/secretStore.types';
import { openLocalDatabase, PLAIN_DB, SEALED_DB, type CipherDb, type DbFiles } from './dbEncryption';
import { deviceActor, LOCAL_ME_ID, newId } from './identity';
import type { AppStore } from './openStore.types';

const handles = new WeakMap<CipherDb, SQLiteDatabase>();

const files: DbFiles = {
  exists: (name) => new File(Paths.document, 'SQLite', name).exists,
  remove: (name) => {
    try {
      deleteDatabaseSync(name);
    } catch (e) {
      // Not open and not there: nothing to delete.
      if (new File(Paths.document, 'SQLite', name).exists) throw e;
    }
  },
  open: (name) => {
    const db = openDatabaseSync(name);
    const h: CipherDb = {
      exec: (sql) => db.execSync(sql),
      get: <T,>(sql: string) => (db.getFirstSync<T>(sql) ?? null) as T | null,
      close: () => db.closeSync(),
    };
    handles.set(h, db);
    return h;
  },
  path: (name) => `${String(defaultDatabaseDirectory).replace(/\/+$/, '')}/${name}`,
};

/** `movedFrom`: identities this device left (theft of the primary device): their database moves to `meId`. */
export async function openAppStore(meId: string, movedFrom: readonly string[] = [], secrets?: SecretStore | null): Promise<AppStore> {
  if (!secrets) throw new Error('data: the secret store is needed to open the database');
  const opened = await openLocalDatabase(
    files,
    { get: () => secrets.get('db-key'), set: (k) => secrets.set('db-key', k) },
    (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  );
  const driver = new ExpoSqliteDriver(handles.get(opened.db)!);
  // Data created before the identity existed (placeholder owner) moves to it once.
  reassignOwner(driver, LOCAL_ME_ID, meId);
  for (const old of movedFrom) if (databaseOwner(driver) === old) reassignOwner(driver, old, meId);
  const store = DataStore.open({ driver, meId, actor: deviceActor(), newId });
  return {
    store,
    persistence: 'sqlite',
    encryption: opened.encryption,
    flush: async () => {},
    async erase() {
      // DataStore.wipe() already emptied and closed it (and its key left the secret store first); the files go too.
      for (const name of [SEALED_DB, PLAIN_DB]) {
        try {
          files.remove(name);
        } catch (e) {
          console.warn('Could not delete the database file', e);
        }
      }
    },
  };
}
