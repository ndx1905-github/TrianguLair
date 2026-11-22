/**
 * Deep link `https://example.org/l#…` (a list link, T-212; also `triangulair://l#…`). The
 * fragment holds the list key of a link-only list: it is read from the URL that opened the app
 * (web: the address bar, then removed from it and from the history entry), handed to "Follow a
 * list" in memory, never as a query parameter, and never sent anywhere.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';

import { listPrefix, findLink } from '../contacts/links';
import { setPendingLink } from '../contacts/pending';
import { useUiColors } from '../hooks/useUiColors';
import { useIdentity } from '../identity/IdentityProvider';

function currentUrl(native: string | null): string | null {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const hash = window.location.hash.slice(1);
    try {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    } catch {
      // Not allowed: harmless.
    }
    return hash ? listPrefix() + hash : null;
  }
  return native;
}

export default function ListLinkRoute() {
  const c = useUiColors();
  const router = useRouter();
  const identity = useIdentity();
  const native = Linking.useLinkingURL();
  const [url] = useState(() => currentUrl(native));

  useEffect(() => {
    if (identity.state.kind === 'loading') return;
    const link = findLink(url ?? native ?? '');
    if (identity.state.kind !== 'ready' || identity.state.onboarding !== 'done') {
      // Not set up yet: first launch; the link can be pasted afterwards (Follow a list by link).
      router.replace(identity.state.kind === 'ready' ? `/welcome/${identity.state.onboarding}` : '/welcome');
      return;
    }
    if (link?.kind === 'list') setPendingLink(link.link);
    router.replace('/lists/follow');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.state.kind]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background }} testID="list-link-opener">
      <ActivityIndicator color={c.accent} />
    </View>
  );
}
