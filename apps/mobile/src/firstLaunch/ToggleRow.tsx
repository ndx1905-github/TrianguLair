import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { useUiColors } from '../hooks/useUiColors';

/** A labelled switch; the label wraps and the whole row is the touch target. */
export function ToggleRow({ label, help, value, onChange, testID, disabled }: { label: string; help?: string; value: boolean; onChange: (v: boolean) => void; testID?: string; disabled?: boolean }) {
  const c = useUiColors();
  return (
    <Pressable
      onPress={() => !disabled && onChange(!value)}
      style={[styles.row, { borderColor: c.border, backgroundColor: c.surface, opacity: disabled ? 0.6 : 1 }]}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={label}
      testID={testID}
    >
      <View style={styles.text}>
        <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }} maxFontSizeMultiplier={2}>
          {label}
        </Text>
        {help ? (
          <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
            {help}
          </Text>
        ) : null}
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: c.accent }} accessibilityElementsHidden importantForAccessibility="no" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, minHeight: 52 },
  text: { flex: 1, gap: 2 },
});
