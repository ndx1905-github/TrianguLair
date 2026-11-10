/** The map of a list preview (before following it: its places are not in my database yet). */
import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import type { PlaceFeature } from '@triangulair/sync';

import Map from '../components/map/Map';
import type { CameraTarget } from '../components/map/types';
import { MapAttribution } from '../components/MapAttribution';
import { INITIAL_CENTER, INITIAL_ZOOM, MAP_STYLE_URL, MAP_STYLE_URL_DARK } from '../config';
import { useIsDark, useUiColors } from '../hooks/useUiColors';
import { fitCamera } from '../places/camera';
import { featurePins } from './sharing';

export function PreviewMap({ features, selectedId, onSelect }: { features: readonly PlaceFeature[]; selectedId?: string | null; onSelect?: (id: string | null) => void }) {
  const c = useUiColors();
  const dark = useIsDark();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const pins = useMemo(() => featurePins(features), [features]);
  const camera = useMemo<CameraTarget | null>(() => {
    if (size.width === 0) return null;
    const cam = fitCamera(pins.map((p) => ({ lat: p.lat, lon: p.lon })), {
      width: Math.max(80, size.width - 60),
      height: Math.max(80, size.height - 60),
      maxZoom: 15.5,
      fallback: { center: INITIAL_CENTER, zoom: INITIAL_ZOOM },
    });
    return { ...cam, key: Math.round(size.width) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, size.width > 0]);
  return (
    <View style={[styles.box, { borderColor: c.border, backgroundColor: c.surfaceAlt }]} onLayout={(e: LayoutChangeEvent) => setSize(e.nativeEvent.layout)} testID="preview-map">
      {size.width > 0 && camera && (
        <Map
          styleUrl={dark ? MAP_STYLE_URL_DARK : MAP_STYLE_URL}
          center={camera.center}
          zoom={camera.zoom}
          camera={camera}
          pins={pins}
          selectedPinId={selectedId ?? null}
          onPinPress={(id) => onSelect?.(id)}
          onMapPress={() => onSelect?.(null)}
        />
      )}
      <MapAttribution bottom={4} right={6} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { height: 260, borderRadius: 16, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
});
