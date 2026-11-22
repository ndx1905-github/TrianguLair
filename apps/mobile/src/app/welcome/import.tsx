import { useRouter } from 'expo-router';

import { Button } from '../../components/ui';
import { Frame } from '../../firstLaunch/Frame';
import { stepOf } from '../../firstLaunch/steps';
import { useOnboardingGuard } from '../../firstLaunch/useOnboardingGuard';
import { useI18n } from '../../i18n';
import { useIdentity } from '../../identity/IdentityProvider';
import { useMaybeData } from '../../data/DataProvider';
import { requestExamples } from '../../data/useExamples';

/**
 * "Import?" (spec "Standard flow"): the import screen, or straight to the map with a hint on "+".
 * "Show me with examples" (beta feedback) also adds the example places, on this phone only.
 */
export default function ImportStep() {
  const guard = useOnboardingGuard('import');
  const { t } = useI18n();
  const router = useRouter();
  const { setOnboarding } = useIdentity();
  const data = useMaybeData();
  if (guard) return guard;

  const done = (importNow: boolean, examples = false) => {
    if (examples) requestExamples(data, t);
    setOnboarding('done');
    router.replace('/');
    if (importNow) setTimeout(() => router.push('/import'), 0);
  };

  return (
    <Frame
      title={t('importStep.title')}
      lead={`${t('importStep.lead')}\n\n${t('importStep.examplesHelp')}`}
      step={stepOf('import')}
      testID="welcome-import"
      actions={
        <>
          <Button label={t('importStep.import')} onPress={() => done(true)} testID="import-now" />
          <Button kind="secondary" label={t('importStep.examples')} onPress={() => done(false, true)} testID="import-examples" />
          <Button kind="secondary" label={t('importStep.later')} onPress={() => done(false)} testID="import-later" />
        </>
      }
    />
  );
}
