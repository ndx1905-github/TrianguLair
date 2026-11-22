/**
 * A friend's page, "On the map" (spec "Whose places"): their colour (the dot on their pins, chosen
 * from the tag palette, kept on this device) and "See their places on the map", which applies
 * "Only <friend>" and goes back to the map.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Button } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { PALETTE } from '../theme/tags';
import { defaultFriendColor, FRIEND_COLORS, setFriendColor, useFriendColors } from './friendColors';
import { onlyFriend, setSelection } from './friendsSelection';

const NAMES = new Map(Object.entries(PALETTE).map(([name, hex]) => [hex.toUpperCase(), name]));

export function FriendOnMap({ owner, name }: { owner: string; name: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  const router = useRouter();
  const colorOf = useFriendColors();
  const current = colorOf(owner).toUpperCase();
  const fallback = defaultFriendColor(owner).toUpperCase();
  const colorName = (hex: string) => {
    const n = NAMES.get(hex.toUpperCase());
    return n ? t(`color.${n}`) : hex;
  };
  return (
    <View style={{ gap: 10 }} testID="friend-on-map">
      <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {t('contacts.mapHelp', { name })}
      </Text>
      <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
        {t('contacts.color')}
      </Text>
      <View style={styles.wrap} accessibilityRole="radiogroup">
        {FRIEND_COLORS.map((hex) => {
          const on = current === hex.toUpperCase();
          const label = hex.toUpperCase() === fallback ? `${colorName(hex)} (${t('contacts.colorDefault')})` : colorName(hex);
          return (
            <Pressable
              key={hex}
              onPress={() => setFriendColor(owner, hex)}
              style={[styles.ring, { borderColor: on ? c.text : 'transparent' }]}
              accessibilityRole="radio"
              aria-checked={on}
              accessibilityLabel={t('contacts.colorA11y', { name, color: label })}
              testID={`friend-color-${NAMES.get(hex.toUpperCase()) ?? hex}`}
            >
              <View style={[styles.swatch, { backgroundColor: hex }]} />
            </Pressable>
          );
        })}
      </View>
      {current !== fallback && (
        <View style={{ alignSelf: 'flex-start' }}>
          <Button kind="secondary" label={t('contacts.colorReset')} onPress={() => setFriendColor(owner, null)} testID="friend-color-reset" />
        </View>
      )}
      <View style={{ alignSelf: 'flex-start' }}>
        <Button
          label={t('contacts.seeOnMap')}
          onPress={() => {
            setSelection(onlyFriend(owner));
            router.dismissTo('/');
          }}
          testID="friend-see-on-map"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  ring: { width: 44, height: 44, borderRadius: 22, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: '#FFFFFF' },
});
