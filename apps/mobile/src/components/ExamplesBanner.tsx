import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useExamples } from '../data/useExamples';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { Banner } from './ui';

/**
 * On the map and the list while example places are there (src/data/demo.ts): says they are
 * examples, kept on this phone and never shared, with a one-tap "Delete the example places".
 * "Hide" folds it away for good; Settings keeps the delete action.
 */
export function ExamplesBanner({ style }: { style?: object }) {
  const c = useUiColors();
  const { t } = useI18n();
  const { present, bannerHidden, remove, hideBanner } = useExamples();
  const [deleted, setDeleted] = useState<number | null>(null);
  useEffect(() => {
    if (deleted == null) return;
    const timer = setTimeout(() => setDeleted(null), 4000);
    return () => clearTimeout(timer);
  }, [deleted]);

  if (deleted != null) {
    return (
      <View style={style} pointerEvents="none">
        <Banner testID="examples-deleted">{t('examples.deleted', { count: deleted })}</Banner>
      </View>
    );
  }
  if (!present || bannerHidden) return null;
  return (
    <View
      style={[styles.box, { backgroundColor: c.surface, borderColor: c.border, shadowColor: c.shadow }, style]}
      testID="examples-banner"
      accessibilityRole="summary"
    >
      <Text style={{ color: c.text, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {t('examples.banner')}
      </Text>
      <View style={styles.actions}>
        <Pressable onPress={hideBanner} accessibilityRole="button" hitSlop={6} style={styles.action} testID="examples-hide">
          <Text style={{ color: c.textMuted, fontSize: 14, fontWeight: '600' }} maxFontSizeMultiplier={2}>
            {t('examples.hide')}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setDeleted(remove())}
          accessibilityRole="button"
          hitSlop={6}
          style={[styles.action, styles.primary, { backgroundColor: c.danger }]}
          testID="examples-delete"
        >
          <Text style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '700' }} maxFontSizeMultiplier={2}>
            {t('examples.delete')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 12 },
  action: { minHeight: 36, justifyContent: 'center' },
  primary: { paddingHorizontal: 12, borderRadius: 999 },
});
