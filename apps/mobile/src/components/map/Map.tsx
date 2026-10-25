import { Text, View } from 'react-native';

import { useI18n } from '../../i18n';
import type { MapViewProps } from './types';

/**
 * Type-checking / fallback entry. At runtime Metro always picks
 * Map.native.tsx (iOS, Android) or Map.web.tsx (web) instead of this file.
 */
export default function Map({ style }: MapViewProps) {
  const { t } = useI18n();
  return (
    <View style={style}>
      <Text>{t('map.unavailable')}</Text>
    </View>
  );
}
