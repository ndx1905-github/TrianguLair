/**
 * Deep links `https://triangulair.app/i#…` (invitation) and `/r#…` (return link), also
 * `triangulair://i#…`. The fragment is read from the URL that opened the app (web: the address
 * bar, then removed from it and from the history entry), handed to the screen in memory, never as
 * a query parameter. Before my identity exists (the app was installed from the link), the
 * invitation waits in the secret store and the first launch starts ("I received an invitation").
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter, type Href } from 'expo-router';

import { useUiColors } from '../hooks/useUiColors';
import { useIdentity } from '../identity/IdentityProvider';
import { useContacts } from './ContactsProvider';
import { findLink, INVITE_PREFIX, RETURN_PREFIX } from './links';
import { setPendingLink } from './pending';

/**
 * The link that opened this route. On web the page may be served from another origin (test
 * builds), so the canonical link is rebuilt from the route and the fragment.
 */
function currentUrl(kind: 'invitation' | 'return', native: string | null): string | null {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const hash = window.location.hash.slice(1);
    try {
      // Keep the secret out of the address bar and the history.
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    } catch {
      // Not allowed: harmless.
    }
    return hash ? (kind === 'invitation' ? INVITE_PREFIX : RETURN_PREFIX) + hash : null;
  }
  return native;
}

export function LinkOpener({ kind }: { kind: 'invitation' | 'return' }) {
  const c = useUiColors();
  const router = useRouter();
  const identity = useIdentity();
  const svc = useContacts();
  const native = Linking.useLinkingURL();
  const [url] = useState(() => currentUrl(kind, native));
  const link = findLink(url ?? native ?? '');

  useEffect(() => {
    if (identity.state.kind === 'loading') return;
    if (!link || link.kind !== kind) {
      router.replace(kind === 'invitation' ? '/invite/received' : '/invite');
      return;
    }
    if (identity.state.kind !== 'ready' || identity.state.onboarding !== 'done') {
      // First launch (or not finished): the invitation waits for my identity (PendingInvitation).
      const next = identity.state.kind === 'ready' ? `/welcome/${identity.state.onboarding}` : kind === 'invitation' ? '/welcome/invitation' : '/welcome';
      if (kind === 'invitation' && identity.secrets) void identity.secrets.set('pending-invitation', link.link).then(() => router.replace(next as Href));
      else router.replace(next as Href);
      return;
    }
    if (kind === 'invitation') {
      setPendingLink(link.link);
      router.replace('/invite/received');
      return;
    }
    if (!svc) return;
    svc.receiveAnswer(link.link).then(
      (r) => router.replace(`/invite/answers?id=${encodeURIComponent(r.invitationId)}` as Href),
      () => {
        setPendingLink(link.link);
        router.replace('/invite');
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.state.kind, svc]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background }} testID="link-opener">
      <ActivityIndicator color={c.accent} />
    </View>
  );
}
