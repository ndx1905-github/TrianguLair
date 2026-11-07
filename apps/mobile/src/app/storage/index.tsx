/**
 * Settings › Storage (T-203): the current storage (or local only), its two addresses, the
 * connection test, the older storages that keep a signed redirect, and the way to change.
 */
import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button } from '../../components/ui';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { protocolOf, writeAddressOf } from '../../storage/config';
import { runConnectionTest, type TestStep } from '../../storage/connectionTest';
import { Muted, Section, StorageScreen, TestResults } from '../../storage/components';
import { useStorage } from '../../storage/StorageProvider';

function Address({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const c = useUiColors();
  return (
    <View style={{ gap: 2 }}>
      <Muted>{label}</Muted>
      <Text selectable style={{ color: c.text, fontSize: 15 }} maxFontSizeMultiplier={2} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

function StorageOverview() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const c = useUiColors();
  const storage = useStorage();
  const cur = storage.state.current;
  const [steps, setSteps] = useState<TestStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const date = (ms: number) => new Date(ms).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });

  const test = async () => {
    if (!cur) return;
    setRunning(true);
    try {
      const r = await runConnectionTest(cur, {
        platform: Platform.OS === 'web' ? 'web' : 'native',
        origin: Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : null,
        onStep: setSteps,
      });
      setSteps(r.steps);
      if (r.ok) {
        if (r.conditionalWrites !== null && cur.kind !== 'https' && r.conditionalWrites !== cur.conditionalWrites) await storage.updateCurrent({ ...cur, conditionalWrites: r.conditionalWrites });
        else await storage.markTested(r.at);
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <StorageScreen title={t('storage.title')} testID="storage-screen">
      <Section title={t('storage.current')}>
        {!cur ? (
          <>
            <Text testID="storage-local" style={{ fontSize: 16, fontWeight: '600', color: c.text }} maxFontSizeMultiplier={2}>
              {t('storage.localOnly')}
            </Text>
            <Muted>{t('storage.localOnlyHelp')}</Muted>
            <Button label={t('storage.connect')} onPress={() => router.push('/storage/setup')} testID="storage-connect" />
          </>
        ) : (
          <>
            <Text testID="storage-protocol" style={{ fontSize: 16, fontWeight: '600', color: c.text }} maxFontSizeMultiplier={2}>
              {t(`storage.protocol.${protocolOf(cur)}`)}
            </Text>
            {writeAddressOf(cur) && <Address label={t('storage.writeAddress')} value={writeAddressOf(cur)!} testID="storage-write-address" />}
            <Address label={t('storage.readAddress')} value={cur.readUrl} testID="storage-read-address" />
            <Muted>{t('storage.readAddressHelp')}</Muted>
            {cur.kind !== 'https' && !cur.conditionalWrites && <Banner tone="warning">{t('storage.conditionalEmulated')}</Banner>}
            {storage.state.republishPending && <Banner testID="storage-republish">{t('storage.republishPending')}</Banner>}
            {storage.state.lastTestAt && <Muted>{t('storage.lastTest', { date: date(storage.state.lastTestAt) })}</Muted>}
            <View style={styles.row}>
              <Button label={running ? t('storage.testing') : t('storage.test')} onPress={() => void test()} disabled={running} testID="storage-test" />
              <Button kind="secondary" label={t('storage.edit')} onPress={() => router.push('/storage/setup?mode=edit')} testID="storage-edit" />
              <Button kind="secondary" label={t('storage.change')} onPress={() => router.push('/storage/setup?mode=move')} testID="storage-change" />
            </View>
            {steps && <TestResults steps={steps} />}
          </>
        )}
      </Section>

      {storage.state.previous.length > 0 && (
        <Section title={t('storage.previous')}>
          <Muted>{t('storage.previousHelp')}</Muted>
          {storage.state.previous.map((p) => (
            <View key={p.config.readUrl} style={{ gap: 4 }} testID="storage-previous">
              <Address label={t(`storage.protocol.${protocolOf(p.config)}`)} value={p.config.readUrl} />
              <Muted>{t('storage.redirectUntil', { date: date(p.keepUntil) })}</Muted>
              {p.keepUntil < Date.now() && <Button kind="secondary" label={t('storage.forget')} onPress={() => void storage.forgetPrevious(p.config.readUrl)} />}
            </View>
          ))}
        </Section>
      )}

      <Section title={t('storage.about')}>
        <Muted>{t('storage.aboutEncrypted')}</Muted>
        <Muted>{t('storage.aboutMaster')}</Muted>
      </Section>
    </StorageScreen>
  );
}

export default function StorageRoute() {
  return (
    <DataGate>
      <StorageOverview />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
