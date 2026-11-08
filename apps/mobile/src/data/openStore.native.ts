/**
 * Native: expo-sqlite (synchronous JSI API) through the data package's
 * driver. R*Tree needs the expo-sqlite config plugin flag (app.json).
 *
 * Not run yet on a device (needs a development build).
 */
import { deleteDatabaseSync, openDatabaseSync } from 'expo-sqlite';
import { databaseOwner, DataStore, reassignOwner } from '@triangulair/data';
import { ExpoSqliteDriver } from '@triangulair/data/expo';

import { deviceActor, LOCAL_ME_ID, newId } from './identity';
import type { AppStore } from './openStore.types';

/** `movedFrom`: identities this device left (theft of the primary device): their database moves to `meId`. */
export async function openAppStore(meId: string, movedFrom: readonly string[] = []): Promise<AppStore> {
  const driver = new ExpoSqliteDriver(openDatabaseSync('triangulair.db'));
  // Data created before the identity existed (placeholder owner) moves to it once.
  reassignOwner(driver, LOCAL_ME_ID, meId);
  for (const old of movedFrom) if (databaseOwner(driver) === old) reassignOwner(driver, old, meId);
  const store = DataStore.open({ driver, meId, actor: deviceActor(), newId });
  return {
    store,
    persistence: 'sqlite',
    flush: async () => {},
    async erase() {
      // DataStore.wipe() already emptied and closed it; the file goes too.
      try {
        deleteDatabaseSync('triangulair.db');
      } catch (e) {
        console.warn('Could not delete the database file', e);
      }
    },
  };
}
