/** A row of small thumbnails (What's new "new photo"); photos no longer in my cache are skipped. */
import { Image, StyleSheet, View } from 'react-native';
import type { Photos } from '@triangulair/sync';

import { useData } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { usePhotoImage, usePhotosService } from './usePhotos';

const SIZE = 56;

export function PhotoStrip({ mediaIds }: { mediaIds: readonly string[] }) {
  const svc = usePhotosService();
  const { repo, version } = useData();
  const ids = mediaIds.filter((id) => !!repo.mediaById(id)).slice(0, 6);
  if (!svc || ids.length === 0) return null;
  return (
    <View style={styles.row} testID="whatsnew-photos">
      {ids.map((id) => (
        <Small key={id} svc={svc} id={id} k={version} />
      ))}
    </View>
  );
}

function Small({ svc, id, k }: { svc: Photos; id: string; k: number }) {
  const c = useUiColors();
  const img = usePhotoImage(svc, id, 'thumb', k);
  return (
    <View style={[styles.box, { backgroundColor: c.surfaceAlt }]}>
      {img.kind === 'ready' && <Image source={{ uri: img.uri }} style={styles.box} resizeMode="cover" accessibilityIgnoresInvertColors />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  box: { width: SIZE, height: SIZE, borderRadius: 8, overflow: 'hidden' },
});
