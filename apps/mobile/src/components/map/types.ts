import type { StyleProp, ViewStyle } from 'react-native';

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
}

/**
 * Common interface of Map.native.tsx (MapLibre React Native) and Map.web.tsx
 * (MapLibre GL JS). `center` / `zoom` are the initial camera; later changes
 * re-center the map.
 */
export interface MapViewProps {
  styleUrl: string;
  center: LatLon;
  zoom: number;
  pins: MapPin[];
  selectedPinId?: string | null;
  onPinPress?: (id: string) => void;
  onLongPress?: (at: LatLon) => void;
  /** Tap on the map background (not on a pin). */
  onMapPress?: (at: LatLon) => void;
  style?: StyleProp<ViewStyle>;
}
