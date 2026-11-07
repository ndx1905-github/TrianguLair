/**
 * "Storage: offered the first time the user wants to share (invite a friend, create a link-only
 * or public list)" (spec "Later, at the right moment"). The sharing flows call this before
 * anything that publishes:
 *
 *   const storage = useStorageForSharing();
 *   if (!storage.ensure('invite', '/invite')) return;   // opens the wizard, comes back after
 *
 * `StorageNeeded` is the inline card for screens that prefer to explain first.
 */
import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { Button } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { useStorage } from './StorageProvider';

export type SharingReason = 'invite' | 'link-list' | 'public-list' | 'backup';

/** The wizard's address for a reason and a screen to come back to. */
export function setupHref(reason: SharingReason, returnTo?: string): string {
  const q = new URLSearchParams({ reason });
  if (returnTo) q.set('return', returnTo);
  return `/storage/setup?${q.toString()}`;
}

/** Only in-app paths are followed back (never a full URL from a link). */
export function safeReturn(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^\/(?!\/)[\w\-/[\]?=&%.]*$/.test(s) ? s : null;
}

export function useStorageForSharing() {
  const storage = useStorage();
  const router = useRouter();
  const connected = storage.state.current !== null;
  const ensure = useCallback(
    (reason: SharingReason, returnTo?: string): boolean => {
      if (storage.state.current) return true;
      router.push(setupHref(reason, returnTo) as Href);
      return false;
    },
    [storage.state, router],
  );
  return { loaded: storage.loaded, connected, ensure };
}

export function StorageNeeded({ reason, returnTo }: { reason: SharingReason; returnTo?: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  const router = useRouter();
  return (
    <View style={[styles.card, { backgroundColor: c.surfaceAlt, borderColor: c.border }]} testID="storage-needed">
      <Text style={{ color: c.text, fontWeight: '700', fontSize: 15 }} maxFontSizeMultiplier={2}>
        {t('storage.needed.title')}
      </Text>
      <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {t(`storage.needed.${reason}`)}
      </Text>
      <Button label={t('storage.needed.connect')} onPress={() => router.push(setupHref(reason, returnTo) as Href)} testID="storage-needed-connect" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8 },
});

/** `StorageNeeded` only while no storage is connected (list editor, invitation screens). */
export function StorageNeededIfMissing(props: { reason: SharingReason; returnTo?: string }) {
  const { loaded, connected } = useStorageForSharing();
  if (!loaded || connected) return null;
  return <StorageNeeded {...props} />;
}
