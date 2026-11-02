import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { isValidCode } from '../identity/lock';

export interface CodeDraft {
  code: string;
  again: string;
}

/** Problem with a new app code, or null when it can be saved. */
export function codeProblem(d: CodeDraft): 'invalid' | 'mismatch' | null {
  if (!isValidCode(d.code)) return 'invalid';
  if (d.code !== d.again) return 'mismatch';
  return null;
}

/** New app code, typed twice. */
export function CodeFields({ value, onChange, showErrors }: { value: CodeDraft; onChange: (d: CodeDraft) => void; showErrors: boolean }) {
  const c = useUiColors();
  const { t } = useI18n();
  const problem = codeProblem(value);
  const input = (key: keyof CodeDraft, label: string, testID: string) => (
    <View style={{ gap: 4 }}>
      <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
        {label}
      </Text>
      <TextInput
        value={value[key]}
        onChangeText={(v) => onChange({ ...value, [key]: v.replace(/\D/g, '') })}
        secureTextEntry
        keyboardType="number-pad"
        maxLength={12}
        style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
        accessibilityLabel={label}
        maxFontSizeMultiplier={2}
        testID={testID}
      />
    </View>
  );
  return (
    <View style={{ gap: 10 }}>
      {input('code', t('lockStep.code'), 'code-new')}
      {input('again', t('lockStep.codeAgain'), 'code-again')}
      {showErrors && problem ? (
        <Text style={{ color: c.danger }} maxFontSizeMultiplier={2} accessibilityLiveRegion="polite" testID="code-problem">
          {t(problem === 'invalid' ? 'lockStep.invalid' : 'lockStep.mismatch')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 18, letterSpacing: 3, minHeight: 48 },
});
