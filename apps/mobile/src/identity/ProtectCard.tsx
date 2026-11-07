import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Button } from '../components/ui';
import { useStorage } from '../storage/StorageProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

/** "Protect your places" (spec "Later, at the right moment"): the kit, and a storage (automatic encrypted backup). */
export function ProtectCard({ onLater }: { onLater: () => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  const router = useRouter();
  const storage = useStorage();
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
      {!storage.state.current && (
        <View style={styles.storage}>
          <Text style={{ color: c.textMuted, fontSize: 14, flexShrink: 1 }} maxFontSizeMultiplier={2}>
            {t('protect.storageLead')}
          </Text>
          <Button kind="secondary" label={t('protect.storage')} onPress={() => router.push('/storage/setup?reason=backup')} testID="protect-storage" />
        </View>
      )}
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
