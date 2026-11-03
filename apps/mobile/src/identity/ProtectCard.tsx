import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Button } from '../components/ui';
import { Phase2Badge } from '../firstLaunch/Frame';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

/** "Protect your places" (spec "Later, at the right moment"): the kit now, a storage with sharing. */
export function ProtectCard({ onLater }: { onLater: () => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  const router = useRouter();
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, shadowColor: c.shadow }]} testID="protect-card">
      <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
        {t('protect.title')}
      </Text>
      <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {t('protect.lead')}
      </Text>
      <View style={styles.row}>
        <Button label={t('protect.kit')} onPress={() => router.push('/kit')} testID="protect-kit" />
        <Button kind="secondary" label={t('protect.later')} onPress={onLater} testID="protect-later" />
      </View>
      <View style={styles.storage}>
        <Text style={{ color: c.textMuted, fontSize: 14, fontWeight: '600' }} maxFontSizeMultiplier={2}>
          {t('protect.storage')}
        </Text>
        <Phase2Badge />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 14,
    gap: 8,
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  title: { fontSize: 17, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  storage: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
});
