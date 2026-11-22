import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

/**
 * "Address of your links": asked at first launch (profile step) and in Settings. The value is
 * what the user typed; the caller parses it with `parseLinkOrigin` and saves it.
 */
export function LinkOriginField({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid: boolean }) {
  const { t } = useI18n();
  const c = useUiColors();
  return (
    <View style={styles.root}>
      <Text style={[styles.label, { color: c.text }]} maxFontSizeMultiplier={2} nativeID="link-origin-label">
        {t('linkOrigin.label')}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        inputMode="url"
        placeholder="https://…"
        style={[styles.input, { color: c.text, borderColor: invalid ? c.danger : c.border, backgroundColor: c.surface }]}
        accessibilityLabelledBy="link-origin-label"
        accessibilityLabel={t('linkOrigin.label')}
        maxFontSizeMultiplier={2}
        testID="link-origin"
      />
      <Text style={{ color: invalid ? c.danger : c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} testID="link-origin-hint">
        {invalid ? t('linkOrigin.invalid') : t('linkOrigin.hint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 6, marginTop: 16 },
  label: { fontSize: 15, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 17, minHeight: 48 },
});
