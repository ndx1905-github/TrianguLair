import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useDataStatus } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

/** Renders its children once the local database is open (spinner / error otherwise). */
export function DataGate({ children }: { children: ReactNode }) {
  const status = useDataStatus();
  const c = useUiColors();
  const { t } = useI18n();
  if (status.kind === 'ready') return <>{children}</>;
  return (
    <View style={[styles.center, { backgroundColor: c.background }]} testID="data-gate">
      {status.kind === 'loading' ? (
        <>
          <ActivityIndicator color={c.accent} />
          <Text style={[styles.text, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {t('data.loading')}
          </Text>
        </>
      ) : (
        <Text style={[styles.text, { color: c.text }]} maxFontSizeMultiplier={2}>
          {t('data.failed')}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  text: { fontSize: 15, textAlign: 'center' },
});
