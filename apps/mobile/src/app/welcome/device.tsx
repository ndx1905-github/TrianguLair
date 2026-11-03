import { Redirect, useRouter } from 'expo-router';

import { Button } from '../../components/ui';
import { Frame, UnavailableOption } from '../../firstLaunch/Frame';
import { useI18n } from '../../i18n';
import { useIdentity } from '../../identity/IdentityProvider';

/**
 * "I already have TrianguLair on another device" (spec "Adding a device"):
 * the three ways, from the safest; they need sharing (phase 2).
 */
export default function DeviceEntry() {
  const { state } = useIdentity();
  const { t } = useI18n();
  const router = useRouter();
  if (state.kind === 'ready') return <Redirect href="/" />;
  return (
    <Frame
      title={t('device.title')}
      lead={t('device.lead')}
      testID="welcome-device-screen"
      actions={
        <>
          <Button label={t('device.startInstead')} onPress={() => router.replace('/welcome/profile')} testID="device-start" />
          <Button kind="secondary" label={t('common.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))} />
        </>
      }
    >
      <UnavailableOption label={t('device.qr')} help={t('device.qrHelp')} testID="device-qr" />
      <UnavailableOption label={t('device.link')} help={t('device.linkHelp')} testID="device-link" />
      <UnavailableOption label={t('device.phrase')} help={t('device.phraseHelp')} testID="device-phrase" />
      <Frame.Note>{t('phase2.localOnly')}</Frame.Note>
    </Frame>
  );
}
