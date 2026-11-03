/**
 * Native: expo-sqlite (synchronous JSI API) through the data package's
 * driver. R*Tree needs the expo-sqlite config plugin flag (app.json).
 *
 * Not run yet on a device (needs a development build).
 */
import { openDatabaseSync } from 'expo-sqlite';
import { DataStore, reassignOwner } from '@triangulair/data';
import { ExpoSqliteDriver } from '@triangulair/data/expo';

import { deviceActor, LOCAL_ME_ID, newId } from './identity';
import type { AppStore } from './openStore.types';

export async function openAppStore(meId: string): Promise<AppStore> {
  const driver = new ExpoSqliteDriver(openDatabaseSync('triangulair.db'));
  // Data created before the identity existed (placeholder owner) moves to it once.
  reassignOwner(driver, LOCAL_ME_ID, meId);
  const store = DataStore.open({ driver, meId, actor: deviceActor(), newId });
  return { store, persistence: 'sqlite', flush: async () => {} };
}
