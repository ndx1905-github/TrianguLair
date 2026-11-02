import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Camera, Map as MLMap, Marker, type CameraRef } from '@maplibre/maplibre-react-native';
import { SvgXml } from 'react-native-svg';

import { PIN_ANCHOR, PIN_VIEWBOX, pinScale, pinSvg } from '../../pins/pinSvg';
import { clusterBubbleSize, clusterColors } from './cluster';
import type { MapCluster, MapPin, MapViewProps } from './types';

/**
 * Native map: MapLibre React Native (requires a development build).
 *
 * Pins and cluster bubbles are `Marker` views (pins: an SVG through
 * react-native-svg), pixel-identical to web. Clustering is computed in JS on
 * the viewport's pins, so only a few dozen markers exist at a time. For large
 * datasets, move to a GeoJSONSource + SymbolLayer with pre-rendered images.
 */
/** Ignore a map press right after a pin press (both can fire on some platforms). */
const PIN_PRESS_GUARD_MS = 350;

function PinMarker({ pin, selected, onPress }: { pin: MapPin; selected: boolean; onPress: (id: string) => void }) {
  const scale = pinScale(pin, selected);
  const width = PIN_VIEWBOX.width * scale;
  const height = PIN_VIEWBOX.height * scale;
  const xml = useMemo(
    () => pinSvg({ colors: pin.colors, iconPath: pin.iconPath, faded: pin.faded, greyed: pin.greyed, maybeClosed: !!pin.maybeClosed }, { width, height }),
    [pin.colors, pin.iconPath, pin.faded, pin.greyed, pin.maybeClosed, width, height],
  );
  // Anchor "bottom" + offset so that the pin tip (not the view bottom) sits on the coordinate.
  const tipGap = height * (1 - PIN_ANCHOR.y);
  return (
    <Marker id={pin.id} lngLat={[pin.lon, pin.lat]} anchor="bottom" offset={[0, tipGap]} onPress={() => onPress(pin.id)}>
      <View style={{ width, height }} accessible accessibilityRole="button" accessibilityLabel={pin.label}>
        <SvgXml xml={xml} width={width} height={height} />
      </View>
    </Marker>
  );
}

function ClusterMarker({ cluster, onPress }: { cluster: MapCluster; onPress: (id: string) => void }) {
  const size = clusterBubbleSize(cluster.count);
  const { fill, text } = clusterColors(cluster.color);
  return (
    <Marker id={cluster.id} lngLat={[cluster.lon, cluster.lat]} anchor="center" onPress={() => onPress(cluster.id)}>
      <View
        style={[styles.cluster, { width: size, height: size, borderRadius: size / 2, backgroundColor: fill, opacity: cluster.color ? 1 : 0.75 }]}
        accessible
        accessibilityRole="button"
        accessibilityLabel={cluster.label}
      >
        <Text style={[styles.clusterText, { color: text }]} maxFontSizeMultiplier={1}>
          {cluster.count}
        </Text>
      </View>
    </Marker>
  );
}

export default function Map({
  styleUrl,
  center,
  zoom,
  camera,
  pins,
  clusters = [],
  selectedPinId,
  onPinPress,
  onClusterPress,
  onLongPress,
  onMapPress,
  onRegionChange,
  onUserMoveStart,
  style,
}: MapViewProps) {
  const lastPinPress = useRef(0);
  const cameraRef = useRef<CameraRef>(null);

  const handlePinPress = useCallback(
    (id: string) => {
      lastPinPress.current = Date.now();
      onPinPress?.(id);
    },
    [onPinPress],
  );
  const handleClusterPress = useCallback(
    (id: string) => {
      lastPinPress.current = Date.now();
      onClusterPress?.(id);
    },
    [onClusterPress],
  );

  const camKey = useRef<number | null>(null);
  useEffect(() => {
    if (!camera || camKey.current === camera.key) return;
    camKey.current = camera.key;
    cameraRef.current?.easeTo({ center: [camera.center.lon, camera.center.lat], zoom: camera.zoom, duration: 450 });
  }, [camera]);

  return (
    <View style={[styles.fill, style]}>
      <MLMap
        style={styles.fill}
        mapStyle={styleUrl}
        // Attribution is drawn by our own always-visible overlay (MapAttribution).
        attribution={false}
        logo={false}
        compass
        onPress={(e) => {
          if (Date.now() - lastPinPress.current < PIN_PRESS_GUARD_MS) return;
          const [lon, lat] = e.nativeEvent.lngLat;
          onMapPress?.({ lat, lon });
        }}
        onLongPress={(e) => {
          const [lon, lat] = e.nativeEvent.lngLat;
          onLongPress?.({ lat, lon });
        }}
        onRegionWillChange={(e) => {
          if (e.nativeEvent.userInteraction) onUserMoveStart?.();
        }}
        onRegionDidChange={(e) => {
          const { bounds, center: c, zoom: z } = e.nativeEvent;
          onRegionChange?.({ bbox: [bounds[0], bounds[1], bounds[2], bounds[3]], center: { lon: c[0], lat: c[1] }, zoom: z });
        }}
      >
        <Camera ref={cameraRef} initialViewState={{ center: [center.lon, center.lat], zoom }} />
        {clusters.map((c) => (
          <ClusterMarker key={c.id} cluster={c} onPress={handleClusterPress} />
        ))}
        {pins.map((pin) => (
          <PinMarker key={pin.id} pin={pin} selected={pin.id === selectedPinId} onPress={handlePinPress} />
        ))}
      </MLMap>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cluster: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2.5,
    borderColor: '#FFFFFF',
  },
  clusterText: { fontWeight: '700', fontSize: 14 },
});
