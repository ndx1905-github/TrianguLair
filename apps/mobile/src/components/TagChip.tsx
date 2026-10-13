import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useUiColors } from '../hooks/useUiColors';
import { TAGS, type TagId } from '../theme/tags';

interface Props {
  tag: TagId;
  /** false = tag hidden by the filter (chip greyed out). */
  active?: boolean;
  onPress?: (tag: TagId) => void;
}

export function TagChip({ tag, active = true, onPress }: Props) {
  const c = useUiColors();
  const def = TAGS[tag];
  const content = (
    <>
      <View style={[styles.dot, { backgroundColor: active ? def.color : c.textMuted }]} />
      <Text
        style={[styles.label, { color: active ? c.text : c.textMuted }]}
        maxFontSizeMultiplier={2}
        numberOfLines={1}
      >
        {def.label}
      </Text>
    </>
  );
  const boxStyle = [
    styles.chip,
    {
      backgroundColor: active ? c.surface : c.surfaceAlt,
      borderColor: active ? def.color : c.border,
      opacity: active ? 1 : 0.7,
    },
  ];
  if (!onPress) return <View style={boxStyle}>{content}</View>;
  return (
    <Pressable
      onPress={() => onPress(tag)}
      style={({ pressed }) => [boxStyle, pressed && styles.pressed]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: active }}
      accessibilityLabel={`${def.label} places`}
      hitSlop={4}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 32,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  label: { fontSize: 14, fontWeight: '500' },
  pressed: { transform: [{ scale: 0.96 }] },
});
