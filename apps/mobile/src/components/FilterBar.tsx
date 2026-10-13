import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useLayout } from '../hooks/useLayout';
import { useThemeMode, useUiColors } from '../hooks/useUiColors';
import { THEME_MODE_LABEL, nextThemeMode } from '../theme/themeMode';
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
  const { wide, filterMaxWidth, gutter } = useLayout();
  const { mode, setMode } = useThemeMode();
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
          maxWidth: wide ? filterMaxWidth : undefined,
          alignSelf: wide ? 'flex-start' : 'stretch',
          marginHorizontal: gutter,
        },
      ]}
    >
      <View style={styles.header}>
        <Pressable
          onPress={() => setOpen((o) => !o)}
          style={styles.toggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={open ? 'Collapse filters' : 'Expand filters'}
          testID="filter-toggle"
        >
          <Text style={[styles.title, { color: c.text }]} maxFontSizeMultiplier={2}>
            Filters{hidden.size > 0 ? ` (${hidden.size})` : ''}
          </Text>
          <Text style={[styles.count, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {shownCount}/{totalCount} places
          </Text>
          <Text style={[styles.chevron, { color: c.textMuted }]}>{open ? '▴' : '▾'}</Text>
        </Pressable>
        <Pressable
          onPress={() => setMode(nextThemeMode(mode))}
          style={[styles.theme, { borderColor: c.border, backgroundColor: c.surfaceAlt }]}
          accessibilityRole="button"
          accessibilityLabel={`Theme: ${THEME_MODE_LABEL[mode]}. Change theme`}
          hitSlop={6}
        >
          <Text style={[styles.themeText, { color: c.text }]} maxFontSizeMultiplier={2}>
            Theme: {THEME_MODE_LABEL[mode]}
          </Text>
        </Pressable>
      </View>

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
    paddingLeft: 14,
    paddingRight: 8,
  },
  toggle: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 8,
    paddingVertical: 6,
    minHeight: 44,
  },
  theme: {
    justifyContent: 'center',
    paddingHorizontal: 10,
    minHeight: 32,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  themeText: { fontSize: 13, fontWeight: '600' },
  title: { fontSize: 16, fontWeight: '700' },
  count: { fontSize: 13, flexShrink: 1 },
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
