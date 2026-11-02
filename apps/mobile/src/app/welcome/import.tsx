import { useRouter } from 'expo-router';

import { Button } from '../../components/ui';
import { Frame } from '../../firstLaunch/Frame';
import { stepOf } from '../../firstLaunch/steps';
import { useOnboardingGuard } from '../../firstLaunch/useOnboardingGuard';
import { useI18n } from '../../i18n';
import { useIdentity } from '../../identity/IdentityProvider';

/** "Import?" (spec "Standard flow"): the import screen, or straight to the map with a hint on "+". */
export default function ImportStep() {
  const guard = useOnboardingGuard('import');
  const { t } = useI18n();
  const router = useRouter();
  const { setOnboarding } = useIdentity();
  if (guard) return guard;

  const done = (importNow: boolean) => {
    setOnboarding('done');
    router.replace('/');
    if (importNow) setTimeout(() => router.push('/import'), 0);
  };

  return (
    <Frame
      title={t('importStep.title')}
      lead={t('importStep.lead')}
      step={stepOf('import')}
      testID="welcome-import"
      actions={
        <>
          <Button label={t('importStep.import')} onPress={() => done(true)} testID="import-now" />
          <Button kind="secondary" label={t('importStep.later')} onPress={() => done(false)} testID="import-later" />
        </>
      }
    />
  );
}
