/**
 * "Declare the primary device lost" (spec "Loss and theft", T-207): the primary device holds the
 * master key, so a key change is not enough. With the 12 words, a new identity (new phrase and
 * master key) is created, the move is signed by the old master key and countersigned by the new
 * one, and published in every index of the new identity at the same read address. Friends see
 * "… changed their identity" and lose the verified mark until they compare the safety code again.
 * This device becomes the new primary device; the new recovery kit is shown next.
 */
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button } from '../../components/ui';
import { deviceName } from '../../devices/local';
import { WordsField } from '../../devices/ui';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useIdentity, useReadyIdentity } from '../../identity/IdentityProvider';
import { Muted, Section, StorageScreen } from '../../storage/components';
import { useStorage } from '../../storage/StorageProvider';
import { StorageNeeded } from '../../storage/useStorageForSharing';
import { useSync } from '../../sync/SyncProvider';

function IdentityScreen() {
  const { t } = useI18n();
  const c = useUiColors();
  const router = useRouter();
  const identity = useIdentity();
  const ready = useReadyIdentity();
  const storage = useStorage();
  const sync = useSync();
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'wrong' | 'failed' | null>(null);
  const hasStorage = !!storage.state.current && storage.state.current.kind !== 'https';

  const go = async () => {
    setBusy(true);
    setError(null);
    let moved;
    try {
      moved = await identity.prepareMove(phrase);
    } catch {
      setBusy(false);
      return setError('wrong');
    }
    try {
      await sync.prepareIdentityMove({ owner: moved.record.owner, deviceCert: moved.record.deviceCert, deviceName: deviceName(), added: ready.record.createdAt });
      await identity.adoptMovedIdentity(moved);
      router.replace('/kit');
    } catch (e) {
      console.warn('Identity change failed', e);
      setBusy(false);
      setError('failed');
    }
  };

  return (
    <StorageScreen title={t('idmove.title')} testID="idmove-screen">
      <Muted>{t('idmove.lead')}</Muted>
      {!hasStorage ? (
        <StorageNeeded reason="devices" returnTo="/devices/identity" />
      ) : (
        <>
          <Section title={t('lost.what.title')}>
            {(['friends', 'devices', 'kit', 'access'] as const).map((k) => (
              <Text key={k} style={{ color: c.text, fontSize: 15 }} maxFontSizeMultiplier={2}>
                {`• ${t(`idmove.what.${k}`)}`}
              </Text>
            ))}
          </Section>
          <WordsField label={t('idmove.words')} value={phrase} onChange={setPhrase} testID="idmove-phrase" error={error === 'wrong'} />
          {error && <Banner tone="warning" testID="idmove-error">{t(error === 'wrong' ? 'idmove.wrong' : 'idmove.failed')}</Banner>}
          {busy ? (
            <View style={styles.row}>
              <ActivityIndicator color={c.accent} />
              <Muted>{t('idmove.working')}</Muted>
            </View>
          ) : (
            <Button kind="danger" label={t('idmove.go')} onPress={() => void go()} disabled={phrase.trim().split(/\s+/).length !== 12} testID="idmove-go" />
          )}
        </>
      )}
    </StorageScreen>
  );
}

export default function IdentityRoute() {
  return (
    <DataGate>
      <IdentityScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
});
