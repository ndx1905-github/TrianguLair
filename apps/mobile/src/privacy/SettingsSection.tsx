/**
 * Settings › My content: whether the local database is encrypted (gap #7), the example
 * places' one-tap delete (when there), the trash (gap #8), blocked people and
 * "Delete all my content" (gap #6). Kept in its own file so the settings screen only renders it.
 */
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { ExamplesSettings } from '../components/ExamplesSettings';
import { Button, SectionTitle } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useI18n } from '../i18n';
import { Muted } from '../storage/components';
import { trashItems } from '../trash/model';

export function MyContentSection() {
  const { t } = useI18n();
  const router = useRouter();
  const { repo, encryption } = useData();
  const inTrash = trashItems(repo, Date.now()).length;
  return (
    <View style={{ gap: 10 }} testID="settings-my-content">
      <SectionTitle>{t('myContent.title')}</SectionTitle>
      <Muted testID="settings-db-encryption">{t(`myContent.db.${encryption}`)}</Muted>
      <ExamplesSettings />
      <Muted>{t('trash.settingsHelp', { count: inTrash })}</Muted>
      <Button kind="secondary" label={t('trash.title')} onPress={() => router.push('/trash')} testID="settings-trash" />
      <Button kind="secondary" label={t('blocked.title')} onPress={() => router.push('/blocked')} testID="settings-blocked" />
      <Muted>{t('deleteAll.settingsHelp')}</Muted>
      <Button kind="danger" label={t('deleteAll.title')} onPress={() => router.push('/delete-all')} testID="settings-delete-all" />
    </View>
  );
}
