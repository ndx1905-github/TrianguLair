import { Platform, StyleSheet, Text, View } from 'react-native';

import { Button } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

/**
 * Shown instead of the whole app once this device found itself declared lost (spec "Loss and
 * theft", remote wipe): its keys and database are already erased.
 */
export function DeviceRemoved() {
  const c = useUiColors();
  const { t } = useI18n();
  const web = Platform.OS === 'web' && typeof window !== 'undefined';
  return (
    <View style={[styles.root, { backgroundColor: c.background }]} testID="device-removed">
      <View style={styles.column}>
        <Text style={[styles.icon, { color: c.textMuted }]} maxFontSizeMultiplier={1.5}>
          ⌀
        </Text>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
          {t('removed.title')}
        </Text>
        <Text style={[styles.body, { color: c.text }]} maxFontSizeMultiplier={2}>
          {t('removed.body')}
        </Text>
        {web ? (
          <Button label={t('removed.again')} onPress={() => window.location.assign(window.location.pathname.replace(/[^/]*$/, ''))} testID="removed-again" />
        ) : (
          <Text style={[styles.body, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {t('removed.native')}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  column: { width: '100%', maxWidth: 560, gap: 16 },
  icon: { fontSize: 48, textAlign: 'center' },
  title: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 16, textAlign: 'center' },
});
