import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';

import { Button } from '../../components/ui';
import { CodeFields, codeProblem, type CodeDraft } from '../../firstLaunch/CodeFields';
import { Frame } from '../../firstLaunch/Frame';
import { stepOf } from '../../firstLaunch/steps';
import { ToggleRow } from '../../firstLaunch/ToggleRow';
import { useOnboardingGuard } from '../../firstLaunch/useOnboardingGuard';
import { useI18n } from '../../i18n';
import { useIdentity } from '../../identity/IdentityProvider';
import { useAppLock } from '../../identity/LockGate';
import { defaultLockSettings } from '../../identity/lock';

/**
 * App lock, offered at installation (spec "Protections on the device"): on by
 * default, with the app's own code, when the phone has no screen lock;
 * otherwise an offer to also ask for the phone's own unlock.
 */
export default function LockStep() {
  const guard = useOnboardingGuard('lock');
  const { t } = useI18n();
  const router = useRouter();
  const { setOnboarding } = useIdentity();
  const lock = useAppLock();
  const defaults = defaultLockSettings(lock.security);
  const [on, setOn] = useState(defaults.enabled);
  const [draft, setDraft] = useState<CodeDraft>({ code: '', again: '' });
  const [tried, setTried] = useState(false);
  const [touched, setTouched] = useState(false);
  // The phone's lock level is read asynchronously: follow the default until the user chooses.
  useEffect(() => {
    if (!touched) setOn(defaults.enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lock.security]);
  if (guard) return guard;

  const deviceMethod = defaults.method === 'device';
  const lead =
    lock.security === 'none'
      ? t('lockStep.noScreenLock')
      : deviceMethod
        ? t('lockStep.withScreenLock', { method: t(lock.security === 'biometric' ? 'lockStep.methodBiometric' : 'lockStep.methodPasscode') })
        : t('lockStep.web');
  const needsCode = on && !deviceMethod;

  const finish = async (enabled: boolean) => {
    if (enabled && needsCode) {
      setTried(true);
      if (codeProblem(draft)) return;
      await lock.setCode(draft.code);
    }
    lock.setSettings({ ...defaults, enabled });
    setOnboarding('location');
    router.replace('/welcome/location');
  };

  return (
    <Frame
      title={t('lockStep.title')}
      lead={lead}
      step={stepOf('lock')}
      testID="welcome-lock"
      actions={
        <>
          <Button label={t('common.continue')} onPress={() => void finish(on)} testID="lock-continue" />
          <Button kind="secondary" label={t('common.notNow')} onPress={() => void finish(false)} testID="lock-skip" />
        </>
      }
    >
      <ToggleRow label={t('lockStep.enable')} help={t('lockStep.later')} value={on} onChange={(v) => { setTouched(true); setOn(v); }} testID="lock-toggle" />
      {needsCode && <CodeFields value={draft} onChange={setDraft} showErrors={tried} />}
    </Frame>
  );
}
