import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useLayout } from '../hooks/useLayout';
import { useThemeMode, useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { activeFilterCount, toggleIn, type Criterion, type FilterState, type FilterSummary } from '../places/filters';
import { nextThemeMode } from '../theme/themeMode';
import { Pill } from './ui';

interface Props {
  summary: FilterSummary;
  filter: FilterState;
  onChange: (f: FilterState) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hide the theme button (e.g. inside the list screen header). */
  showTheme?: boolean;
}

/**
 * Filter bar (spec "Filter bar"): my tags with their number of places, then
 * the practical OSM criteria that enough places document, the number of
 * matching places and "Clear filters". Collapses into one summary line (one
 * pill per active filter, with a cross, and a "Filters (n)" button).
 */
export function FilterBar({ summary, filter, onChange, open, onOpenChange, showTheme = true }: Props) {
  const c = useUiColors();
  const { t } = useI18n();
  const { wide, filterMaxWidth, gutter } = useLayout();
  const { mode, setMode } = useThemeMode();
  const n = activeFilterCount(filter);
  const tagName = new Map(summary.tags.map(({ tag }) => [tag.id, tag]));

  const toggleTag = (id: string) => onChange({ ...filter, tagIds: toggleIn(filter.tagIds, id) });
  const toggleCriterion = (k: Criterion) => onChange({ ...filter, criteria: toggleIn(filter.criteria, k) });
  const clear = () => onChange({ tagIds: [], criteria: [] });

  const countText =
    n > 0
      ? t('filters.matching', { count: summary.matching, total: summary.total })
      : t('filters.places', { count: summary.total });

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: c.surface,
          borderColor: c.border,
          shadowColor: c.shadow,
          maxWidth: wide ? filterMaxWidth : undefined,
          alignSelf: wide ? 'flex-start' : 'stretch',
          marginHorizontal: gutter,
        },
      ]}
      testID="filter-bar"
    >
      <View style={styles.header}>
        <Pressable
          onPress={() => onOpenChange(!open)}
          style={styles.toggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={open ? t('filters.collapse') : t('filters.expand')}
          testID="filter-toggle"
        >
          <Text style={[styles.title, { color: c.text }]} maxFontSizeMultiplier={2}>
            {n > 0 ? t('filters.titleCount', { count: n }) : t('filters.title')}
          </Text>
          <Text style={[styles.count, { color: c.textMuted }]} maxFontSizeMultiplier={2} testID="filter-count">
            {countText}
          </Text>
          <Text style={[styles.chevron, { color: c.textMuted }]}>{open ? '▴' : '▾'}</Text>
        </Pressable>
        {showTheme && (
          <Pressable
            onPress={() => setMode(nextThemeMode(mode))}
            style={[styles.theme, { borderColor: c.border, backgroundColor: c.surfaceAlt }]}
            accessibilityRole="button"
            accessibilityLabel={t('theme.change', { mode: t(`theme.${mode}`) })}
            hitSlop={6}
            testID="theme-toggle"
          >
            <Text style={[styles.themeText, { color: c.text }]} maxFontSizeMultiplier={2}>
              {t('theme.label', { mode: t(`theme.${mode}`) })}
            </Text>
          </Pressable>
        )}
      </View>

      {!open && n > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.scroll}>
          {filter.tagIds.map((id) => (
            <Pill
              key={id}
              label={tagName.get(id)?.name ?? '?'}
              color={tagName.get(id)?.color}
              selected
              onRemove={() => toggleTag(id)}
              removeLabel={t('filters.remove', { name: tagName.get(id)?.name ?? '' })}
            />
          ))}
          {filter.criteria.map((k) => (
            <Pill key={k} label={t(`criterion.${k}`)} selected onRemove={() => toggleCriterion(k)} removeLabel={t('filters.remove', { name: t(`criterion.${k}`) })} />
          ))}
        </ScrollView>
      )}

      {open && (
        <ScrollView
          horizontal={!wide}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.chips, wide && styles.chipsWrap]}
          style={styles.scroll}
        >
          {summary.tags.map(({ tag, count }) => (
            <Pill
              key={tag.id}
              label={tag.name}
              color={tag.color}
              count={count}
              selected={filter.tagIds.includes(tag.id)}
              onPress={() => toggleTag(tag.id)}
              accessibilityLabel={t('filters.tagA11y', { name: tag.name, count })}
              testID={`filter-tag-${tag.name}`}
            />
          ))}
          {summary.tags.length > 0 && summary.criteria.length > 0 && <View style={[styles.sep, { backgroundColor: c.border }]} />}
          {summary.criteria.map(({ criterion, count }) => (
            <Pill
              key={criterion}
              label={t(`criterion.${criterion}`)}
              count={count}
              selected={filter.criteria.includes(criterion)}
              onPress={() => toggleCriterion(criterion)}
              testID={`filter-criterion-${criterion}`}
            />
          ))}
          {n > 0 && (
            <Pressable onPress={clear} style={[styles.reset, { borderColor: c.accent }]} accessibilityRole="button" testID="filter-clear">
              <Text style={{ color: c.accent, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                {t('filters.clear')}
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 8 },
  toggle: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, paddingVertical: 6, minHeight: 44 },
  theme: { justifyContent: 'center', paddingHorizontal: 10, minHeight: 32, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  themeText: { fontSize: 13, fontWeight: '600' },
  title: { fontSize: 16, fontWeight: '700' },
  count: { fontSize: 13, flexShrink: 1 },
  chevron: { fontSize: 16 },
  scroll: { flexGrow: 0 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6 },
  chipsWrap: { flexWrap: 'wrap' },
  sep: { width: 1, alignSelf: 'stretch', marginHorizontal: 2 },
  reset: { justifyContent: 'center', paddingHorizontal: 12, minHeight: 32, borderRadius: 999, borderWidth: 1.5 },
});
