/**
 * Derived, memoized views of the repository for the screens. Everything is
 * recomputed when the data version changes (after an edit).
 */
import { useMemo } from 'react';
import type { BBox, PlaceSource } from '@triangulair/data';

import { tagsByCategory } from '../pins/build';
import { placeFacts, toAppTag, type AppTag, type PlaceFacts } from '../places/model';
import { useData } from './DataProvider';

export interface TagIndex {
  /** Active tags (not in the trash), by name. */
  tags: AppTag[];
  byId: Map<string, AppTag>;
}

export function useTags(): TagIndex {
  const { repo, version } = useData();
  return useMemo(() => {
    const tags = repo
      .tags()
      .filter((t) => t.active)
      .map(toAppTag);
    return { tags, byId: new Map(tags.map((t) => [t.id, t])) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, version]);
}

/** Facts of a place by id (cached for the current data version). */
export function useFactsLookup(): (placeId: string, friends?: boolean) => PlaceFacts | null {
  const { repo, version } = useData();
  const { tags, byId } = useTags();
  return useMemo(() => {
    const cache = new Map<string, PlaceFacts | null>();
    const active = new Set(byId.keys());
    return (placeId: string, friends?: boolean) => {
      if (cache.has(placeId)) return cache.get(placeId)!;
      const place = repo.getPlace(placeId);
      let facts: PlaceFacts | null = null;
      if (place) {
        const mine = repo.getMySaveForPlace(placeId);
        const hasFriends = friends ?? repo.savesForPlace(placeId).some((s) => s.ownerId !== repo.meId && s.sharing !== 'private');
        facts = placeFacts(place, mine && mine.deletedAt === null ? mine : null, hasFriends, active);
        // A friend's place takes my tags linked to its category (spec "Others' tags").
        if (!facts.mine) facts = { ...facts, tagIds: tagsByCategory(facts.category, tags) };
      }
      cache.set(placeId, facts);
      return facts;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, version, tags, byId]);
}

/** Places in a viewport (Repository.mapPins), with their facts. */
export function useViewportFacts(bbox: BBox | null, source: PlaceSource = 'all'): PlaceFacts[] {
  const { repo, version } = useData();
  const lookup = useFactsLookup();
  const key = bbox ? bbox.map((n) => n.toFixed(5)).join(',') : '';
  return useMemo(() => {
    if (!bbox) return [];
    const out: PlaceFacts[] = [];
    for (const pin of repo.mapPins(bbox, source)) {
      const f = lookup(pin.id, pin.friends);
      if (f) out.push(f);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, version, key, source, lookup]);
}
