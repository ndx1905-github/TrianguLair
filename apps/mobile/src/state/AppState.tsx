/**
 * UI state shared by the map, the list and the add screen: the filter (one
 * filter bar for map and list, spec "Filter bar"), the last visible map area
 * (center of the add screen, distances in the list) and whether the filter
 * bar is expanded. The filter and the expanded state are remembered on this
 * device (`filters/storage.ts`).
 */
import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import type { MapRegion } from '../components/map/types';
import { getSetting, setSetting } from '../data/deviceSettings';
import { FILTER_SETTING_KEY, parseFilter, serializeFilter } from '../filters/storage';
import type { FilterState } from '../places/filters';

export interface AppUiState {
  filter: FilterState;
  setFilter: (f: FilterState | ((f: FilterState) => FilterState)) => void;
  region: MapRegion | null;
  setRegion: (r: MapRegion) => void;
  filterOpen: boolean;
  setFilterOpen: (open: boolean) => void;
  /** A place the map should select and show (after adding it, "show on map"). */
  focus: { placeId: string; key: number } | null;
  focusPlace: (placeId: string) => void;
}

const Ctx = createContext<AppUiState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [filter, setFilterState] = useState<FilterState>(() => parseFilter(getSetting(FILTER_SETTING_KEY)));
  const setFilter = useCallback((next: FilterState | ((f: FilterState) => FilterState)) => {
    setFilterState((prev) => {
      const f = typeof next === 'function' ? next(prev) : next;
      if (f !== prev) setSetting(FILTER_SETTING_KEY, serializeFilter(f));
      return f;
    });
  }, []);
  const [region, setRegion] = useState<MapRegion | null>(null);
  const [filterOpen, setOpen] = useState(() => getSetting('filters-open') !== '0');
  const setFilterOpen = useCallback((open: boolean) => {
    setOpen(open);
    setSetting('filters-open', open ? '1' : '0');
  }, []);
  const [focus, setFocus] = useState<AppUiState['focus']>(null);
  const focusPlace = useCallback((placeId: string) => setFocus({ placeId, key: Date.now() }), []);
  const value = useMemo(
    () => ({ filter, setFilter, region, setRegion, filterOpen, setFilterOpen, focus, focusPlace }),
    [filter, setFilter, region, filterOpen, setFilterOpen, focus, focusPlace],
  );
  return createElement(Ctx.Provider, { value }, children);
}

export function useAppState(): AppUiState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppState() outside AppStateProvider');
  return v;
}
