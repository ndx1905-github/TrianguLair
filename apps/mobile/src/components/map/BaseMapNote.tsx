import { useSyncExternalStore } from 'react';
import { View } from 'react-native';

import { useI18n } from '../../i18n';
import { Banner } from '../ui';
import { baseMapNoteKey, baseMapStatus, subscribeBaseMapStatus } from './baseMap';

/**
 * Plain note on the map when the cache was not enough and the base map comes from a fallback
 * address, or from none (spec "Error cases", map tiles unavailable). Nothing otherwise.
 */
export function BaseMapNote({ style }: { style?: object }) {
  const { t } = useI18n();
  const status = useSyncExternalStore(subscribeBaseMapStatus, baseMapStatus, baseMapStatus);
  const key = baseMapNoteKey(status);
  if (!key) return null;
  return (
    <View style={style} pointerEvents="none">
      <Banner testID="basemap-note">{t(key)}</Banner>
    </View>
  );
}
