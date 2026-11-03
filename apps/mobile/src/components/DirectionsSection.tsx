import { Linking, Platform, StyleSheet, View } from 'react-native';
import type { PlaceRecord } from '@triangulair/data';

import { useI18n } from '../i18n';
import { defaultDirectionsUrl, directionsUrl, openInTargets, openInUrl, type LinkPlace, type Os } from '../places/directions';
import { Button, SectionTitle } from './ui';

function os(): Os {
  return Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web' ? Platform.OS : 'other';
}

async function open(url: string, fallback?: string) {
  try {
    if (Platform.OS === 'web') {
      // A new tab, so the app (and its unsaved state) stays open.
      globalThis.open?.(url, '_blank', 'noopener');
      return;
    }
    await Linking.openURL(url);
  } catch {
    if (fallback) await Linking.openURL(fallback).catch(() => undefined);
  }
}

/** "Go there" on the card (T-116): directions in the phone's navigation app, and the place in other maps. */
export function DirectionsSection({ place, address }: { place: PlaceRecord; address: string | null }) {
  const { t } = useI18n();
  const p: LinkPlace = { name: place.name, lat: place.lat, lon: place.lon, address, osmType: place.osmType, osmId: place.osmId };
  const system = os();
  return (
    <View testID="directions">
      <SectionTitle>{t('dir.title')}</SectionTitle>
      <View style={styles.wrap}>
        <Button
          label={`➜ ${t('dir.directions')}`}
          onPress={() => void open(defaultDirectionsUrl(system, p), directionsUrl('google', p))}
          accessibilityLabel={t('dir.directionsA11y', { name: place.name })}
          testID="dir-directions"
        />
        {openInTargets(system).map((target) => (
          <Button
            key={target}
            kind="secondary"
            label={t(`dir.${target}`)}
            onPress={() => void open(openInUrl(target, p))}
            accessibilityLabel={t('dir.a11y', { name: place.name, app: t(`dir.${target}`) })}
            testID={`dir-open-${target}`}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
