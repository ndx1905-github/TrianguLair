/**
 * Derived, memoized views of the repository for the screens. Everything is
 * recomputed when the data version changes (after an edit).
 */
import { useMemo } from 'react';
import type { BBox, PlaceSource } from '@triangulair/data';

import { tagsByCategory } from '../pins/build';
import { placeFacts, toAppTag, type AppTag, type PlaceFacts } from '../places/model';
import { buildFriendTagIndex, type FriendTagIndex } from '../tags/friendTags';
import { foldText } from '../tags/text';
import { tagPath } from '../tags/tree';
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

/** Friends' tags mapped to mine (manually or by name) or kept with their author's color. */
export function useFriendTags(): FriendTagIndex {
  const { repo, version } = useData();
  const { tags } = useTags();
  return useMemo(
    () => buildFriendTagIndex(repo.friendTags(), tags, repo.tagMappings(), (id) => repo.getPerson(id)?.displayName || id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, version, tags],
  );
}

/** Facts of a place by id (cached for the current data version). */
export function useFactsLookup(): (placeId: string, friends?: boolean) => PlaceFacts | null {
  const { repo, version } = useData();
  const { tags, byId } = useTags();
  const friendTags = useFriendTags();
  return useMemo(() => {
    const cache = new Map<string, PlaceFacts | null>();
    const active = new Set(byId.keys());
    return (placeId: string, friends?: boolean) => {
      if (cache.has(placeId)) return cache.get(placeId)!;
      const place = repo.getPlace(placeId);
      let facts: PlaceFacts | null = null;
      if (place) {
        const mine = repo.getMySaveForPlace(placeId);
        const live = mine && mine.deletedAt === null ? mine : null;
        const others = friends === false && live ? [] : repo.savesForPlace(placeId).filter((s) => s.ownerId !== repo.meId && s.sharing !== 'private');
        const hasFriends = friends ?? others.length > 0;
        facts = placeFacts(place, live, hasFriends, active);
        if (!facts.mine) {
          // A friend's place takes my tags: through their tags (mapping, name), then its OSM category
          // (spec "Others' tags"); their other tags keep their author's color.
          const ft = friendTags.byPlace.get(placeId);
          const mapped = [...(ft?.mapped ?? []), ...tagsByCategory(facts.category, tags)].filter((id, i, all) => active.has(id) && all.indexOf(id) === i);
          const prices = others.map((s) => s.priceLevel).filter((x): x is NonNullable<typeof x> => x != null);
          const avg = prices.length ? (Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) as 1 | 2 | 3 | 4) : null;
          facts = { ...facts, tagIds: mapped, friendTags: ft?.unmapped ?? [], priceLevel: avg };
        }
        const words = [
          place.name,
          place.address ?? '',
          live?.comment ?? '',
          ...others.map((s) => (s.commentVisibility !== 'private' ? s.comment : '')),
          ...facts.tagIds.map((id) => tagPath(id, byId)),
          ...(facts.friendTags ?? []).map((t) => t.name),
          ...(facts.info?.cuisine ?? []),
        ];
        facts.searchText = foldText(words.join(' '));
      }
      cache.set(placeId, facts);
      return facts;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, version, tags, byId, friendTags]);
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
