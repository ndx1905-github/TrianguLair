import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

/** Top bar of the stacked screens (list, add, card page): back button, title, optional action. */
export function ScreenHeader({ title, onBack, right }: { title: string; onBack: () => void; right?: ReactNode }) {
  const c = useUiColors();
  const insets = useSafeAreaInsets();
  const { gutter } = useLayout();
  const { t } = useI18n();
  return (
    <View
      style={[
        styles.bar,
        { paddingTop: insets.top + 6, paddingLeft: insets.left + gutter, paddingRight: insets.right + gutter, backgroundColor: c.surface, borderColor: c.border },
      ]}
    >
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={t('common.back')} hitSlop={8} style={styles.back} testID="back">
        <Text style={[styles.backText, { color: c.accent }]} maxFontSizeMultiplier={2}>
          ‹ {t('common.back')}
        </Text>
      </Pressable>
      <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
        {title}
      </Text>
      <View style={styles.right}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { minHeight: 44, justifyContent: 'center', paddingRight: 8 },
  backText: { fontSize: 16, fontWeight: '600' },
  title: { flexGrow: 1, flexShrink: 1, flexBasis: 120, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  right: { minWidth: 60, maxWidth: '100%', flexShrink: 1, marginLeft: 'auto', alignItems: 'flex-end' },
});
