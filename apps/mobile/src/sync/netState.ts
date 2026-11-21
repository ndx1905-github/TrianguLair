/**
 * Network status for the sync scheduler (spec error table, "No network": "Offline · 3 changes pending").
 * Pure: the platform watchers (`network.web.ts`, `network.native.ts`) feed what they read through `isOnline`.
 */

/** What the platform says about the network (expo-network's `NetworkState`, or the browser). */
export interface NetReading {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
}

/**
 * Offline only on evidence: no connection, or a connection the system found without internet access (captive
 * portal, Wi-Fi without uplink). An unknown value (still being measured) counts as online, so a slow first reading
 * never shows "Offline" by mistake; a failure then is classified by the sync package as usual.
 */
export function isOnline(s: NetReading | null | undefined): boolean {
  if (!s) return true;
  return s.isConnected !== false && s.isInternetReachable !== false;
}

/** Watches the network: `onChange(online)` at the first reading and at every change; returns the unsubscribe. */
export type WatchNetwork = (onChange: (online: boolean) => void) => () => void;

/**
 * Combines a first asynchronous reading with the change events: a reading that arrives after an event is older
 * than it and is dropped. Repeated values are not reported twice.
 */
export function networkWatcher(
  subscribe: (listener: (s: NetReading) => void) => { remove(): void },
  first: () => Promise<NetReading>,
): WatchNetwork {
  return (onChange) => {
    let alive = true;
    let evented = false;
    let last: boolean | null = null;
    const emit = (s: NetReading) => {
      const v = isOnline(s);
      if (!alive || v === last) return;
      last = v;
      onChange(v);
    };
    const sub = subscribe((s) => {
      evented = true;
      emit(s);
    });
    first()
      .then((s) => {
        if (!evented) emit(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
      sub.remove();
    };
  };
}
