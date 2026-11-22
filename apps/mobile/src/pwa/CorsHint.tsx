/**
 * Web only: a storage that does not allow the web version's address (CORS) looks like a storage
 * that does not answer, since the browser hides the reason. The web version can use only the
 * storages that allow its origin: the owner's, and each friend's whose places it reads. These hints
 * say so where the app reports a storage that does not answer, with a link to the hosting guide
 * (docs/self-host-web.md). The phone apps are not affected and show nothing.
 */
import { Linking, Platform, Pressable, Text, View } from 'react-native';

import { WEB_HOSTING_GUIDE_URL } from '../config';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

/** "How to allow it" (opens the guide in a new tab). */
export function WebGuideLink({ testID = 'cors-guide' }: { testID?: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  if (Platform.OS !== 'web') return null;
  return (
    <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(WEB_HOSTING_GUIDE_URL)} testID={testID}>
      <Text style={{ color: c.accent, fontSize: 14, textDecorationLine: 'underline' }} maxFontSizeMultiplier={2}>
        {t('pwa.cors.guide')}
      </Text>
    </Pressable>
  );
}

/** Under "your storage does not answer" (`own`) or a friend's storage that does not answer (`friend`). */
export function CorsHint({ who, testID }: { who: 'own' | 'friend'; testID?: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  if (Platform.OS !== 'web') return null;
  return (
    <View style={{ gap: 4 }} testID={testID ?? `cors-hint-${who}`}>
      <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2}>
        {t(who === 'own' ? 'pwa.cors.own' : 'pwa.cors.friend')}
      </Text>
      <WebGuideLink />
    </View>
  );
}
