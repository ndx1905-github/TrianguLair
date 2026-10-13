import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import type { TagId } from '../theme/tags';
import { TagChip } from './TagChip';

interface Props {
  tags: TagId[];
  hidden: ReadonlySet<TagId>;
  onToggle: (tag: TagId) => void;
  onShowAll: () => void;
  shownCount: number;
  totalCount: number;
}

/** Collapsible filter bar: tag chips toggle the visibility of places. */
export function FilterBar({ tags, hidden, onToggle, onShowAll, shownCount, totalCount }: Props) {
  const c = useUiColors();
  const { wide, width, gutter } = useLayout();
  const [open, setOpen] = useState(true);

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: c.surface,
          borderColor: c.border,
          shadowColor: c.shadow,
          // Wide screens: a floating panel, not the full width.
          maxWidth: wide ? Math.round(width * 0.6) : undefined,
          alignSelf: wide ? 'flex-start' : 'stretch',
          marginHorizontal: gutter,
        },
      ]}
    >
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Filters"
      >
        <Text style={[styles.title, { color: c.text }]} maxFontSizeMultiplier={2}>
          Filters
        </Text>
        <Text style={[styles.count, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {shownCount}/{totalCount} places
          {hidden.size > 0 ? ` · ${hidden.size} hidden` : ''}
        </Text>
        <Text style={[styles.chevron, { color: c.textMuted }]}>{open ? '▴' : '▾'}</Text>
      </Pressable>

      {open && (
        <ScrollView
          horizontal={!wide}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.chips, wide && styles.chipsWrap]}
          style={styles.scroll}
        >
          {tags.map((t) => (
            <TagChip key={t} tag={t} active={!hidden.has(t)} onPress={onToggle} />
          ))}
          {hidden.size > 0 && (
            <Pressable
              onPress={onShowAll}
              style={[styles.reset, { borderColor: c.accent }]}
              accessibilityRole="button"
            >
              <Text style={{ color: c.accent, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                Show all
              </Text>
            </Pressable>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    minHeight: 36,
  },
  title: { fontSize: 16, fontWeight: '700' },
  count: { fontSize: 13, flexShrink: 1, flexGrow: 1 },
  chevron: { fontSize: 16 },
  scroll: { flexGrow: 0 },
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 6 },
  chipsWrap: { flexWrap: 'wrap' },
  reset: {
    justifyContent: 'center',
    paddingHorizontal: 12,
    minHeight: 32,
    borderRadius: 999,
    borderWidth: 1.5,
  },
});
