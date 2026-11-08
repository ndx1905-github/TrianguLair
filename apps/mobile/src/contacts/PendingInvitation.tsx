/**
 * An invitation opened before my identity existed (first launch "I received an invitation link",
 * or a deep link that installed the app): once the first launch is over, its screen opens to make
 * the answer. Rendered once in the root layout; renders nothing.
 */
import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';

import { useIdentity } from '../identity/IdentityProvider';
import { useContacts } from './ContactsProvider';
import { setPendingLink } from './pending';

export function PendingInvitation() {
  const identity = useIdentity();
  const svc = useContacts();
  const router = useRouter();
  const done = useRef(false);
  const ready = identity.state.kind === 'ready' && identity.state.onboarding === 'done';
  useEffect(() => {
    if (!ready || !svc || !identity.secrets || done.current) return;
    done.current = true;
    const secrets = identity.secrets;
    void (async () => {
      const link = await secrets.get('pending-invitation');
      if (!link) return;
      await secrets.remove('pending-invitation');
      setPendingLink(link);
      router.push('/invite/received');
    })();
  }, [ready, svc, identity.secrets, router]);
  return null;
}
