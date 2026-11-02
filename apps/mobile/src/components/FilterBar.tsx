import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useLayout } from '../hooks/useLayout';
import { useThemeMode, useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { euros, groupLabel, pillLabel, subLabel } from '../filters/labels';
import { activePills, toggleValue } from '../filters/pills';
import {
  activeFilterCount,
  EMPTY_FILTER,
  subDimensionsFor,
  toggleIn,
  type Criterion,
  type FilterState,
  type FilterSummary,
  type SubDimension,
} from '../places/filters';
import type { AppTag } from '../places/model';
import { tagPath } from '../tags/tree';
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
  /** All my active tags (labels of sub-tags and of the summary pills). */
  tags?: readonly AppTag[];
  /** Display name of a friend (their tags). */
  personName?: (personId: string) => string;
  onManageTags?: () => void;
  /** Max height of the expanded panel (it scrolls beyond). */
  maxHeight?: number;
}

const SUB_DIMS: SubDimension[] = ['kinds', 'cuisines', 'museums', 'shops'];

/**
 * Filter bar (spec "Filter bar", T-109): my tags (then the sub-tags of a
 * chosen tag), my friends' unmapped tags in their author's color, the
 * categories and their sub-filters (type, cuisine, museum, shop), practical
 * OSM criteria, diets and entry price, then my own data (status, closed
 * places, visibility, price level) and a text search, with the number of
 * matching places and "Clear filters". Collapses into one summary line: one
 * pill per active filter with a cross, and "Filters (n)" to expand again.
 */
