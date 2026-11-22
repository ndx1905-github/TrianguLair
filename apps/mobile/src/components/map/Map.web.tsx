import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Map as GLMap, Marker as GLMarker, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { PIN_VIEWBOX, pinLayout, pinScale, pinSvg } from '../../pins/pinSvg';
import { BADGE_VIEWBOX, badgeSvg } from '../../zones/badgeSvg';
import { PRESSABLE_LAYERS, SHAPE_LAYERS, SHAPES_SOURCE, shapesToGeoJSON } from '../../zones/shapes';
import { BaseMapFallback, specKey, type BaseMapStatus, type BaseMapStyle } from './baseMap';
import { clusterBubbleSize, clusterColors } from './cluster';
import type { MapCluster, MapPin, MapRegion, MapViewProps } from './types';

/**
 * Web map (testing only): MapLibre GL JS. Pins and cluster bubbles are HTML
 * markers; pins use the same inline SVG as native. maplibre-gl is imported
 * lazily so it never runs during any server-side/static rendering.
 *
 * maplibre-gl 6 is ESM only (no default export) and loads its worker from a
 * file of its own, which Metro does not bundle: scripts/maplibre-worker.mjs
 * copies it into public/, served at the root of the site.
 *
 * Base map fallback (baseMap.ts): an error loading the style, its TileJSON or a run of its tiles
 * switches to the next configured address, then to a built-in blank style.
 */
type MapLibreModule = typeof import('maplibre-gl');

function workerUrl(lib: MapLibreModule): string {
  // The version keeps a browser from reusing the worker of another maplibre-gl (as maplibre-gl does).
  return `${process.env.EXPO_BASE_URL ?? ''}/maplibre-gl-worker.js?v=${lib.getVersion()}`;
}

function glStyle(s: BaseMapStyle): string | StyleSpecification {
  return s as string | StyleSpecification;
}

function pinKey(pin: MapPin, selected: boolean): string {
  const dots = pin.dots ? `${pin.dots.colors.join(',')}+${pin.dots.more}` : '';
  return [pin.lat, pin.lon, pin.colors.join(','), pin.iconPath.length, pin.faded, pin.greyed, !!pin.maybeClosed, pin.badge, dots, pin.label, selected].join('|');
}

function clusterKey(c: MapCluster): string {
  return [c.lat, c.lon, c.count, c.color].join('|');
}

/** Size of the marker element and its offset from the bottom-centre anchor (the tip on the point). */
function pinBox(pin: MapPin, selected: boolean): { width: number; height: number; offset: [number, number] } {
  const scale = pinScale(pin, selected);
  if (pin.badge) return { width: BADGE_VIEWBOX.width * scale, height: BADGE_VIEWBOX.height * scale, offset: [0, 0] };
  return pinLayout({ dots: pin.dots ?? null, maybeClosed: !!pin.maybeClosed }, scale);
}

function makePinElement(pin: MapPin, selected: boolean, onPress: (id: string) => void): HTMLElement {
  const scale = pinScale(pin, selected);
  const { width, height } = pinBox(pin, selected);
  const el = document.createElement('button');
  el.type = 'button';
  el.setAttribute('aria-label', pin.label);
  el.title = pin.label;
  el.dataset.pinId = pin.id;
  if (pin.greyed) el.dataset.greyed = '1';
  if (pin.badge) el.dataset.badge = '1';
  if (pin.dots) el.dataset.dots = `${pin.dots.colors.length + pin.dots.more}`;
  el.style.cssText =
    `width:${width}px;height:${height}px;padding:0;margin:0;border:0;background:none;` +
    `cursor:pointer;display:block;z-index:${selected ? 3 : pin.greyed ? 0 : 1}`;
  const spec = { colors: pin.colors, iconPath: pin.iconPath, faded: pin.faded, greyed: pin.greyed, maybeClosed: !!pin.maybeClosed, dots: pin.dots ?? null };
  el.innerHTML = pin.badge ? badgeSvg(spec, { width, height }) : pinSvg(spec, { width: PIN_VIEWBOX.width * scale, height: PIN_VIEWBOX.height * scale });
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onPress(pin.id);
  });
  return el;
}

