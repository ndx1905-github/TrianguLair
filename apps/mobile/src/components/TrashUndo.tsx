import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { useData } from '../data/DataProvider';
import { useI18n } from '../i18n';
import { useAppState } from '../state/AppState';
import { Banner, Button } from './ui';

/** How long the undo stays offered after moving a place to the trash. */
export const TRASH_UNDO_MS = 15_000;

/** "… moved to the trash. Undo": shown on the map and the list after a place card's "Move to trash". */
export function TrashUndo() {
  const { t } = useI18n();
  const { mutate } = useData();
  const { trashed, setTrashed } = useAppState();
  useEffect(() => {
    if (!trashed) return;
    const timer = setTimeout(() => setTrashed(null), TRASH_UNDO_MS);
    return () => clearTimeout(timer);
  }, [trashed, setTrashed]);
  if (!trashed) return null;
  return (
    <View style={styles.row} testID="trash-notice">
      <View style={{ flexShrink: 1 }}>
        <Banner>{t('card.trashed', { name: trashed.name })}</Banner>
      </View>
      <Button
        kind="secondary"
        label={t('card.undo')}
        onPress={() => {
          mutate((s) => s.restoreSave(trashed.placeId));
          setTrashed(null);
        }}
        testID="trash-undo"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
});
