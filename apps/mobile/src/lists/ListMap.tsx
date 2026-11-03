import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import type { FilterZone, PlaceRecord } from '@triangulair/data';

import Map from '../components/map/Map';
import type { CameraTarget, LatLon } from '../components/map/types';
import { MapAttribution } from '../components/MapAttribution';
import { INITIAL_CENTER, INITIAL_ZOOM, MAP_STYLE_URL, MAP_STYLE_URL_DARK } from '../config';
import { useFactsLookup, useTags } from '../data/usePlaces';
import { useIsDark, useUiColors } from '../hooks/useUiColors';
import { buildPin } from '../pins/build';
import { fitCamera } from '../places/camera';
import { EMPTY_FILTER } from '../places/filters';
import type { MapShape } from '../zones/shapes';
import { zoneShapes } from '../zones/zoneLayer';
import { zoneKeyOf } from './listLogic';

interface Props {
  /** Places drawn on the map. */
  places: readonly PlaceRecord[];
  /** Those in the list (in color); the others are faded (preview, spec "Creating a sharing list"). */
  inIds: ReadonlySet<string>;
  zones: readonly FilterZone[];
  selectedId?: string | null;
  onSelect?: (placeId: string | null) => void;
  /** Change it to fit the camera again. */
  fitKey?: number;
}

function zonePoints(z: FilterZone): LatLon[] {
  const polys = z.geometry.type === 'Polygon' ? [z.geometry.coordinates] : z.geometry.coordinates;
  return polys.flatMap((p) => p[0]!.map(([lon, lat]) => ({ lat: lat!, lon: lon! })));
}

/** A list on a map: its places (pins and zone shapes) and the areas of its filter. */
export function ListMap({ places, inIds, zones, selectedId = null, onSelect, fitKey = 0 }: Props) {
  const c = useUiColors();
  const dark = useIsDark();
  const lookup = useFactsLookup();
  const { tags, byId } = useTags();
  const [size, setSize] = useState({ width: 0, height: 0 });

  const { pins, shapes } = useMemo(() => {
    const pins = places
      .map((p) => {
        const facts = lookup(p.id);
        if (!facts) return null;
        const out = !inIds.has(p.id);
        return {
          ...buildPin({ facts, match: out ? 'nomatch' : 'match' }, EMPTY_FILTER, tags, byId, out),
          ...(p.kind === 'zone' && p.geometry.type !== 'Point' ? { badge: true } : {}),
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      // In-list pins on top.
      .sort((a, b) => Number(b.greyed) - Number(a.greyed));
    const listZones: MapShape[] = zones.map((z) => ({ id: `filter:${zoneKeyOf(z)}`, geometry: z.geometry, color: c.accent, style: 'listZone' }));
    const zs = zoneShapes(
      places.filter((p) => p.kind === 'zone'),
      new globalThis.Map(pins.map((p) => [p.id, p])),
      selectedId,
    );
    return { pins, shapes: [...listZones, ...zs] };
  }, [places, inIds, zones, lookup, tags, byId, selectedId, c.accent]);

  // Fit the list's places (or its zones) once the map has a size, and when asked again.
  const camera = useMemo<CameraTarget | null>(() => {
    if (size.width === 0) return null;
    const pts = [
      ...places.filter((p) => inIds.has(p.id)).map((p) => ({ lat: p.lat, lon: p.lon })),
      ...zones.flatMap(zonePoints),
    ];
    const cam = fitCamera(pts.length ? pts : places.map((p) => ({ lat: p.lat, lon: p.lon })), {
      width: Math.max(80, size.width - 60),
      height: Math.max(80, size.height - 60),
      maxZoom: 15.5,
      fallback: { center: INITIAL_CENTER, zoom: INITIAL_ZOOM },
    });
    return { ...cam, key: fitKey * 10_000 + Math.round(size.width) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, size.width > 0]);

  return (
    <View style={[styles.box, { borderColor: c.border, backgroundColor: c.surfaceAlt }]} onLayout={(e: LayoutChangeEvent) => setSize(e.nativeEvent.layout)} testID="list-map">
      {size.width > 0 && camera && (
        <Map
          styleUrl={dark ? MAP_STYLE_URL_DARK : MAP_STYLE_URL}
          center={camera.center}
          zoom={camera.zoom}
          camera={camera}
          pins={pins}
          selectedPinId={selectedId}
          shapes={shapes}
          onPinPress={(id) => onSelect?.(id)}
          onShapePress={(id) => onSelect?.(id)}
          onMapPress={() => onSelect?.(null)}
        />
      )}
      <MapAttribution bottom={4} right={6} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, minHeight: 220, borderRadius: 16, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
});
