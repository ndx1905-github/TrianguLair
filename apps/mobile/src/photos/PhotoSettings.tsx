/**
 * Settings › Photos (T-111b): the quality of new photos (spec, quota full: "reduce photo quality"),
 * the size of the friends' photo cache (spec: "cache capped at 500 MB by default, adjustable"), and
 * the room photos take on this device (the room on my storage is on the sync status screen).
 */
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { SectionTitle, Segmented } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { formatBytes } from '../sync/problems';
import { CACHE_CAPS_MB, MB, PHOTO_QUALITIES, cacheCapMb, photoQuality, setCacheCapMb, setPhotoQuality, type PhotoQuality } from './model';
import { usePhotosService } from './usePhotos';

export function PhotoSettings() {
  const c = useUiColors();
  const { t, locale } = useI18n();
  const svc = usePhotosService();
  const [quality, setQuality] = useState<PhotoQuality>(() => photoQuality());
  const [cap, setCap] = useState(() => cacheCapMb());
  const [usage, setUsage] = useState<{ mine: number; friends: number } | null>(null);
  useEffect(() => {
    if (svc) setUsage(svc.usage());
  }, [svc, cap]);
  const muted = { color: c.textMuted, fontSize: 14 } as const;

  return (
    <View style={{ gap: 10 }} testID="settings-photos">
      <SectionTitle>{t('settings.photos')}</SectionTitle>
      <Text style={muted} maxFontSizeMultiplier={2}>
        {t('settings.photoQuality')}
      </Text>
      <Segmented
        options={PHOTO_QUALITIES.map((q) => ({ value: q, label: t(`settings.photoQuality.${q}`) }))}
        value={quality}
        onChange={(q) => {
          setPhotoQuality(q);
          setQuality(q);
        }}
        testID="settings-photo-quality"
      />
      <Text style={muted} maxFontSizeMultiplier={2}>
        {t('settings.photoQualityHelp')}
      </Text>
      <Text style={muted} maxFontSizeMultiplier={2}>
        {t('settings.photoCache')}
      </Text>
      <Segmented
        options={CACHE_CAPS_MB.map((mb) => ({ value: mb, label: formatBytes(mb * MB, locale) }))}
        value={cap}
        onChange={(mb) => {
          setCacheCapMb(mb);
          setCap(mb);
          svc?.setFriendsCacheBytes(mb * MB);
        }}
        testID="settings-photo-cache"
      />
      <Text style={muted} maxFontSizeMultiplier={2}>
        {t('settings.photoCacheHelp')}
      </Text>
      {usage && (
        <Text style={muted} maxFontSizeMultiplier={2} testID="settings-photo-usage">
          {t('settings.photoUsage', { mine: formatBytes(usage.mine, locale), friends: formatBytes(usage.friends, locale) })}
        </Text>
      )}
    </View>
  );
}