export function FilterBar({ summary, filter, onChange, open, onOpenChange, showTheme = true, tags, personName, onManageTags, maxHeight }: Props) {
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const { wide, filterMaxWidth, gutter } = useLayout();
  const { mode, setMode } = useThemeMode();
  const n = activeFilterCount(filter);
  const allTags = tags ?? summary.tags.map((x) => x.tag);
  const tagById = new Map(allTags.map((tag) => [tag.id, tag]));
  const counts = new Map(summary.tags.map((x) => [x.tag.id, x.count]));
  const friendByKey = new Map(summary.friendTags.map((f) => [f.key, f]));
  const who = (id: string) => personName?.(id) ?? id;

  const set = (f: FilterState) => onChange(f);
  const toggleTag = (id: string) => set({ ...filter, tagIds: toggleIn(filter.tagIds, id) });
  const toggleCriterion = (k: Criterion) => set({ ...filter, criteria: toggleIn(filter.criteria, k) });
  const clear = () => set({ ...EMPTY_FILTER });

  const countText =
    n > 0
      ? t('filters.matching', { count: summary.matching, total: summary.total })
      : t('filters.places', { count: summary.total });

  // Tags: top level first; the sub-tags of a chosen tag in a row of their own.
  const shown = summary.tags.filter(({ tag }) => !tag.parentId || !counts.has(tag.parentId));
  const chosenParents = filter.tagIds.filter((id) => summary.tags.some((x) => x.tag.parentId === id));
  const dims = subDimensionsFor(filter.categories ?? []);

  const row = (key: string, label: string, children: ReactNode) => (
    <ScrollView
      key={key}
      horizontal={!wide}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.chips, wide && styles.chipsWrap]}
      style={styles.scroll}
      keyboardShouldPersistTaps="handled"
      testID={`filter-row-${key}`}
    >
      <Text style={[styles.rowLabel, { color: c.textMuted }]} maxFontSizeMultiplier={1.8}>
        {label}
      </Text>
      {children}
    </ScrollView>
  );

  const pills = activePills(filter);

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

      {!open && pills.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          style={styles.scroll}
          accessibilityLabel={t('fb.summaryA11y')}
          testID="filter-summary"
        >
          {pills.map((p) => {
            const { label, color } = pillLabel(p, { tagById, friendTag: (k) => { const f = friendByKey.get(k); return f ? { ...f, personName: who(f.personId) } : undefined; } }, tr);
            return (
              <Pill
                key={p.key}
                label={label}
                {...(color ? { color } : {})}
                selected
                onRemove={() => set(p.without)}
                removeLabel={t('filters.remove', { name: label })}
                testID={`filter-pill-${p.key}`}
              />
            );
          })}
        </ScrollView>
      )}

      {open && (
        <ScrollView style={{ maxHeight: maxHeight ?? 420 }} contentContainerStyle={{ paddingBottom: 4 }} keyboardShouldPersistTaps="handled" testID="filter-panel">
          {shown.length > 0 &&
            row(
              'tags',
              t('fb.section.tags'),
              shown.map(({ tag, count }) => (
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
              )),
            )}
          {chosenParents.map((pid) =>
            row(
              `sub-${pid}`,
              t('fb.subTags', { name: tagById.get(pid)?.name ?? '' }),
              summary.tags
                .filter(({ tag }) => tag.parentId === pid)
                .map(({ tag, count }) => (
                  <Pill
                    key={tag.id}
                    label={tag.name}
                    color={tag.color}
                    count={count}
                    selected={filter.tagIds.includes(tag.id)}
                    onPress={() => toggleTag(tag.id)}
                    accessibilityLabel={t('filters.tagA11y', { name: tagPath(tag.id, tagById), count })}
                    testID={`filter-tag-${tag.name}`}
                  />
                )),
            ),
          )}
          {summary.friendTags.length > 0 &&
            row(
              'friendTags',
              t('fb.section.friendTags'),
              summary.friendTags.map((f) => (
                <Pill
                  key={f.key}
                  label={t('fb.friendTag', { name: f.name, person: who(f.personId) })}
                  {...(f.color ? { color: f.color } : {})}
                  count={f.count}
                  selected={(filter.friendTags ?? []).includes(f.key)}
                  onPress={() => set(toggleValue(filter, 'friendTags', f.key))}
                  accessibilityLabel={t('fb.friendTagA11y', { name: f.name, person: who(f.personId), count: f.count })}
                  testID={`filter-friendtag-${f.name}`}
                />
              )),
            )}
          {summary.categories.length > 0 &&
            row(
              'category',
              t('fb.section.category'),
              summary.categories.map(({ value, count }) => (
                <Pill
                  key={value}
                  label={groupLabel(value, tr)}
                  count={count}
                  selected={(filter.categories ?? []).includes(value)}
                  onPress={() => set(toggleValue(filter, 'categories', value))}
                  testID={`filter-category-${value}`}
                />
              )),
            )}
          {SUB_DIMS.filter((d) => dims.includes(d)).map((dim) => {
            const values = summary[dim];
            if (values.length === 0) return null;
            return row(
              `sub-${dim}`,
              t(`fb.sub.${dim}`),
              values.map(({ value, count }) => (
                <Pill
                  key={value}
                  label={subLabel(dim, value, tr)}
                  count={count}
                  selected={((filter[dim] ?? []) as string[]).includes(value)}
                  onPress={() => set(toggleValue(filter, dim, value as never))}
                  testID={`filter-sub-${dim}-${value}`}
                />
              )),
            );
          })}
          {(summary.criteria.length > 0 || summary.charges.length > 0) &&
            row('practical', t('fb.section.practical'), [
              ...summary.criteria.map(({ criterion, count }) => (
                <Pill
                  key={criterion}
                  label={t(`criterion.${criterion}`)}
                  count={count}
                  selected={filter.criteria.includes(criterion)}
                  onPress={() => toggleCriterion(criterion)}
                  testID={`filter-criterion-${criterion}`}
                />
              )),
              ...summary.charges.map(({ value, count }) => (
                <Pill
                  key={`charge-${value}`}
                  label={t('fb.charge', { max: value })}
                  count={count}
                  selected={filter.maxCharge === value}
                  onPress={() => {
                    const next = { ...filter };
                    if (filter.maxCharge === value) delete next.maxCharge;
                    else next.maxCharge = value;
                    set(next);
                  }}
                  testID={`filter-charge-${value}`}
                />
              )),
            ])}
          {summary.diets.length > 0 &&
            row(
              'diet',
              t('fb.section.diet'),
              summary.diets.map(({ diet, count }) => (
                <Pill
                  key={diet}
                  label={t(`dietFilter.${diet}`)}
                  count={count}
                  selected={(filter.diets ?? []).includes(diet)}
                  onPress={() => set(toggleValue(filter, 'diets', diet))}
                  testID={`filter-diet-${diet}`}
                />
              )),
            )}
          {row('mine', t('fb.section.mine'), [
            ...summary.statuses.map(({ value, count }) => (
              <Pill
                key={value}
                label={t(`status.${value}`)}
                count={count}
                selected={(filter.statuses ?? []).includes(value)}
                onPress={() => set(toggleValue(filter, 'statuses', value))}
                testID={`filter-status-${value}`}
              />
            )),
            ...summary.placeStatuses.map(({ value, count }) => (
              <Pill
                key={value}
                label={t(`placeStatus.${value}`)}
                count={count}
                selected={(filter.placeStatuses ?? []).includes(value)}
                onPress={() => set(toggleValue(filter, 'placeStatuses', value))}
                testID={`filter-placeStatus-${value}`}
              />
            )),
          ])}
          {row('sharing', t('fb.section.sharing'), [
            ...summary.visibility.map(({ value, count }) => (
              <Pill
                key={value}
                label={t(`visibilityFilter.${value}`)}
                count={count}
                selected={(filter.visibility ?? []).includes(value)}
                onPress={() => set(toggleValue(filter, 'visibility', value))}
                testID={`filter-visibility-${value}`}
              />
            )),
            summary.priceLevels.length > 0 ? <View key="sep" style={[styles.sep, { backgroundColor: c.border }]} /> : null,
            ...summary.priceLevels.map(({ value, count }) => (
              <Pill
                key={`price-${value}`}
                label={euros(value)}
                count={count}
                selected={(filter.priceLevels ?? []).includes(value)}
                onPress={() => set(toggleValue(filter, 'priceLevels', value))}
                testID={`filter-price-${value}`}
              />
            )),
          ])}
          <View style={[styles.textRow, { paddingHorizontal: 12 }]}>
            <TextInput
              value={filter.text ?? ''}
              onChangeText={(text) => {
                const next = { ...filter };
                if (text) next.text = text;
                else delete next.text;
                set(next);
              }}
              placeholder={t('fb.text')}
              placeholderTextColor={c.textMuted}
              style={[styles.text, { color: c.text, borderColor: c.border, backgroundColor: c.surfaceAlt }]}
              accessibilityLabel={t('fb.text')}
              autoCorrect={false}
              testID="filter-text"
            />
          </View>
          <View style={styles.footer}>
            {summary.unknown > 0 && n > 0 && (
              <Text style={[styles.unknown, { color: c.textMuted }]} maxFontSizeMultiplier={2} testID="filter-unknown">
                {t('fb.unknown', { count: summary.unknown })}
              </Text>
            )}
            <View style={styles.footerActions}>
              {onManageTags && (
                <Pressable onPress={onManageTags} style={[styles.reset, { borderColor: c.border }]} accessibilityRole="button" testID="filter-manage-tags">
                  <Text style={{ color: c.text, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                    {t('fb.manageTags')}
                  </Text>
                </Pressable>
              )}
              {n > 0 && (
                <Pressable onPress={clear} style={[styles.reset, { borderColor: c.accent }]} accessibilityRole="button" testID="filter-clear">
                  <Text style={{ color: c.accent, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                    {t('filters.clear')}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
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
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 4 },
  chipsWrap: { flexWrap: 'wrap' },
  rowLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginRight: 2 },
  sep: { width: 1, alignSelf: 'stretch', marginHorizontal: 2 },
  textRow: { paddingVertical: 6 },
  text: { minHeight: 40, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, fontSize: 15 },
  footer: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 4 },
  footerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginLeft: 'auto' },
  unknown: { fontSize: 13, flexShrink: 1 },
  reset: { justifyContent: 'center', paddingHorizontal: 12, minHeight: 36, borderRadius: 999, borderWidth: 1.5 },
});
