import { StyleSheet, Text, View } from 'react-native';

import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { Button } from './ui';

const SHOWN = 3;

/** Grouped "maybe closed" notice, shown when the app opens, at most once a month (T-113). */
export function ClosureNotice({ places, onReview, onLater }: { places: { id: string; name: string }[]; onReview: () => void; onLater: () => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  const first = places.slice(0, SHOWN).map((p) => p.name);
  const names = places.length > SHOWN ? t('closure.notice.more', { names: first.join(', '), count: places.length - SHOWN }) : first.join(', ');
  return (
    <View style={[styles.box, { backgroundColor: c.warningBg, borderColor: c.warning, shadowColor: c.shadow }]} accessibilityRole="alert" testID="closure-notice">
      <Text style={[styles.title, { color: c.text }]} maxFontSizeMultiplier={2}>
        ✕ {t('closure.notice.title', { count: places.length })}
      </Text>
      <Text style={[styles.body, { color: c.text }]} maxFontSizeMultiplier={2}>
        {t('closure.notice.body', { names })}
      </Text>
      <View style={styles.actions}>
        <Button label={t('closure.notice.review')} onPress={onReview} testID="closure-notice-review" />
        <Button kind="secondary" label={t('closure.notice.later')} onPress={onLater} testID="closure-notice-later" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 14, borderWidth: 1, padding: 12, gap: 6, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  title: { fontSize: 15, fontWeight: '700' },
  body: { fontSize: 14 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
});
