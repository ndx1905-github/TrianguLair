/**
 * Settings › Storage in this browser (web only; nothing on the phones): whether the browser
 * promised to keep this site's data (`navigator.storage.persisted()`), how much it holds, a button
 * to ask again (`persist()`), how to install the app on an iPhone, and why the recovery kit matters
 * more here: a browser can clear its data, and with it this device's keys and places.
 */
import { useCallback, useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Banner, Button, SectionTitle } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { formatBytes } from '../sync/problems';
import { browserStorage, requestPersistence, type BrowserStorage } from './pwa';

function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  // iPadOS reports itself as a Mac with touch.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function BrowserStorageSection({ kitPending }: { kitPending: boolean }) {
  const c = useUiColors();
  const { t, locale } = useI18n();
  const router = useRouter();
  const [info, setInfo] = useState<BrowserStorage | null>(null);
  const [refused, setRefused] = useState(false);
  const load = useCallback(() => {
    void browserStorage().then(setInfo);
  }, []);
  useEffect(load, [load]);
  if (Platform.OS !== 'web' || !info) return null;

  const muted = { color: c.textMuted, fontSize: 14 } as const;
  const ask = async () => {
    const ok = await requestPersistence();
    setRefused(ok !== true);
    load();
  };

  return (
    <View style={{ gap: 10 }} testID="settings-browser-storage">
      <SectionTitle>{t('pwa.storage')}</SectionTitle>
      <Text style={{ color: info.persisted === false ? c.warning : c.text, fontSize: 14 }} maxFontSizeMultiplier={2} testID="settings-browser-persisted">
        {info.persisted === true ? t('pwa.storage.persisted') : info.persisted === false ? t('pwa.storage.notPersisted') : t('pwa.storage.unknown')}
      </Text>
      {info.usage !== null && info.quota !== null && (
        <Text style={muted} maxFontSizeMultiplier={2} testID="settings-browser-usage">
          {t('pwa.storage.usage', { usage: formatBytes(info.usage, locale), quota: formatBytes(info.quota, locale) })}
        </Text>
      )}
      {info.supported && info.persisted !== true && (
        <Button kind="secondary" label={t('pwa.storage.ask')} onPress={() => void ask()} testID="settings-browser-persist" />
      )}
      {refused && info.persisted !== true && <Text style={muted} maxFontSizeMultiplier={2}>{t('pwa.storage.refused')}</Text>}
      {isAppleMobile() && !info.installed && <Text style={muted} maxFontSizeMultiplier={2}>{t('pwa.storage.install')}</Text>}
      <Banner tone={kitPending ? 'warning' : 'info'} testID="settings-browser-kit">
        {t('pwa.storage.kit')}
      </Banner>
      {kitPending && <Button label={t('pwa.storage.kitOpen')} onPress={() => router.push('/kit')} testID="settings-browser-kit-open" />}
    </View>
  );
}
