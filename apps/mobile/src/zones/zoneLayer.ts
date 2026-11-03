/**
 * The map's zone layer: which visible places are zones, and their shapes in
 * the color of their pin (main tag, or the filtered tag), greyed outside the
 * filter like pins (spec "Zones" > Display). Pure, unit-tested.
 */
import type { PlaceRecord } from '@triangulair/data';

import type { MapPin } from '../components/map/types';
import type { MapShape, ShapeGeometry, ShapeStyle } from './shapes';

export type ZonePlace = Pick<PlaceRecord, 'id' | 'kind' | 'edge' | 'geometry'>;

export function zoneStyle(p: Pick<PlaceRecord, 'edge' | 'geometry'>): ShapeStyle {
  const t = p.geometry.type;
  if (t === 'LineString' || t === 'MultiLineString') return 'street';
  return p.edge === 'blurred' ? 'blurred' : 'zone';
}

export function zoneShapes(zones: readonly ZonePlace[], pins: ReadonlyMap<string, MapPin>, selectedId: string | null): MapShape[] {
  const out: MapShape[] = [];
  for (const z of zones) {
    if (z.kind !== 'zone' || z.geometry.type === 'Point') continue;
    const pin = pins.get(z.id);
    out.push({
      id: z.id,
      geometry: z.geometry as ShapeGeometry,
      color: pin?.colors[0] ?? '#475569',
      style: zoneStyle(z),
      greyed: pin?.greyed ?? false,
      selected: z.id === selectedId,
      pressable: true,
    });
  }
  // The selected zone on top.
  return out.sort((a, b) => Number(a.selected) - Number(b.selected));
}
