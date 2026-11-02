import { Linking, Pressable, StyleSheet, Text } from 'react-native';

import { MAP_ATTRIBUTION, MAP_ATTRIBUTION_URL } from '../config';
import { useUiColors } from '../hooks/useUiColors';

/** Always-visible map attribution (required by OSM / OpenFreeMap). */
export function MapAttribution({ bottom, right, onHeight }: { bottom: number; right: number; /** Its height (it wraps with large text). */ onHeight?: (h: number) => void }) {
  const c = useUiColors();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => Linking.openURL(MAP_ATTRIBUTION_URL)}
      style={[styles.box, { bottom, right, backgroundColor: c.surface + 'D9' }]}
      onLayout={onHeight ? (e) => onHeight(Math.round(e.nativeEvent.layout.height)) : undefined}
    >
      <Text style={[styles.text, { color: c.textMuted }]} maxFontSizeMultiplier={1.6}>
        {MAP_ATTRIBUTION}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    maxWidth: '90%',
  },
  text: { fontSize: 11 },
});
