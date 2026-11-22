import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Redirect, useRouter } from 'expo-router';

import { Banner, Button } from '../../components/ui';
import { Frame } from '../../firstLaunch/Frame';
import { ProfileFields } from '../../firstLaunch/ProfileFields';
import { stepOf } from '../../firstLaunch/steps';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useIdentity, type Profile } from '../../identity/IdentityProvider';
import { LinkOriginField } from '../../links/LinkOriginField';
import { linkOrigin, linkOriginIsPlaceholder, parseLinkOrigin, saveLinkOrigin } from '../../links/origin';

/**
 * First name and photo (optional). The keys are created in the background
 * meanwhile (spec: no dedicated screen), and stored when the user continues.
 */
export default function ProfileStep() {
  const { state, prepare, create } = useIdentity();
  const { t } = useI18n();
  const c = useUiColors();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile>({ name: '', avatar: null });
  const [keys, setKeys] = useState<'making' | 'ready' | 'failed'>('making');
  const [saving, setSaving] = useState(false);
  // Prefilled with the web app's own address; empty on phones until the user gives one.
  const [origin, setOrigin] = useState(() => (linkOriginIsPlaceholder() ? '' : linkOrigin()));
  const originInvalid = origin.trim() !== '' && parseLinkOrigin(origin) === null;

  useEffect(() => {
    if (state.kind !== 'none') return;
    let live = true;
    prepare().then(
      () => live && setKeys('ready'),
      () => live && setKeys('failed'),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  if (state.kind === 'ready' && !saving) return <Redirect href={state.onboarding === 'done' ? '/' : `/welcome/${state.onboarding}`} />;

  const next = async () => {
    if (originInvalid) return;
    setSaving(true);
    try {
      saveLinkOrigin(parseLinkOrigin(origin));
      await create({ name: profile.name.trim(), avatar: profile.avatar });
      router.replace('/welcome/lock');
    } catch (e) {
      console.error('Identity not created', e);
      setKeys('failed');
      setSaving(false);
    }
  };

  return (
    <Frame
      title={t('profile.title')}
      lead={t('profile.lead')}
      step={stepOf('profile')}
      testID="welcome-profile"
      actions={<Button label={t('common.continue')} onPress={() => void next()} disabled={saving || keys === 'failed' || originInvalid} testID="profile-continue" />}
    >
      <ProfileFields value={profile} onChange={setProfile} autoFocus />
      <LinkOriginField value={origin} onChange={setOrigin} invalid={originInvalid} />
      {keys === 'failed' ? (
        <Banner tone="warning">{t('profile.failed')}</Banner>
      ) : (
        <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} testID={`keys-${keys}`} accessibilityLiveRegion="polite">
          {keys === 'ready' ? `✓ ${t('profile.keyReady')}` : t('profile.preparing')}
        </Text>
      )}
    </Frame>
  );
}
