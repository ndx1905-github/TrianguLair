/**
 * Settings › My content: the trash (gap #8). Kept in its own file so the settings screen only renders it.
 */
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Button, SectionTitle } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useI18n } from '../i18n';
import { Muted } from '../storage/components';
import { trashItems } from '../trash/model';

export function MyContentSection() {
  const { t } = useI18n();
  const router = useRouter();
  const { repo } = useData();
  const inTrash = trashItems(repo, Date.now()).length;
  return (
    <View style={{ gap: 10 }} testID="settings-my-content">
      <SectionTitle>{t('myContent.title')}</SectionTitle>
      <Muted>{t('trash.settingsHelp', { count: inTrash })}</Muted>
      <Button kind="secondary" label={t('trash.title')} onPress={() => router.push('/trash')} testID="settings-trash" />
    </View>
  );
}
