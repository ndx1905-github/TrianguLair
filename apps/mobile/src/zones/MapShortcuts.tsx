import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

/** Map buttons for zones and lists (between the list button and +). */
export function MapShortcuts() {
  const c = useUiColors();
  const { t } = useI18n();
  const router = useRouter();
  const button = (label: string, a11y: string, onPress: () => void, testID: string) => (
    <Pressable
      onPress={onPress}
      style={[styles.button, { backgroundColor: c.surface, borderColor: c.border, shadowColor: c.shadow }]}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      testID={testID}
    >
      <Text style={[styles.text, { color: c.text }]} maxFontSizeMultiplier={2}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View style={styles.row}>
      {button(`◱ ${t('nav.zone')}`, t('nav.zoneA11y'), () => router.push('/zone/new'), 'open-new-zone')}
      {button(`☷ ${t('nav.lists')}`, t('nav.listsA11y'), () => router.push('/lists'), 'open-lists')}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'center' },
  button: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  text: { fontSize: 15, fontWeight: '700' },
});
