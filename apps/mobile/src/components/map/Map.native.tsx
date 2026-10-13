import { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Camera, Map as MLMap, Marker } from '@maplibre/maplibre-react-native';
import { SvgXml } from 'react-native-svg';

import { PIN_ANCHOR, PIN_VIEWBOX, pinSvg } from '../../pins/pinSvg';
import type { MapPin, MapViewProps } from './types';

/**
 * Native map: MapLibre React Native (requires a development build).
 *
 * Phase 0 renders pins as `Marker` views containing an SVG (react-native-svg).
 * Simple and pixel-identical to web, fine for tens/low hundreds of pins.
 * For large datasets, switch to a GeoJSONSource + SymbolLayer with pre-rendered
 * pin images (one image per color/icon combination) and clustering.
 */
const PIN_SCALE = 1;
const SELECTED_SCALE = 1.3;
/** Ignore a map press right after a pin press (both can fire on some platforms). */
const PIN_PRESS_GUARD_MS = 350;

function PinMarker({
  pin,
  selected,
  onPress,
}: {
  pin: MapPin;
  selected: boolean;
  onPress: (id: string) => void;
}) {
  const scale = selected ? SELECTED_SCALE : PIN_SCALE;
  const width = PIN_VIEWBOX.width * scale;
  const height = PIN_VIEWBOX.height * scale;
  const xml = useMemo(
    () => pinSvg({ colors: pin.colors, iconPath: pin.iconPath, faded: pin.faded }, { width, height }),
    [pin.colors, pin.iconPath, pin.faded, width, height],
  );
  // Anchor "bottom" + offset so that the pin tip (not the view bottom) sits on the coordinate.
  const tipGap = height * (1 - PIN_ANCHOR.y);
  return (
    <Marker
      id={pin.id}
      lngLat={[pin.lon, pin.lat]}
      anchor="bottom"
      offset={[0, tipGap]}
      onPress={() => onPress(pin.id)}
    >
      <View
        style={{ width, height }}
        accessible
        accessibilityRole="button"
        accessibilityLabel={pin.label}
      >
        <SvgXml xml={xml} width={width} height={height} />
      </View>
    </Marker>
  );
}

export default function Map({
  styleUrl,
  center,
  zoom,
  pins,
  selectedPinId,
  onPinPress,
  onLongPress,
  onMapPress,
  style,
}: MapViewProps) {
  const lastPinPress = useRef(0);

  const handlePinPress = useCallback(
    (id: string) => {
      lastPinPress.current = Date.now();
      onPinPress?.(id);
    },
    [onPinPress],
  );

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
      >
        <Camera initialViewState={{ center: [center.lon, center.lat], zoom }} />
        {pins.map((pin) => (
          <PinMarker
            key={pin.id}
            pin={pin}
            selected={pin.id === selectedPinId}
            onPress={handlePinPress}
          />
        ))}
      </MLMap>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
