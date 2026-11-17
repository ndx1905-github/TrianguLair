import { describe, expect, it } from 'vitest';
import { SyncScheduler } from '@triangulair/sync';

import { isOnline, networkWatcher, type NetReading } from './netState';
import { ownNote } from './problems';

describe('network status on phones (gap #4)', () => {
  it('is offline only on evidence', () => {
    expect(isOnline(null)).toBe(true);
    expect(isOnline({})).toBe(true);
    expect(isOnline({ isConnected: true, isInternetReachable: null })).toBe(true);
    expect(isOnline({ isConnected: true, isInternetReachable: true })).toBe(true);
    expect(isOnline({ isConnected: false, isInternetReachable: null })).toBe(false);
    expect(isOnline({ isConnected: true, isInternetReachable: false })).toBe(false);
  });

  it('reports the first reading, then changes, without repeats', async () => {
    let listener: ((s: NetReading) => void) | null = null;
    let removed = false;
    const watch = networkWatcher(
      (l) => {
        listener = l;
        return { remove: () => (removed = true) };
      },
      async () => ({ isConnected: false }),
    );
    const seen: boolean[] = [];
    const off = watch((v) => seen.push(v));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([false]);
    listener!({ isConnected: false });
    listener!({ isConnected: true, isInternetReachable: true });
    expect(seen).toEqual([false, true]);
    off();
    listener!({ isConnected: false });
    expect(seen).toEqual([false, true]);
    expect(removed).toBe(true);
  });

  it('drops a first reading that arrives after a change event', async () => {
    let listener: ((s: NetReading) => void) | null = null;
    let resolveFirst: (s: NetReading) => void = () => {};
    const watch = networkWatcher(
      (l) => {
        listener = l;
        return { remove: () => {} };
      },
      () => new Promise<NetReading>((r) => (resolveFirst = r)),
    );
    const seen: boolean[] = [];
    watch((v) => seen.push(v));
    listener!({ isConnected: true, isInternetReachable: true });
    resolveFirst({ isConnected: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([true]);
  });

  it('feeds the scheduler: "Offline · N changes pending"', async () => {
    const scheduler = new SyncScheduler({ run: async () => ({}) as never });
    let listener: ((s: NetReading) => void) | null = null;
    const watch = networkWatcher(
      (l) => {
        listener = l;
        return { remove: () => {} };
      },
      async () => ({ isConnected: true }),
    );
    watch((online) => scheduler.setOnline(online));
    listener!({ isConnected: false, isInternetReachable: false });
    scheduler.localChange();
    scheduler.localChange();
    scheduler.localChange();
    const status = scheduler.getStatus();
    expect(status.state).toBe('offline');
    expect(status.pending).toBe(3);
    expect(ownNote(status, true)).toMatchObject({ key: 'sync.note.offlinePending', params: { count: 3 } });
    listener!({ isConnected: true, isInternetReachable: true });
    expect(scheduler.getStatus().state).not.toBe('offline');
    scheduler.stop();
  });
});
