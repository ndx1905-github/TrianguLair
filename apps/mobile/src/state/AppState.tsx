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
import { getSelection, migrateFriendsOnly, setSelection } from '../sync/friendsSelection';

/**
 * The remembered filter. Its old "Friends' places" visibility moved to "Whose places" (my places
 * hidden): done once, when the filter is read.
 */
function initialFilter(): FilterState {
  const f = parseFilter(getSetting(FILTER_SETTING_KEY));
  const moved = migrateFriendsOnly(f.visibility, getSelection());
  if (!moved) return f;
  const next = { ...f };
  if (moved.visibility.length) next.visibility = moved.visibility;
  else delete next.visibility;
  setSelection(moved.selection);
  setSetting(FILTER_SETTING_KEY, serializeFilter(next));
  return next;
}

export interface Trashed {
  placeId: string;
  name: string;
  placeIds?: string[];
}

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
  /**
   * The place I last moved to the trash, offered for undo on the map and the list; `placeIds` when
   * the list's "Select" mode moved several at once (`placeId` is then the first of them).
   */
  trashed: (Trashed & { key: number }) | null;
  setTrashed: (t: Trashed | null) => void;
  /** What's new "See on the map": these places stay in color, the others are faded. */
  highlight: { placeIds: string[]; key: number } | null;
  setHighlight: (placeIds: string[] | null) => void;
}

const Ctx = createContext<AppUiState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [filter, setFilterState] = useState<FilterState>(initialFilter);
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
  const [trashed, setTrashedState] = useState<AppUiState['trashed']>(null);
  const setTrashed = useCallback(
    (t: Trashed | null) => setTrashedState(t ? { ...t, key: Date.now() } : null),
    [],
  );
  const [highlight, setHighlightState] = useState<AppUiState['highlight']>(null);
  const setHighlight = useCallback((placeIds: string[] | null) => setHighlightState(placeIds ? { placeIds, key: Date.now() } : null), []);
  const value = useMemo(
    () => ({ filter, setFilter, region, setRegion, filterOpen, setFilterOpen, focus, focusPlace, trashed, setTrashed, highlight, setHighlight }),
    [filter, setFilter, region, filterOpen, setFilterOpen, focus, focusPlace, trashed, setTrashed, highlight, setHighlight],
  );
  return createElement(Ctx.Provider, { value }, children);
}

export function useAppState(): AppUiState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppState() outside AppStateProvider');
  return v;
}
