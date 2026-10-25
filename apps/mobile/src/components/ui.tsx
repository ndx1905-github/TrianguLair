/**
 * Small shared UI pieces. No fixed heights on anything holding text (spec
 * "Font size"): minimum heights only, text wraps or grows the control.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useUiColors } from '../hooks/useUiColors';

export function Pill({
  label,
  selected = false,
  color,
  onPress,
  onRemove,
  removeLabel,
  count,
  testID,
  accessibilityLabel,
  muted = false,
}: {
  label: string;
  selected?: boolean;
  /** Dot color (tags). */
  color?: string;
  onPress?: () => void;
  /** Shows a cross (active filter summary). */
  onRemove?: () => void;
  removeLabel?: string;
  count?: number;
  testID?: string;
  accessibilityLabel?: string;
  muted?: boolean;
}) {
  const c = useUiColors();
  const border = selected ? (color ?? c.accent) : c.border;
  const body = (
    <>
      {color ? <View style={[styles.dot, { backgroundColor: muted ? c.textMuted : color }]} /> : null}
      <Text
        style={[styles.pillText, { color: muted ? c.textMuted : c.text, fontWeight: selected ? '700' : '500' }]}
        maxFontSizeMultiplier={2}
      >
        {label}
        {count !== undefined ? <Text style={{ color: c.textMuted, fontWeight: '500' }}>{`  ${count}`}</Text> : null}
      </Text>
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={8} accessibilityRole="button" accessibilityLabel={removeLabel}>
          <Text style={[styles.cross, { color: c.textMuted }]} maxFontSizeMultiplier={1.6}>
            ✕
          </Text>
        </Pressable>
      ) : null}
    </>
  );
  const box: StyleProp<ViewStyle> = [
    styles.pill,
    { borderColor: border, backgroundColor: selected ? c.selectedBg : c.surface },
  ];
  if (!onPress) {
    return (
      <View style={box} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [box, pressed && styles.pressed]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={4}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  testID,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testID?: string;
}) {
  const c = useUiColors();
  return (
    <View style={[styles.segmented, { borderColor: c.border, backgroundColor: c.surfaceAlt }]} testID={testID} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            style={[styles.segment, on && { backgroundColor: c.surface, borderColor: c.accent }]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.segmentText, { color: on ? c.text : c.textMuted, fontWeight: on ? '700' : '500' }]} maxFontSizeMultiplier={2}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Banner({ tone = 'info', children, testID }: { tone?: 'info' | 'warning'; children: ReactNode; testID?: string }) {
  const c = useUiColors();
  return (
    <View
      style={[styles.banner, { backgroundColor: tone === 'warning' ? c.warningBg : c.surfaceAlt, borderColor: tone === 'warning' ? c.warning : c.border }]}
      testID={testID}
      accessibilityRole="alert"
    >
      <Text style={{ color: c.text, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {children}
      </Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled = false,
  testID,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const c = useUiColors();
  const bg = kind === 'primary' ? c.accent : kind === 'danger' ? c.danger : c.surfaceAlt;
  const fg = kind === 'secondary' ? c.text : '#FFFFFF';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1, borderColor: c.border }]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      testID={testID}
    >
      <Text style={[styles.buttonText, { color: fg }]} maxFontSizeMultiplier={2}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const c = useUiColors();
  return (
    <Text style={[styles.section, { color: c.textMuted }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 32,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  pillText: { fontSize: 14 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cross: { fontSize: 13, paddingLeft: 2 },
  pressed: { transform: [{ scale: 0.96 }] },
  segmented: { flexDirection: 'row', flexWrap: 'wrap', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 3, gap: 3 },
  segment: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 36,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  segmentText: { fontSize: 14 },
  banner: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  button: { minHeight: 44, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  buttonText: { fontSize: 16, fontWeight: '700' },
  section: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 16, marginBottom: 8 },
});
