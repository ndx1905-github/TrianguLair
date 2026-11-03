import { useMemo } from 'react';
import type { PlaceRecord } from '@triangulair/data';

import { useData } from '../data/DataProvider';

/** Zones among the given place ids (cached per data version). */
export function useZonePlaces(ids: readonly string[]): Map<string, PlaceRecord> {
  const { repo, version } = useData();
  const key = ids.join(',');
  return useMemo(() => {
    const out = new Map<string, PlaceRecord>();
    for (const id of ids) {
      const p = repo.getPlace(id);
      if (p && p.kind === 'zone' && p.geometry.type !== 'Point') out.set(id, p);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, version, key]);
}
