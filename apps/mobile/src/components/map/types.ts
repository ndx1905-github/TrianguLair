import type { StyleProp, ViewStyle } from 'react-native';

import type { MapShape } from '../../zones/shapes';
import type { BaseMapSpec } from './baseMap';

export type { MapShape };

export interface LatLon {
  lat: number;
  lon: number;
}

/** Everything a map implementation needs to draw one pin. */
export interface MapPin extends LatLon {
  id: string;
  /** Accessible label (place name). */
  label: string;
  /** Band colors, in tag order (rendered: up to MAX_PIN_BANDS). */
  colors: string[];
  /** Icon SVG path (24x24 viewBox). */
  iconPath: string;
  /** Friends-only place: lighter / translucent pin. */
  faded: boolean;
  /** Outside the active filter: grey, translucent and smaller (spec "Filtered display"). */
  greyed: boolean;
  /** Maybe closed: small grey cross on the pin (spec "Pins" > "Statuses"). */
  maybeClosed?: boolean;
  /** Zone badge: a rounded square without a tip, centred on the point (spec "Zones"). */
  badge?: boolean;
}

/** A bubble standing for several pins when zoomed out. */
export interface MapCluster extends LatLon {
  id: string;
  count: number;
  /** Majority tag color; null = no member matches the filter (grey). */
  color: string | null;
  label: string;
}

/** Visible area, reported after each camera move. */
export interface MapRegion {
  /** [west, south, east, north]. */
  bbox: [number, number, number, number];
  center: LatLon;
  zoom: number;
}

/** A camera request; `key` must change for the same position to be applied again. */
export interface CameraTarget {
  center: LatLon;
  zoom: number;
  key: number;
}

/**
 * Common interface of Map.native.tsx (MapLibre React Native) and Map.web.tsx
 * (MapLibre GL JS). `center` / `zoom` are the initial camera; `camera` moves
 * the map later (cluster taps, "show on map").
 */
export interface MapViewProps {
  /** Base map addresses to try in order (`baseMapFor(dark)`), then a built-in blank style. */
  baseMap: BaseMapSpec;
  center: LatLon;
  zoom: number;
  camera?: CameraTarget | null;
  pins: MapPin[];
  clusters?: MapCluster[];
  selectedPinId?: string | null;
  onPinPress?: (id: string) => void;
  onClusterPress?: (id: string) => void;
  onLongPress?: (at: LatLon) => void;
  /** Tap on the map background (not on a pin). */
  onMapPress?: (at: LatLon) => void;
  /** Zones, street segments, drafts and candidate shapes drawn under the pins. */
  shapes?: MapShape[];
  /** Tap on a pressable shape (zone area, candidate neighbourhood or street). */
  onShapePress?: (id: string) => void;
  /** After the camera stops moving (and once when the map is ready). */
  onRegionChange?: (region: MapRegion) => void;
  /** The user starts moving the map (drag, pinch), not a programmatic camera move. */
  onUserMoveStart?: () => void;
  style?: StyleProp<ViewStyle>;
}
