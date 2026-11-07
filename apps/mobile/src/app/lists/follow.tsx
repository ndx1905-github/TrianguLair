/**
 * "Follow a list by link" (spec "Following a list without following the person"): a link-only list
 * is followed with its link alone. The sync package does not publish or read lists yet (T-212,
 * packages/sync README open question 3), so this entry only says it is coming; the link field is
 * shown disabled so the place of the feature is visible.
 */
import { TextInput } from 'react-native';

import { DataGate } from '../../components/DataGate';
import { Banner } from '../../components/ui';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { Muted, Section, StorageScreen } from '../../storage/components';

function FollowScreen() {
  const { t } = useI18n();
  const c = useUiColors();
  return (
    <StorageScreen title={t('follow.title')} testID="follow-list-screen">
      <Section title={t('follow.link')}>
        <Muted>{t('follow.lead')}</Muted>
        <TextInput
          editable={false}
          placeholder="https://triangulair.app/l#…"
          placeholderTextColor={c.textMuted}
          style={{ borderWidth: 1, borderRadius: 12, borderColor: c.border, backgroundColor: c.surfaceAlt, color: c.textMuted, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, minHeight: 48 }}
          accessibilityLabel={t('follow.link')}
          maxFontSizeMultiplier={2}
        />
        <Banner testID="follow-coming">{t('follow.coming')}</Banner>
      </Section>
    </StorageScreen>
  );
}

export default function FollowListRoute() {
  return (
    <DataGate>
      <FollowScreen />
    </DataGate>
  );
}
