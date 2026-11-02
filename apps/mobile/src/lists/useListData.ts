/**
 * Repository reads for the list screens, memoized per data version.
 */
import { useMemo } from 'react';
import type { FilterSubject, ListRecord, PlaceRecord, SaveRecord } from '@triangulair/data';

import { useData } from '../data/DataProvider';

export interface MyPlace {
  place: PlaceRecord;
  save: SaveRecord;
  subject: FilterSubject;
}

/** All my saves (not in the trash), with their place, by name. */
export function useMyPlaces(): MyPlace[] {
  const { repo, version } = useData();
  return useMemo(() => {
    const out: MyPlace[] = [];
    for (const hit of repo.queryPlaces({ source: 'mine', sort: 'name', limit: 5000 })) {
      const place = repo.getPlace(hit.id);
      const save = repo.getMySaveForPlace(hit.id);
      if (!place || !save) continue;
      out.push({ place, save, subject: { save, place } });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, version]);
}

export function useLists(): ListRecord[] {
  const { repo, version } = useData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => repo.lists().sort((a, b) => a.name.localeCompare(b.name)), [repo, version]);
}

/** Place ids of a list's items (save ids are `<owner>|<place id>`). */
export function useListPlaceIds(listId: string | null): string[] {
  const { repo, version } = useData();
  return useMemo(() => {
    if (!listId) return [];
    return repo
      .listItems(listId)
      .map((sid) => repo.getSave(sid)?.placeId)
      .filter((x): x is string => !!x);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, version, listId]);
}
