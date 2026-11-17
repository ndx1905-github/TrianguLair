import { ActivityIndicator, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';

import { Banner, Button } from '../../components/ui';
import { Frame, SecretStoreNotice } from '../../firstLaunch/Frame';
import { Hero } from '../../firstLaunch/Hero';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useIdentity } from '../../identity/IdentityProvider';

/** First launch, step 1 (spec "Three entry points"): the promise, then three ways in. */
export default function Welcome() {
  const { state } = useIdentity();
  const { t } = useI18n();
  const router = useRouter();
  const c = useUiColors();
  if (state.kind === 'ready') return <Redirect href={state.onboarding === 'done' ? '/' : `/welcome/${state.onboarding}`} />;
  if (state.kind !== 'none') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background }}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  if (state.keysMissing) {
    // Spec "Error cases", key missing from the phone's vault: nothing syncs; the recovery kit restores.
    return (
      <Frame
        title={t('welcome.keysMissing.title')}
        lead={t('welcome.keysMissing.lead')}
        testID="welcome-keys-missing"
        actions={
          <>
            <Button label={t('welcome.keysMissing.restore')} onPress={() => router.push('/welcome/device?way=phrase')} testID="keys-missing-restore" />
            <Button kind="secondary" label={t('welcome.haveDevice')} onPress={() => router.push('/welcome/device')} testID="keys-missing-device" />
          </>
        }
      >
        <Banner tone="warning">{t('welcome.keysMissing.help')}</Banner>
      </Frame>
    );
  }
  return (
    <Frame
      title={t('welcome.promise')}
      lead={t('welcome.lead')}
      header={<Hero />}
      testID="welcome"
      actions={
        <>
          <Button label={t('welcome.start')} onPress={() => router.push('/welcome/profile')} testID="welcome-start" />
          <Button kind="secondary" label={t('welcome.haveDevice')} onPress={() => router.push('/welcome/device')} testID="welcome-device" />
          <Button kind="secondary" label={t('welcome.invited')} onPress={() => router.push('/welcome/invitation')} testID="welcome-invitation" />
        </>
      }
    >
      <SecretStoreNotice kind={state.secretStore} />
    </Frame>
  );
}
