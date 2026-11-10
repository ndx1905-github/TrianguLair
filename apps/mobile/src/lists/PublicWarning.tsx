/**
 * The warning before a list goes public (spec "Privacy": "Warning when a place looks like a home
 * (residential address) before adding it to a public list"; "Moderation": "A public list is
 * published on its author's storage, under their responsibility"; threat model: a public list
 * can expose a third party's private address). Shown in the list editor and the share screen.
 */
import { Text, View } from 'react-native';
import type { PlaceRecord } from '@triangulair/data';

import { Button } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { homeLikePlaces } from './sharing';

export function PublicWarning({ places, onConfirm, onCancel, busy, testID = 'public-warning' }: { places: readonly PlaceRecord[]; onConfirm?: () => void; onCancel?: () => void; busy?: boolean; testID?: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  const homes = homeLikePlaces(places);
  return (
    <View style={{ borderWidth: 1, borderRadius: 14, padding: 14, gap: 8, borderColor: c.warning, backgroundColor: c.surfaceAlt }} testID={testID}>
      <Text style={{ color: c.warning, fontSize: 16, fontWeight: '700' }} maxFontSizeMultiplier={2}>
        {t('sharing.public.warnTitle')}
      </Text>
      <Text style={{ color: c.text, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {t('sharing.public.warnAnyone')}
      </Text>
      <Text style={{ color: c.text, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {t('sharing.public.warnHomes')}
      </Text>
      {homes.length > 0 && (
        <View style={{ gap: 4 }} testID={`${testID}-homes`}>
          <Text style={{ color: c.text, fontSize: 14, fontWeight: '700' }} maxFontSizeMultiplier={2}>
            {t('sharing.public.homesFound', { count: homes.length })}
          </Text>
          {homes.slice(0, 8).map((p) => (
            <Text key={p.id} style={{ color: c.text, fontSize: 14 }} maxFontSizeMultiplier={2}>
              {`• ${p.name || t('sharing.unnamed')}`}
            </Text>
          ))}
        </View>
      )}
      <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2}>
        {t('sharing.public.warnLicense')}
      </Text>
      {(onConfirm || onCancel) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {onConfirm && <Button label={t('sharing.public.publish')} onPress={onConfirm} disabled={busy} testID={`${testID}-confirm`} />}
          {onCancel && <Button kind="secondary" label={t('common.cancel')} onPress={onCancel} disabled={busy} testID={`${testID}-cancel`} />}
        </View>
      )}
    </View>
  );
}
