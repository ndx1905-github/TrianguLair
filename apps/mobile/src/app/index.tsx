import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BBox } from '@triangulair/data';

import { ClosureNotice } from '../components/ClosureNotice';
import { FilterBar } from '../components/FilterBar';
import Map from '../components/map/Map';
import type { CameraTarget, LatLon, MapRegion } from '../components/map/types';
import { MapAttribution } from '../components/MapAttribution';
import { PlaceSheet } from '../components/PlaceSheet';
import { DataGate } from '../components/DataGate';
import { TrashUndo } from '../components/TrashUndo';
import { Banner } from '../components/ui';
import { INITIAL_CENTER, INITIAL_ZOOM, MAP_STYLE_URL, MAP_STYLE_URL_DARK, OSM_FIXTURES } from '../config';
import { useData } from '../data/DataProvider';
import { getSetting, setSetting } from '../data/deviceSettings';
import { useReadyIdentity } from '../identity/IdentityProvider';
import { ProtectCard } from '../identity/ProtectCard';
import { protectState } from '../identity/protect';
import { useTags, useViewportFacts } from '../data/usePlaces';
import { usePrunedFilter } from '../filters/usePrunedFilter';
import { useLayout } from '../hooks/useLayout';
import { useIsDark, useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { buildPin, pinClusterColor, toMapCluster } from '../pins/build';
import { fitCamera } from '../places/camera';
import { clusterPins, expansionZoom } from '../places/clustering';
import { EMPTY_FILTER, expandTagSelection, isFilterActive, matchPlace, summarize } from '../places/filters';
import { useClosureCheck } from '../closure/useClosureCheck';
import { useAppState } from '../state/AppState';
import { MapShortcuts } from '../zones/MapShortcuts';
import { useZonePlaces } from '../zones/useZonePlaces';
import { zoneShapes } from '../zones/zoneLayer';

/** Places are loaded for the visible area plus this margin on each side. */
const VIEWPORT_MARGIN = 0.25;

function padBBox(b: MapRegion['bbox'], f: number): BBox {
  const [w, s, e, n] = b;
  const dx = (e - w) * f;
  const dy = (n - s) * f;
  return [Math.max(-180, w - dx), Math.max(-85, s - dy), Math.min(180, e + dx), Math.min(85, n + dy)];
}

/** Where the location step of the first launch found me (kept on the device), if anywhere. */
function startPosition(): LatLon | null {
  try {
    const p = JSON.parse(getSetting('start-position') ?? 'null') as LatLon | null;
    return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
  } catch {
    return null;
  }
}

function MapScreen() {
  const c = useUiColors();
  const dark = useIsDark();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, region: country } = useI18n();
  const { gutter, width, height, wide, sheetWidth } = useLayout();
  const { repo, persistence, version } = useData();
  const identity = useReadyIdentity();
  const [snoozedAt, setSnoozedAt] = useState(() => Number(getSetting('protect-snoozed')) || null);
  const [hintAdd, setHintAdd] = useState(() => getSetting('hint-add') !== 'seen');
  const dismissHint = () => {
    setSetting('hint-add', 'seen');
    setHintAdd(false);
  };
  const { tags, byId } = useTags();
  const { filter, setFilter, region, setRegion, filterOpen, setFilterOpen, focus } = useAppState();
  usePrunedFilter();
  const closure = useClosureCheck();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Moving the map folds the bar (spec); the remembered state stays the user's own choice.
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const barOpen = filterOpen && !autoCollapsed;
  const onBarOpenChange = useCallback(
    (open: boolean) => {
      setAutoCollapsed(false);
      setFilterOpen(open);
    },
    [setFilterOpen],
  );
  const [sheetCover, setSheetCover] = useState(0);
  // The buttons sit above the attribution, which wraps with large text.
  const [attribHeight, setAttribHeight] = useState(18);
  const actionsBottom = Math.max(sheetCover, insets.bottom) + 6 + attribHeight + 4;
  const [camera, setCamera] = useState<CameraTarget | null>(null);

  // Initial camera: the last visible area, or one fitting all my places (computed once).
  const [initial] = useState(() => {
    if (region) return { center: region.center, zoom: region.zoom };
    const points = repo.queryPlaces({ source: 'mine', limit: 5000 }).map((p) => ({ lat: p.lat, lon: p.lon }));
    const here = startPosition();
    return fitCamera(points, {
      width: Math.max(120, width - gutter * 4),
      height: Math.max(120, height - (insets.top + 200) * 2),
      maxZoom: 15,
      fallback: here ? { center: here, zoom: 14 } : { center: INITIAL_CENTER, zoom: INITIAL_ZOOM },
    });
  });

  // Select and show a place asked for by another screen (after adding it, "show on map").
  useEffect(() => {
    if (!focus) return;
    const p = repo.getPlace(focus.placeId);
    if (!p) return;
    setSelectedId(p.id);
    setCamera({ center: { lat: p.lat, lon: p.lon }, zoom: Math.max(region?.zoom ?? 0, 16), key: focus.key });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);

  const bbox = useMemo(() => (region ? padBBox(region.bbox, VIEWPORT_MARGIN) : null), [region]);
  const facts = useViewportFacts(bbox);
  const zones = useZonePlaces(useMemo(() => facts.map((f) => f.id), [facts]));
  const filterActive = isFilterActive(filter);
  const now = useMemo(() => new Date(), [facts, filter]); // re-evaluated with the data or the filter
  const summary = useMemo(() => summarize(facts, filter, tags, now, country), [facts, filter, tags, now, country]);

  const { pins, clusters, shapes } = useMemo(() => {
    const ctx = { tagSet: expandTagSelection(filter.tagIds, tags), now, ...(country ? { country } : {}) };
    const all = facts.flatMap((f) => {
      const match = matchPlace(f, filter, ctx);
      // Closed places stay in my places but leave the map (unless the "Closed" status is chosen).
      if (match === 'hidden') return [];
      return [{
        ...buildPin({ facts: f, match }, filter, tags, byId, filterActive),
        // Zones get a square badge and are not clustered (their shape is drawn anyway).
        ...(zones.has(f.id) ? { badge: true } : {}),
      }];
    });
    const selected = all.filter((p) => p.id === selectedId);
    const badges = all.filter((p) => p.badge && p.id !== selectedId);
    const rest = all.filter((p) => p.id !== selectedId && !p.badge).map((p) => ({ ...p, color: pinClusterColor(p) }));
    const res = clusterPins(rest, { zoom: region?.zoom ?? initial.zoom });
    return {
      pins: [...badges, ...res.singles, ...selected],
      clusters: res.clusters,
      shapes: zoneShapes([...zones.values()], new globalThis.Map(all.map((p) => [p.id, p])), selectedId),
    };
  }, [facts, zones, filter, tags, byId, filterActive, selectedId, region?.zoom, initial.zoom, now, country]);

  const mapClusters = useMemo(
    () => clusters.map((cl) => toMapCluster(cl, t('map.cluster', { count: cl.count }))),
    [clusters, t],
  );

  const onClusterPress = useCallback(
    (id: string) => {
      const cl = clusters.find((x) => x.id === id);
      if (!cl) return;
      const z = expansionZoom(cl, region?.zoom ?? initial.zoom, { width, height });
      setCamera({ center: { lat: cl.lat, lon: cl.lon }, zoom: z, key: Date.now() });
    },
    [clusters, region?.zoom, initial.zoom, width, height],
  );

  const onLongPress = useCallback(
    (at: LatLon) => router.push({ pathname: '/add', params: { lat: String(at.lat), lon: String(at.lon), manual: '1' } }),
    [router],
  );

  const myPlaces = useMemo(() => repo.queryPlaces({ source: 'mine', limit: 5000 }).length, [repo, version]);
  const protect = protectState({
    kitSaved: !identity.kitPending,
    myPlaces,
    createdAt: identity.record.createdAt,
    now: Date.now(),
    snoozedAt,
  });

  const openAdd = () => {
    if (hintAdd) dismissHint();
    const center = region?.center ?? initial.center;
    router.push({ pathname: '/add', params: { lat: String(center.lat), lon: String(center.lon) } });
  };

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Map
        styleUrl={dark ? MAP_STYLE_URL_DARK : MAP_STYLE_URL}
        center={initial.center}
        zoom={initial.zoom}
        camera={camera}
        pins={pins}
        clusters={mapClusters}
        selectedPinId={selectedId}
        onPinPress={setSelectedId}
        onClusterPress={onClusterPress}
        onMapPress={() => setSelectedId(null)}
        onLongPress={onLongPress}
        onRegionChange={setRegion}
        onUserMoveStart={() => filterOpen && setAutoCollapsed(true)}
        shapes={shapes}
        onShapePress={setSelectedId}
      />

      <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <FilterBar
          summary={summary}
          filter={filter}
          onChange={setFilter}
          open={barOpen}
          onOpenChange={onBarOpenChange}
          tags={tags}
          personName={(id) => repo.getPerson(id)?.displayName || id}
          onManageTags={() => router.push('/tags')}
          onSettings={() => router.push('/settings')}
          settingsBadge={protect !== 'none'}
          maxHeight={Math.max(200, Math.round(height * (wide ? 0.6 : 0.5)))}
        />
        {closure.notice && (
          <View style={{ marginHorizontal: gutter, marginTop: 8, maxWidth: wide ? 460 : undefined }}>
            <ClosureNotice
              places={closure.notice.places}
              onReview={() => {
                closure.dismiss();
                setFilter({ ...EMPTY_FILTER, placeStatuses: ['maybe_closed'] });
                onBarOpenChange(false);
              }}
              onLater={closure.dismiss}
            />
          </View>
        )}
        {protect === 'card' && !closure.notice && (
          <View style={{ marginHorizontal: gutter, marginTop: 8, maxWidth: wide ? 460 : undefined }}>
            <ProtectCard
              onLater={() => {
                const now = Date.now();
                setSetting('protect-snoozed', String(now));
                setSnoozedAt(now);
              }}
            />
          </View>
        )}
        {(persistence === 'memory' || OSM_FIXTURES) && (
          <View style={{ marginHorizontal: gutter, marginTop: 8, alignSelf: 'flex-start' }} pointerEvents="none">
            {persistence === 'memory' ? <Banner tone="warning">{t('data.memoryOnly')}</Banner> : <Banner>{t('osm.fixtureShort')}</Banner>}
          </View>
        )}
        <View style={{ marginHorizontal: gutter, marginTop: 8, alignSelf: 'flex-start' }}>
          <TrashUndo />
        </View>
      </View>

      <View
        style={[
          styles.actions,
          {
            bottom: actionsBottom,
            // Wide windows: clear the zoom buttons (bottom-left) and the side panel (right).
            left: insets.left + gutter + (wide ? 52 : 0),
            right: insets.right + gutter + (wide && selectedId ? sheetWidth + gutter : 0),
          },
        ]}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={() => router.push('/list')}
          style={[styles.listButton, { backgroundColor: c.surface, borderColor: c.border, shadowColor: c.shadow }]}
          accessibilityRole="button"
          accessibilityLabel={t('nav.listA11y')}
          testID="open-list"
        >
          <Text style={[styles.listText, { color: c.text }]} maxFontSizeMultiplier={2}>
            ☰ {t('nav.list')}
          </Text>
        </Pressable>
        <MapShortcuts />
        <Pressable
          onPress={openAdd}
          style={[styles.fab, { backgroundColor: c.accent, shadowColor: c.shadow }]}
          accessibilityRole="button"
          accessibilityLabel={t('nav.addA11y')}
          testID="open-add"
        >
          <Text style={styles.fabText} maxFontSizeMultiplier={1.4}>
            +
          </Text>
        </Pressable>
      </View>

      {hintAdd && !selectedId && (
        <View
          style={[styles.hint, { bottom: actionsBottom + 70, right: insets.right + gutter, backgroundColor: c.text, shadowColor: c.shadow }]}
          testID="hint-add"
          accessibilityLiveRegion="polite"
        >
          <Text style={{ color: c.background, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
            {t('hint.add')}
          </Text>
          <Pressable onPress={dismissHint} accessibilityRole="button" hitSlop={8} style={styles.hintButton} testID="hint-dismiss">
            <Text style={{ color: c.background, fontSize: 14, fontWeight: '700', textDecorationLine: 'underline' }} maxFontSizeMultiplier={2}>
              {t('hint.dismiss')}
            </Text>
          </Pressable>
          <View style={[styles.hintTip, { borderTopColor: c.text }]} />
        </View>
      )}

      <MapAttribution bottom={Math.max(sheetCover, insets.bottom) + 6} right={insets.right + gutter / 2} onHeight={setAttribHeight} />

      <PlaceSheet placeId={selectedId} onClose={() => setSelectedId(null)} onCoverHeight={setSheetCover} />
    </View>
  );
}

export default function MapRoute() {
  return (
    <DataGate>
      <MapScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0 },
  actions: { position: 'absolute', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  listButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  listText: { fontSize: 15, fontWeight: '700' },
  fab: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  hint: {
    position: 'absolute',
    maxWidth: 280,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 6,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  hintButton: { alignSelf: 'flex-end', minHeight: 32, justifyContent: 'center' },
  hintTip: {
    position: 'absolute',
    bottom: -8,
    right: 21,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderTopWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  fabText: { color: '#FFFFFF', fontSize: 32, fontWeight: '400', marginTop: -2 },
});
