import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import type { Place } from '../places/types';
import { TagChip } from './TagChip';

interface Props {
  place: Place | null;
  onClose: () => void;
  /** Height covered at the bottom of the screen (0 when hidden or in side-panel mode). */
  onCoverHeight?: (h: number) => void;
}

/**
 * Card of the selected place.
 * - Compact screens (phones): bottom sheet docked at the bottom, full width.
 * - Wide screens (tablets, unfolded foldables, landscape): side panel on the
 *   right, next to the map (spec "Screen adaptation").
 * Phase 0: no drag gesture (tap the map or the close button to dismiss).
 */
export function PlaceSheet({ place, onClose, onCoverHeight }: Props) {
  const c = useUiColors();
  const insets = useSafeAreaInsets();
  const { wide, sheetWidth, gutter, height } = useLayout();
  const anim = useRef(new Animated.Value(0)).current;
  // Keep the last place rendered while the sheet animates out.
  const [shown, setShown] = useState<Place | null>(place);

  useEffect(() => {
    if (place) setShown(place);
    Animated.timing(anim, {
      toValue: place ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && !place) setShown(null);
    });
    if (!place) onCoverHeight?.(0);
  }, [place, anim, onCoverHeight]);

  // Switching between bottom sheet and side panel (fold/unfold, rotation).
  useEffect(() => {
    if (wide) onCoverHeight?.(0);
  }, [wide, onCoverHeight]);

  if (!shown) return null;

  const slide = anim.interpolate({ inputRange: [0, 1], outputRange: [wide ? 60 : 300, 0] });

  const placement = wide
    ? {
        width: sheetWidth,
        right: insets.right + gutter,
        top: insets.top + gutter,
        maxHeight: height - insets.top - insets.bottom - gutter * 2 - 24,
        borderRadius: 20,
        paddingBottom: 16,
        transform: [{ translateX: slide }],
      }
    : {
        width: '100%' as const,
        left: 0,
        bottom: 0,
        maxHeight: Math.round(height * 0.6),
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingBottom: insets.bottom + 28,
        transform: [{ translateY: slide }],
      };

  return (
    <Animated.View
      style={[
        styles.sheet,
        placement,
        {
          backgroundColor: c.surface,
          borderColor: c.border,
          shadowColor: c.shadow,
          paddingHorizontal: gutter + 4,
          opacity: anim,
        },
      ]}
      onLayout={(e) => onCoverHeight?.(wide || !place ? 0 : e.nativeEvent.layout.height)}
      accessibilityLabel={`Place: ${shown.name}`}
      testID="place-sheet"
    >
      {!wide && <View style={[styles.grabber, { backgroundColor: c.border }]} />}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={[styles.name, { color: c.text }]} accessibilityRole="header">
            {shown.name}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={10}
            style={[styles.close, { backgroundColor: c.surfaceAlt }]}
          >
            <Text style={{ color: c.textMuted, fontSize: 16 }} maxFontSizeMultiplier={1.5}>
              ✕
            </Text>
          </Pressable>
        </View>
        <Text style={[styles.owner, { color: c.textMuted }]}>
          {shown.ownerIsMe ? 'In my places' : 'From friends’ lists'}
        </Text>
        <View style={styles.tags}>
          {shown.tags.map((t) => (
            <TagChip key={t} tag={t} />
          ))}
        </View>
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    paddingTop: 10,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -2 },
    elevation: 12,
  },
  scroll: { flexGrow: 0 },
  content: { paddingBottom: 2 },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 4 },
  name: { flex: 1, fontSize: 22, fontWeight: '700' },
  close: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  owner: { fontSize: 14, marginTop: 4 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
});
