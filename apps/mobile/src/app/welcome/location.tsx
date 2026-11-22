import { useState } from 'react';
import { useRouter } from 'expo-router';

import { Banner, Button } from '../../components/ui';
import { setSetting } from '../../data/deviceSettings';
import { Frame } from '../../firstLaunch/Frame';
import { stepOf } from '../../firstLaunch/steps';
import { useOnboardingGuard } from '../../firstLaunch/useOnboardingGuard';
import { useI18n } from '../../i18n';
import { useIdentity } from '../../identity/IdentityProvider';
import { locateMe } from '../../location';

/**
 * Location (optional), explained before the system prompt (spec): only to
 * center the map, kept on the device (`start-position`), never sent. `locateMe` works without
 * Google Play services on Android (src/location).
 */
export default function LocationStep() {
  const guard = useOnboardingGuard('location');
  const { t } = useI18n();
  const router = useRouter();
  const { setOnboarding } = useIdentity();
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  if (guard) return guard;

  const next = () => {
    setOnboarding('import');
    router.replace('/welcome/import');
  };

  const allow = async () => {
    setBusy(true);
    try {
      const r = await locateMe();
      if (!r.ok) {
        setDenied(true);
        return;
      }
      setSetting('start-position', JSON.stringify({ lat: r.fix.lat, lon: r.fix.lon }));
      next();
    } catch {
      setDenied(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame
      title={t('location.title')}
      lead={t('location.lead')}
      step={stepOf('location')}
      testID="welcome-location"
      actions={
        denied ? (
          <Button label={t('common.continue')} onPress={next} testID="location-continue" />
        ) : (
          <>
            <Button label={t('location.allow')} onPress={() => void allow()} disabled={busy} testID="location-allow" />
            <Button kind="secondary" label={t('common.notNow')} onPress={next} testID="location-skip" />
          </>
        )
      }
    >
      {denied && <Banner>{t('location.denied')}</Banner>}
    </Frame>
  );
}
