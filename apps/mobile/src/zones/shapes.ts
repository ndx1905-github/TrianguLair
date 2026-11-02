/**
 * Zones on the map (spec "Zones" > Display), shared by both map engines:
 *
 * - zone: transparent fill (~20 %) and a 2.5 px outline in the main tag color;
 * - painted zone (fuzzy outline): no outline, a gradient edge in three rings
 *   of decreasing opacity;
 * - street segment: thick transparent line along the street, thin solid
 *   line at the centre;
 * - outside the filter, a zone fades like pins (grey, translucent).
 *
 * Plus the editor's shapes: candidates (neighbourhoods / streets to tap),
 * the draft being drawn (dashed, with its vertices and handles) and list
 * zones (preview of a list's areas). One GeoJSON source, fixed layers whose
 * paint reads feature properties, so web (MapLibre GL JS) and native
 * (MapLibre RN `Layer`) use the same specs.
 */
import type { Feature, FeatureCollection, LineString, MultiLineString, MultiPoint, MultiPolygon, Point, Polygon } from 'geojson';
import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  FillLayerSpecification,
  FilterSpecification,
  LineLayerSpecification,
} from 'maplibre-gl';

import { GREYED_COLOR } from '../theme/tags';

export type ShapeStyle =
  /** A saved zone (sharp edge). */
  | 'zone'
  /** A saved painted zone (fuzzy outline). */
  | 'blurred'
  /** A saved street-segment zone. */
  | 'street'
  /** A neighbourhood or street that can be tapped to pick it. */
  | 'candidate'
  /** The shape being drawn / picked. */
  | 'draft'
  /** An area of a list (preview). */
  | 'listZone';

export type ShapeGeometry = Polygon | MultiPolygon | LineString | MultiLineString | Point | MultiPoint;

export interface MapShape {
  id: string;
  geometry: ShapeGeometry;
  color: string;
  style: ShapeStyle;
  greyed?: boolean;
  selected?: boolean;
  /** Tapping it calls `onShapePress(id)` instead of `onMapPress`. */
  pressable?: boolean;
}

export const SHAPES_SOURCE = 'tl-shapes';

interface ShapeProps {
  id: string;
  color: string;
  style: ShapeStyle;
  /** Opacity factor: 1, or about 0.4 outside the filter. */
  op: number;
  sel: number;
  press: number;
}

export function shapesToGeoJSON(shapes: readonly MapShape[]): FeatureCollection<ShapeGeometry, ShapeProps> {
  return {
    type: 'FeatureCollection',
    features: shapes.map(
      (s): Feature<ShapeGeometry, ShapeProps> => ({
        type: 'Feature',
        id: s.id,
        geometry: s.geometry,
        properties: {
          id: s.id,
          color: s.greyed ? GREYED_COLOR : s.color,
          style: s.style,
          op: s.greyed ? 0.4 : 1,
          sel: s.selected ? 1 : 0,
          press: s.pressable ? 1 : 0,
        },
      }),
    ),
  };
}

const polygon: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
const line: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]];
const point: FilterSpecification = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]];
const styleIn = (...styles: ShapeStyle[]): ExpressionSpecification => ['in', ['get', 'style'], ['literal', styles]];
const color: ExpressionSpecification = ['get', 'color'];
const op = (base: number | ExpressionSpecification): ExpressionSpecification => ['*', base, ['get', 'op']];

type Spec<T> = Omit<T, 'source'>;
export type ShapeLayerSpec = Spec<FillLayerSpecification> | Spec<LineLayerSpecification> | Spec<CircleLayerSpecification>;

/** Layers, bottom to top. */
export const SHAPE_LAYERS: ShapeLayerSpec[] = [
  {
    id: 'tl-fill',
    type: 'fill',
    filter: ['all', polygon, styleIn('zone', 'blurred', 'candidate', 'draft', 'listZone')],
    paint: {
      'fill-color': color,
      'fill-opacity': op([
        '+',
        ['match', ['get', 'style'], 'zone', 0.2, 'blurred', 0.16, 'candidate', 0.08, 'draft', 0.22, 'listZone', 0.07, 0.15],
        ['*', 0.1, ['get', 'sel']],
      ]),
    },
  },
  // Fuzzy outline: three rings of decreasing opacity, outermost first.
  {
    id: 'tl-blur-outer',
    type: 'line',
    filter: ['all', polygon, styleIn('blurred')],
    paint: { 'line-color': color, 'line-width': 16, 'line-blur': 8, 'line-opacity': op(0.12) },
  },
  {
    id: 'tl-blur-mid',
    type: 'line',
    filter: ['all', polygon, styleIn('blurred')],
    paint: { 'line-color': color, 'line-width': 9, 'line-blur': 5, 'line-opacity': op(0.2) },
  },
  {
    id: 'tl-blur-inner',
    type: 'line',
    filter: ['all', polygon, styleIn('blurred')],
    paint: { 'line-color': color, 'line-width': 4, 'line-blur': 2, 'line-opacity': op(0.32) },
  },
  {
    id: 'tl-outline',
    type: 'line',
    filter: ['all', polygon, styleIn('zone')],
    layout: { 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': ['+', 2.5, ['*', 1.5, ['get', 'sel']]], 'line-opacity': op(0.95) },
  },
  {
    id: 'tl-outline-dash',
    type: 'line',
    filter: ['all', polygon, styleIn('candidate', 'draft', 'listZone')],
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': ['match', ['get', 'style'], 'draft', 2.5, ['+', 1.5, ['*', 1.5, ['get', 'sel']]]],
      'line-dasharray': [2, 1.5],
      'line-opacity': op(0.9),
    },
  },
  {
    id: 'tl-street-wide',
    type: 'line',
    filter: ['all', line, styleIn('street', 'candidate', 'draft')],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': ['match', ['get', 'style'], 'candidate', 12, ['+', 14, ['*', 4, ['get', 'sel']]]],
      'line-opacity': op(['match', ['get', 'style'], 'candidate', 0.16, 'draft', 0.4, 0.3]),
    },
  },
  {
    id: 'tl-street-center',
    type: 'line',
    filter: ['all', line, styleIn('street', 'candidate', 'draft')],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': ['match', ['get', 'style'], 'candidate', 1.5, 2],
      'line-opacity': op(['match', ['get', 'style'], 'candidate', 0.55, 1]),
    },
  },
  {
    id: 'tl-points',
    type: 'circle',
    filter: point,
    paint: {
      'circle-radius': ['+', 6, ['*', 3, ['get', 'sel']]],
      'circle-color': '#FFFFFF',
      'circle-stroke-color': color,
      'circle-stroke-width': 3,
    },
  },
];

/** Layers whose features can be tapped (pressable shapes). */
export const PRESSABLE_LAYERS = ['tl-fill', 'tl-street-wide'];
