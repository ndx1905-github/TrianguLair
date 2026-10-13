import { Text, View } from 'react-native';

import type { MapViewProps } from './types';

/**
 * Type-checking / fallback entry. At runtime Metro always picks
 * Map.native.tsx (iOS, Android) or Map.web.tsx (web) instead of this file.
 */
export default function Map({ style }: MapViewProps) {
  return (
    <View style={style}>
      <Text>Map is not available on this platform.</Text>
    </View>
  );
}
