import { Text, TextInput, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';

import { Button } from '../../components/ui';
import { Frame, Phase2Badge } from '../../firstLaunch/Frame';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useIdentity } from '../../identity/IdentityProvider';

/**
 * "I received an invitation link" (spec "Three entry points"): paste the link
 * (it does not always survive the installation). Opening it needs sharing (phase 2).
 */
export default function InvitationEntry() {
  const { state } = useIdentity();
  const { t } = useI18n();
  const c = useUiColors();
  const router = useRouter();
  if (state.kind === 'ready') return <Redirect href="/" />;
  return (
    <Frame
      title={t('invite.title')}
      lead={t('invite.lead')}
      testID="welcome-invitation-screen"
      actions={
        <>
          <Button label={t('invite.open')} onPress={() => {}} disabled testID="invite-open" />
          <Button kind="secondary" label={t('device.startInstead')} onPress={() => router.replace('/welcome/profile')} testID="invite-start" />
        </>
      }
    >
      <View style={{ gap: 6 }}>
        <Text style={{ color: c.textMuted, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
          {t('invite.link')}
        </Text>
        <TextInput
          editable={false}
          placeholder="https://…"
          placeholderTextColor={c.textMuted}
          style={{ borderWidth: 1, borderRadius: 12, borderColor: c.border, backgroundColor: c.surfaceAlt, color: c.textMuted, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, minHeight: 48 }}
          accessibilityLabel={t('invite.link')}
          maxFontSizeMultiplier={2}
        />
        <Phase2Badge />
      </View>
      <Frame.Note>{t('phase2.localOnly')}</Frame.Note>
    </Frame>
  );
}
