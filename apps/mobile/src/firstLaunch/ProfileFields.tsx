/**
 * First name and optional photo (first launch and settings). The photo is
 * cropped square and reduced to 256 px before it is kept (data: URI).
 */
import { useState } from 'react';
import { Image, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

import { Button } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import type { Profile } from '../identity/IdentityProvider';

export const AVATAR_SIZE = 256;

async function pickAvatar(): Promise<string | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
  const asset = res.canceled ? null : res.assets[0];
  if (!asset) return null;
  const side = Math.min(asset.width || AVATAR_SIZE, asset.height || AVATAR_SIZE);
  const crop =
    asset.width && asset.height && asset.width !== asset.height
      ? [{ crop: { originX: (asset.width - side) / 2, originY: (asset.height - side) / 2, width: side, height: side } }]
      : [];
  const out = await manipulateAsync(asset.uri, [...crop, { resize: { width: AVATAR_SIZE, height: AVATAR_SIZE } }], {
    compress: 0.7,
    format: SaveFormat.JPEG,
    base64: true,
  });
  return out.base64 ? `data:image/jpeg;base64,${out.base64}` : null;
}

export function ProfileFields({ value, onChange, autoFocus }: { value: Profile; onChange: (p: Profile) => void; autoFocus?: boolean }) {
  const c = useUiColors();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const initial = value.name.trim().charAt(0).toUpperCase();

  const choose = async () => {
    setBusy(true);
    try {
      const avatar = await pickAvatar();
      if (avatar) onChange({ ...value, avatar });
    } catch (e) {
      console.warn('Photo not picked', e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <Text style={[styles.label, { color: c.text }]} maxFontSizeMultiplier={2} nativeID="profile-name-label">
        {t('profile.name')}
      </Text>
      <TextInput
        value={value.name}
        onChangeText={(name) => onChange({ ...value, name })}
        autoFocus={autoFocus}
        autoComplete="given-name"
        textContentType="givenName"
        autoCapitalize="words"
        returnKeyType="done"
        maxLength={60}
        style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
        accessibilityLabelledBy="profile-name-label"
        accessibilityLabel={t('profile.name')}
        maxFontSizeMultiplier={2}
        testID="profile-name"
      />
      <Text style={[styles.label, { color: c.text, marginTop: 8 }]} maxFontSizeMultiplier={2}>
        {t('profile.photoOptional')}
      </Text>
      <View style={styles.photoRow}>
        {value.avatar ? (
          <Image source={{ uri: value.avatar }} style={styles.avatar} accessibilityLabel={t('profile.photoA11y')} testID="profile-avatar" />
        ) : (
          <View style={[styles.avatar, { backgroundColor: c.surfaceAlt, borderColor: c.border, borderWidth: 1 }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={{ color: c.textMuted, fontSize: 28, fontWeight: '700' }} maxFontSizeMultiplier={1.4}>
              {initial}
            </Text>
          </View>
        )}
        <View style={styles.photoButtons}>
          <Button kind="secondary" label={value.avatar ? t('profile.changePhoto') : t('profile.addPhoto')} onPress={() => void choose()} disabled={busy} testID="profile-photo" />
          {value.avatar ? <Button kind="secondary" label={t('profile.removePhoto')} onPress={() => onChange({ ...value, avatar: null })} /> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 6, marginTop: 8 },
  label: { fontSize: 15, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 17, minHeight: 48 },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
  avatar: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  photoButtons: { flexShrink: 1, flexGrow: 1, gap: 8, minWidth: 160 },
});
