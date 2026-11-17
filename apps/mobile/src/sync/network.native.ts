/**
 * Native network status (gap #4): expo-network (Expo's own module: ConnectivityManager on Android, NWPathMonitor on
 * iOS; no Google Play Services, so F-Droid stays possible). Fed to `SyncScheduler.setOnline` by the SyncProvider, so
 * "Offline · N changes pending" shows on phones and a failure without network is not counted against the storage.
 */
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';

import { networkWatcher, type WatchNetwork } from './netState';

export const watchNetwork: WatchNetwork = networkWatcher(
  (listener) => addNetworkStateListener(listener),
  () => getNetworkStateAsync(),
);
