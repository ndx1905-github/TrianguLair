import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

/**
 * "Lock if no sync for N days" (spec "Protections on the device"): covers the whole app until a
 * sync with my storage succeeds. A device declared lost meanwhile erases itself at that sync.
 * `clock`: locked because the clock was set back before a time already seen (devices review F-07).
 */
export function StaleSyncLock({ days, clock = false, onSync }: { days: number; clock?: boolean; onSync: () => Promise<void> }) {
  const c = useUiColors();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  return (
    <View
      style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: c.background, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
      testID="stale-lock"
      accessibilityViewIsModal
    >
      <View style={styles.column}>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
          {t('stale.title')}
        </Text>
        <Text style={{ color: c.text, fontSize: 16, textAlign: 'center' }} maxFontSizeMultiplier={2}>
          {clock ? t('stale.clock') : t('stale.body', { count: days })}
        </Text>
        <Button
          label={busy ? t('stale.syncing') : t('stale.sync')}
          disabled={busy}
          onPress={() => {
            setBusy(true);
            void onSync().finally(() => {
              setBusy(false);
              setTried(true);
            });
          }}
          testID="stale-sync"
        />
        {tried && !busy && (
          <Text style={{ color: c.textMuted, textAlign: 'center' }} maxFontSizeMultiplier={2} accessibilityLiveRegion="polite">
            {t('stale.failed')}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, zIndex: 1100, elevation: 1100 },
  column: { width: '100%', maxWidth: 480, gap: 16 },
  title: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
});