function makeClusterElement(c: MapCluster, onPress: (id: string) => void): HTMLElement {
  const size = clusterBubbleSize(c.count);
  const { fill, text } = clusterColors(c.color);
  const el = document.createElement('button');
  el.type = 'button';
  el.setAttribute('aria-label', c.label);
  el.title = c.label;
  el.dataset.clusterId = c.id;
  el.style.cssText =
    `width:${size}px;height:${size}px;border-radius:50%;border:2.5px solid #fff;` +
    `box-shadow:0 0 0 1px rgba(15,23,42,0.35),0 2px 6px rgba(0,0,0,0.25);background:${fill};` +
    `color:${text};font:700 ${size > 40 ? 15 : 13}px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2;` +
    `display:flex;align-items:center;justify-content:center;opacity:${c.color ? 1 : 0.75}`;
  el.textContent = String(c.count);
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onPress(c.id);
  });
  return el;
}

function regionOf(map: GLMap): MapRegion {
  const b = map.getBounds();
  const c = map.getCenter();
  return {
    bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    center: { lat: c.lat, lon: c.lng },
    zoom: map.getZoom(),
  };
}

export default function Map({
  baseMap,
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
  shapes = [],
  onShapePress,
  style,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<GLMap | null>(null);
  const libRef = useRef<MapLibreModule | null>(null);
  const markersRef = useRef(new globalThis.Map<string, { key: string; marker: GLMarker }>());
  const clusterMarkersRef = useRef(new globalThis.Map<string, { key: string; marker: GLMarker }>());
  const [ready, setReady] = useState(false);
  // Base map addresses to try (the fallback of the current theme).
  const fallbackRef = useRef<BaseMapFallback | null>(null);
  fallbackRef.current ??= new BaseMapFallback(baseMap);
  const [baseStatus, setBaseStatus] = useState<BaseMapStatus>(fallbackRef.current.status());

  // Latest callbacks, so map listeners registered once always call the current props.
  const cb = useRef({ onPinPress, onLongPress, onMapPress, onRegionChange, onClusterPress, onUserMoveStart, onShapePress });
  cb.current = { onPinPress, onLongPress, onMapPress, onRegionChange, onClusterPress, onUserMoveStart, onShapePress };
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let map: GLMap | null = null;
    (async () => {
      const lib: MapLibreModule = await import('maplibre-gl');
      if (cancelled || !containerRef.current) return;
      libRef.current = lib;
      if (!lib.getWorkerUrl()) lib.setWorkerUrl(workerUrl(lib));
      map = new lib.Map({
        container: containerRef.current,
        style: glStyle(fallbackRef.current!.current()),
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
      map.on('click', (e) => {
        // A pressable shape (zone, candidate neighbourhood or street) takes the tap.
        const m = map!;
        const layers = PRESSABLE_LAYERS.filter((id) => m.getLayer(id));
        const hit = layers.length
          ? m.queryRenderedFeatures(e.point, { layers }).find((f) => f.properties?.press === 1)
          : undefined;
        if (hit && cb.current.onShapePress) {
          cb.current.onShapePress(String(hit.properties!.id));
          return;
        }
        cb.current.onMapPress?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      });
      // Zones and drafts: one GeoJSON source, added again after every style change (dark mode).
      const addShapes = () => {
        const m = map!;
        if (!m.getSource(SHAPES_SOURCE)) m.addSource(SHAPES_SOURCE, { type: 'geojson', data: shapesToGeoJSON(shapesRef.current) });
        for (const layer of SHAPE_LAYERS) {
          if (!m.getLayer(layer.id)) m.addLayer({ ...layer, source: SHAPES_SOURCE } as Parameters<GLMap['addLayer']>[0]);
        }
      };
      map.on('style.load', () => {
        fallbackRef.current?.styleLoad();
        addShapes();
      });
      // The style, or the base map's tiles, failed and the cache had nothing: next address.
      map.on('error', (e) => {
        // Say what failed (URL, status), so a self-hoster can tell a blocked worker or style apart.
        const err = (e as { error?: { message?: string; url?: string; status?: number } }).error;
        console.warn('[map] base map error', err?.status ?? '', err?.url ?? '', err?.message ?? e);
        const fb = fallbackRef.current;
        if (!fb?.error(e as { sourceId?: string; tile?: unknown }, [SHAPES_SOURCE])) return;
        setBaseStatus(fb.status());
        map!.setStyle(glStyle(fb.current()), { diff: false });
      });
      map.on('sourcedata', (e) => {
        if (e.tile && e.sourceId !== SHAPES_SOURCE) fallbackRef.current?.tileLoad();
      });
      if (map.isStyleLoaded()) addShapes();
      // Right click on desktop, long press on touch screens.
      map.on('contextmenu', (e) =>
        cb.current.onLongPress?.({ lat: e.lngLat.lat, lon: e.lngLat.lng }),
      );
      const m = map;
      m.on('moveend', () => cb.current.onRegionChange?.(regionOf(m)));
      // Only gestures carry an originalEvent (jumpTo / flyTo do not).
      m.on('movestart', (e: { originalEvent?: unknown }) => {
        if (e.originalEvent) cb.current.onUserMoveStart?.();
      });
      // `resize` (window, fold/unfold) changes the visible area too.
      m.on('resize', () => cb.current.onRegionChange?.(regionOf(m)));
      mapRef.current = map;
      // For end-to-end tests: the most recently opened map that is still mounted.
      const w = window as unknown as { __tlMap?: GLMap; __tlMaps?: GLMap[] };
      w.__tlMaps = [...(w.__tlMaps ?? []), map];
      w.__tlMap = map;
      setReady(true);
      cb.current.onRegionChange?.(regionOf(map));
    })();
    return () => {
      cancelled = true;
      markersRef.current.forEach(({ marker }) => marker.remove());
      markersRef.current.clear();
      clusterMarkersRef.current.forEach(({ marker }) => marker.remove());
      clusterMarkersRef.current.clear();
      if (map) {
        const w = window as unknown as { __tlMap?: GLMap; __tlMaps?: GLMap[] };
        w.__tlMaps = (w.__tlMaps ?? []).filter((m) => m !== map);
        if (w.__tlMap === map) w.__tlMap = w.__tlMaps[w.__tlMaps.length - 1];
      }
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Style changes (e.g. dark mode): the other theme's addresses, from the one reached this session.
  const baseKey = specKey(baseMap);
  useEffect(() => {
    if (!ready || fallbackRef.current?.key === baseKey) return;
    const fb = new BaseMapFallback(baseMap);
    fallbackRef.current = fb;
    setBaseStatus(fb.status());
    mapRef.current?.setStyle(glStyle(fb.current()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, baseKey]);

  // Camera requests (cluster taps, "show on map").
  const camKey = useRef<number | null>(null);
  useEffect(() => {
    if (!ready || !camera || camKey.current === camera.key) return;
    camKey.current = camera.key;
    mapRef.current?.easeTo({ center: [camera.center.lon, camera.center.lat], zoom: camera.zoom, duration: 450 });
  }, [ready, camera]);

  // Sync pin markers (diff by id + visual key).
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
      const marker = new lib.Marker({
        element: el,
        anchor: pin.badge ? 'center' : 'bottom',
        offset: pinBox(pin, selected).offset,
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

  // Sync zone shapes.
  useEffect(() => {
    const src = mapRef.current?.getSource(SHAPES_SOURCE) as { setData?: (d: unknown) => void } | undefined;
    src?.setData?.(shapesToGeoJSON(shapes));
  }, [ready, shapes]);

  // Sync cluster bubbles.
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!ready || !map || !lib) return;
    const markers = clusterMarkersRef.current;
    const seen = new Set<string>();
    for (const c of clusters) {
      seen.add(c.id);
      const key = clusterKey(c);
      const existing = markers.get(c.id);
      if (existing?.key === key) continue;
      existing?.marker.remove();
      const el = makeClusterElement(c, (id) => cb.current.onClusterPress?.(id));
      const marker = new lib.Marker({ element: el, anchor: 'center' }).setLngLat([c.lon, c.lat]).addTo(map);
      markers.set(c.id, { key, marker });
    }
    for (const [id, { marker }] of markers) {
      if (!seen.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }
  }, [ready, clusters]);

  return (
    <View style={[styles.fill, style]}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} data-testid="map" data-base-map={baseStatus} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
});
