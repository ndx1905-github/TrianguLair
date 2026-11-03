import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Redirect } from 'expo-router';

import { useDataStatus } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { useIdentity } from '../identity/IdentityProvider';

/**
 * Renders its children once my identity exists and the local database is open
 * (spinner / error otherwise). Without an identity, sends to the first launch.
 */
export function DataGate({ children }: { children: ReactNode }) {
  const status = useDataStatus();
  const identity = useIdentity().state;
  const c = useUiColors();
  const { t } = useI18n();
  if (identity.kind === 'none') return <Redirect href="/welcome" />;
  if (identity.kind === 'ready' && identity.onboarding !== 'done') return <Redirect href={`/welcome/${identity.onboarding}`} />;
  if (identity.kind === 'error') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]} testID="identity-error">
        <Text style={[styles.text, { color: c.text }]} maxFontSizeMultiplier={2}>
          {t('identity.failed')}
        </Text>
      </View>
    );
  }
  if (identity.kind === 'ready' && status.kind === 'ready') return <>{children}</>;
  return (
    <View style={[styles.center, { backgroundColor: c.background }]} testID="data-gate">
      {status.kind === 'loading' || identity.kind === 'loading' ? (
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
