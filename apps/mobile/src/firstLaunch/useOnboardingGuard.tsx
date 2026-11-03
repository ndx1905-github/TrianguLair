import { Redirect } from 'expo-router';

import { useIdentity, type OnboardingStep } from '../identity/IdentityProvider';

/**
 * For the steps after the identity exists: a redirect element when this is not
 * the step to show (no identity yet, or first launch finished), else null.
 */
export function useOnboardingGuard(step: Exclude<OnboardingStep, 'done'>) {
  const { state } = useIdentity();
  if (state.kind === 'none') return <Redirect href="/welcome" />;
  if (state.kind === 'ready' && state.onboarding === 'done') return <Redirect href="/" />;
  void step;
  return null;
}
