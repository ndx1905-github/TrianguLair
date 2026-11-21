/**
 * "A new version is ready · Reload" (web PWA builds only; renders nothing on the phones). The new
 * service worker waits until this button: the database is saved, then the page reloads on the new
 * version. "Later" hides the bar until the next launch, which runs the new version anyway once
 * every tab of the app is closed.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '../components/ui';
import { useMaybeData } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { PWA_ENABLED, applyUpdate, pwaState, startPwa, subscribePwa } from './pwa';

export function PwaUpdatePrompt() {
  useEffect(() => {
    if (PWA_ENABLED) startPwa();
  }, []);
  const state = useSyncExternalStore(subscribePwa, pwaState, pwaState);
  const [hidden, setHidden] = useState(false);
  const c = useUiColors();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const data = useMaybeData();
  if (!PWA_ENABLED || !state.updateReady || hidden) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 12 }]}>
      <View style={[styles.bar, { backgroundColor: c.surface, borderColor: c.border }]} accessibilityRole="alert" testID="pwa-update">
        <Text style={{ color: c.text, fontSize: 14, flexShrink: 1 }} maxFontSizeMultiplier={2}>
          {t('pwa.update')}
        </Text>
        <View style={styles.actions}>
          <Button kind="secondary" label={t('pwa.later')} onPress={() => setHidden(true)} testID="pwa-update-later" />
          <Button label={t('pwa.reload')} onPress={() => void applyUpdate(data?.flush)} testID="pwa-update-reload" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, alignItems: 'center' },
  bar: {
    width: '100%',
    maxWidth: 560,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  actions: { flexDirection: 'row', gap: 8 },
});
