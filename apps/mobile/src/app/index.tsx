import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FilterBar } from '../components/FilterBar';
import Map from '../components/map/Map';
import type { LatLon } from '../components/map/types';
import { MapAttribution } from '../components/MapAttribution';
import { PlaceSheet } from '../components/PlaceSheet';
import { INITIAL_CENTER, INITIAL_ZOOM, MAP_STYLE_URL, MAP_STYLE_URL_DARK } from '../config';
import { useLayout } from '../hooks/useLayout';
import { useIsDark, useUiColors } from '../hooks/useUiColors';
import { filterPlaces, toggleTag, usedTags } from '../places/filter';
import { fitCamera } from '../places/camera';
import { MOCK_PLACES } from '../places/mockPlaces';
import { placeToPin } from '../pins/fromPlace';
import { TAG_IDS, type TagId } from '../theme/tags';

export default function MapScreen() {
  const c = useUiColors();
  const dark = useIsDark();
  const insets = useSafeAreaInsets();
  const { gutter, width, height } = useLayout();

  const places = MOCK_PLACES;
  const [hidden, setHidden] = useState<ReadonlySet<TagId>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetCover, setSheetCover] = useState(0);
  // Initial camera fitting all places, computed once (resizing or folding the
  // window must not move the map). Vertical padding clears the filter bar.
  const [camera] = useState(() =>
    fitCamera(places, {
      width: Math.max(120, width - gutter * 4),
      height: Math.max(120, height - (insets.top + 200) * 2),
      maxZoom: 15,
      fallback: { center: INITIAL_CENTER, zoom: INITIAL_ZOOM },
    }),
  );

  const tags = useMemo(() => usedTags(places, TAG_IDS), [places]);
  const visible = useMemo(() => filterPlaces(places, hidden), [places, hidden]);
  const pins = useMemo(() => visible.map((p) => placeToPin(p, hidden)), [visible, hidden]);
  const selected = visible.find((p) => p.id === selectedId) ?? null;

  const onToggle = useCallback((t: TagId) => setHidden((h) => toggleTag(h, t)), []);
  const onLongPress = useCallback((at: LatLon) => {
    // Phase 0: placeholder for "add a place here".
    console.log('long press', at);
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Map
        styleUrl={dark ? MAP_STYLE_URL_DARK : MAP_STYLE_URL}
        center={camera.center}
        zoom={camera.zoom}
        pins={pins}
        selectedPinId={selected?.id}
        onPinPress={setSelectedId}
        onMapPress={() => setSelectedId(null)}
        onLongPress={onLongPress}
      />

      <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <FilterBar
          tags={tags}
          hidden={hidden}
          onToggle={onToggle}
          onShowAll={() => setHidden(new Set())}
          shownCount={visible.length}
          totalCount={places.length}
        />
      </View>

      <MapAttribution
        bottom={Math.max(sheetCover, insets.bottom) + 6}
        right={insets.right + gutter / 2}
      />

      <PlaceSheet place={selected} onClose={() => setSelectedId(null)} onCoverHeight={setSheetCover} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0 },
});
