import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Map as GLMap, Marker as GLMarker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { PIN_ANCHOR, PIN_VIEWBOX, pinSvg } from '../../pins/pinSvg';
import type { MapPin, MapViewProps } from './types';

/**
 * Web map (testing only): MapLibre GL JS. Pins are HTML markers with the same
 * inline SVG as native. maplibre-gl is imported lazily so it never runs during
 * any server-side/static rendering.
 */
type MapLibreModule = typeof import('maplibre-gl');

const SELECTED_SCALE = 1.3;

function pinKey(pin: MapPin, selected: boolean): string {
  return [pin.lat, pin.lon, pin.colors.join(','), pin.iconPath.length, pin.faded, selected].join('|');
}

function makePinElement(pin: MapPin, selected: boolean, onPress: (id: string) => void): HTMLElement {
  const scale = selected ? SELECTED_SCALE : 1;
  const width = PIN_VIEWBOX.width * scale;
  const height = PIN_VIEWBOX.height * scale;
  const el = document.createElement('button');
  el.type = 'button';
  el.setAttribute('aria-label', pin.label);
  el.title = pin.label;
  el.dataset.pinId = pin.id;
  el.style.cssText =
    `width:${width}px;height:${height}px;padding:0;margin:0;border:0;background:none;` +
    `cursor:pointer;display:block;z-index:${selected ? 2 : 1}`;
  el.innerHTML = pinSvg(
    { colors: pin.colors, iconPath: pin.iconPath, faded: pin.faded },
    { width, height },
  );
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onPress(pin.id);
  });
  return el;
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<GLMap | null>(null);
  const libRef = useRef<MapLibreModule | null>(null);
  const markersRef = useRef(new globalThis.Map<string, { key: string; marker: GLMarker }>());
  const [ready, setReady] = useState(false);

  // Latest callbacks, so map listeners registered once always call the current props.
  const cb = useRef({ onPinPress, onLongPress, onMapPress });
  cb.current = { onPinPress, onLongPress, onMapPress };

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let map: GLMap | null = null;
    (async () => {
      const mod = (await import('maplibre-gl')) as MapLibreModule & { default?: MapLibreModule };
      const lib = mod.default ?? mod;
      if (cancelled || !containerRef.current) return;
      libRef.current = lib;
      map = new lib.Map({
        container: containerRef.current,
        style: styleUrl,
        center: [center.lon, center.lat],
        zoom,
        // Attribution is drawn by our own always-visible overlay (MapAttribution).
        attributionControl: false,
      });
      // Zoom buttons for mouse users on wide windows. Bottom-left: the filter
      // panel is top-left, the place side panel top-right, the attribution bottom-right.
      if (containerRef.current.clientWidth >= 600) {
        map.addControl(new lib.NavigationControl({ showCompass: true }), 'bottom-left');
      }
      map.on('click', (e) => cb.current.onMapPress?.({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
      // Right click on desktop, long press on touch screens.
      map.on('contextmenu', (e) =>
        cb.current.onLongPress?.({ lat: e.lngLat.lat, lon: e.lngLat.lng }),
      );
      mapRef.current = map;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      markersRef.current.forEach(({ marker }) => marker.remove());
      markersRef.current.clear();
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Style changes (e.g. dark mode).
  const styleRef = useRef(styleUrl);
  useEffect(() => {
    if (!ready || styleRef.current === styleUrl) return;
    styleRef.current = styleUrl;
    mapRef.current?.setStyle(styleUrl);
  }, [ready, styleUrl]);

  // Re-center when the center/zoom props change after creation.
  const camRef = useRef(`${center.lat},${center.lon},${zoom}`);
  useEffect(() => {
    const k = `${center.lat},${center.lon},${zoom}`;
    if (!ready || camRef.current === k) return;
    camRef.current = k;
    mapRef.current?.flyTo({ center: [center.lon, center.lat], zoom });
  }, [ready, center.lat, center.lon, zoom]);

  // Sync markers (diff by id + visual key).
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const markers = markersRef.current;
    const seen = new Set<string>();
    for (const pin of pins) {
      seen.add(pin.id);
      const selected = pin.id === selectedPinId;
      const key = pinKey(pin, selected);
      const existing = markers.get(pin.id);
      if (existing?.key === key) continue;
      existing?.marker.remove();
      const el = makePinElement(pin, selected, (id) => cb.current.onPinPress?.(id));
      const height = PIN_VIEWBOX.height * (selected ? SELECTED_SCALE : 1);
      const marker = new lib.Marker({
        element: el,
        anchor: 'bottom',
        offset: [0, height * (1 - PIN_ANCHOR.y)],
      })
        .setLngLat([pin.lon, pin.lat])
        .addTo(map);
      markers.set(pin.id, { key, marker });
    }
    for (const [id, { marker }] of markers) {
      if (!seen.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }
  }, [ready, pins, selectedPinId]);

  return (
    <View style={[styles.fill, style]}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} data-testid="map" />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
});
