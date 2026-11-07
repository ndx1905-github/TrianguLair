/** Pull to refresh (spec "Synchronization and background": on demand): one sync pass now. */
import { useCallback, useState } from 'react';

import { useMaybeSync } from './SyncProvider';

export function usePullToRefresh(): { refreshing: boolean; onRefresh: () => void } {
  const sync = useMaybeSync();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    if (!sync) return;
    setRefreshing(true);
    sync
      .refresh()
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, [sync]);
  return { refreshing, onRefresh };
}
