/**
 * "Delete all my content" (gap #6, spec "Editing and deleting" and "Store rules"): what will happen, two
 * confirmations (a switch, then the word typed), then the SyncProvider runs it and shows its progress and summary in
 * place of the app (`privacy/ContentDeleted.tsx`).
 */
import { useState } from 'react';
import { View } from 'react-native';

import { DataGate } from '../components/DataGate';
import { Banner, Button } from '../components/ui';
import { Card, Strong } from '../contacts/ui';
import { ToggleRow } from '../firstLaunch/ToggleRow';
import { useI18n } from '../i18n';
import { Field, Muted, Section, StorageScreen } from '../storage/components';
import { useSync } from '../sync/SyncProvider';

function DeleteAllScreen() {
  const { t } = useI18n();
  const sync = useSync();
  const [understood, setUnderstood] = useState(false);
  const [word, setWord] = useState('');
  const expected = t('deleteAll.word');
  const publishes = !!sync.snapshot?.publishes;
  const offline = sync.snapshot?.status.state === 'offline';
  const ok = understood && word.trim().toLocaleUpperCase() === expected.toLocaleUpperCase();

  return (
    <StorageScreen title={t('deleteAll.title')} testID="delete-all-screen">
      <Muted>{t('deleteAll.intro')}</Muted>
      <Section title={t('deleteAll.whatTitle')}>
        <Card testID="delete-all-what">
          <Strong>{t('deleteAll.what.device')}</Strong>
          <Muted>{publishes ? t('deleteAll.what.storage') : t('deleteAll.what.localOnly')}</Muted>
          <Muted>{t('deleteAll.what.friends')}</Muted>
          <Muted>{t('deleteAll.what.contacts')}</Muted>
          <Muted>{t('deleteAll.what.otherDevices')}</Muted>
          <Muted>{t('deleteAll.what.kit')}</Muted>
          <Muted>{t('deleteAll.what.copies')}</Muted>
        </Card>
        <Muted>{t('deleteAll.exportFirst')}</Muted>
      </Section>
      {publishes && offline && <Banner tone="warning" testID="delete-all-offline">{t('deleteAll.offline')}</Banner>}
      <Section title={t('deleteAll.confirmTitle')}>
        <ToggleRow label={t('deleteAll.understand')} value={understood} onChange={setUnderstood} testID="delete-all-understand" />
        {understood && (
          <View style={{ gap: 8 }}>
            <Field label={t('deleteAll.typeWord', { word: expected })} value={word} onChange={setWord} testID="delete-all-word" />
            <Button kind="danger" label={t('deleteAll.go')} onPress={() => sync.deleteAllContent()} disabled={!ok || (publishes && offline)} testID="delete-all-go" />
          </View>
        )}
      </Section>
    </StorageScreen>
  );
}

export default function DeleteAllRoute() {
  return (
    <DataGate>
      <DeleteAllScreen />
    </DataGate>
  );
}
