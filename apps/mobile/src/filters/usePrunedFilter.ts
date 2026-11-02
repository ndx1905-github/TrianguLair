/**
 * Keeps the remembered filter valid: tags deleted since (or friends' tags no
 * longer received) are dropped, so the summary never shows a filter that
 * matches nothing and cannot be explained.
 */
import { useEffect } from 'react';

import { useFriendTags, useTags } from '../data/usePlaces';
import { useAppState } from '../state/AppState';
import { pruneUnknownTags } from './storage';

export function usePrunedFilter(): void {
  const { byId } = useTags();
  const friendTags = useFriendTags();
  const { filter, setFilter } = useAppState();
  useEffect(() => {
    const keys = new Set(friendTags.entries.filter((e) => !e.match).map((e) => e.key));
    const next = pruneUnknownTags(filter, new Set(byId.keys()), keys);
    if (next !== filter) setFilter(next);
  }, [byId, friendTags, filter, setFilter]);
}
