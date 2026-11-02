import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PlaceHit } from '@triangulair/data';

import { DataGate } from '../components/DataGate';
import { FilterBar } from '../components/FilterBar';
import { PlaceCard } from '../components/PlaceCard';
import { ScreenHeader } from '../components/ScreenHeader';
import { Segmented } from '../components/ui';
import { INITIAL_CENTER } from '../config';
import { useData } from '../data/DataProvider';
import { useFactsLookup, useTags } from '../data/usePlaces';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { categoryLabel, formatDistance } from '../places/card';
import { expandTagSelection, isFilterActive, matchPlace, summarize, type Match } from '../places/filters';
import { listQuery, type ListSort } from '../places/list';
import type { PlaceFacts } from '../places/model';
import { useAppState } from '../state/AppState';

interface Row {
  hit: PlaceHit;
  facts: PlaceFacts;
  match: Match;
}

function ListScreen() {
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { wide, gutter, width } = useLayout();
  const { repo, version } = useData();
  const { tags, byId } = useTags();
  const lookup = useFactsLookup();
  const { filter, setFilter, region, filterOpen, setFilterOpen } = useAppState();
  const [text, setText] = useState('');
  const [sort, setSort] = useState<ListSort>('recent');
  const [selected, setSelected] = useState<string | null>(null);

  const from = region?.center ?? INITIAL_CENTER;
  const hits = useMemo(
    () => repo.queryPlaces(listQuery({ text, sort, from })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, version, text, sort, from.lat, from.lon],
  );
  const now = useMemo(() => new Date(), [hits, filter]);
  const allRows = useMemo<Row[]>(() => {
    const ctx = { tagSet: expandTagSelection(filter.tagIds, tags), now, ...(tr.region ? { country: tr.region } : {}) };
    return hits
      .map((hit) => {
        const facts = lookup(hit.id, hit.friendsCount > 0);
        return facts ? { hit, facts, match: matchPlace(facts, filter, ctx) } : null;
      })
      .filter((r): r is Row => r !== null);
  }, [hits, lookup, filter, tags, now, tr.region]);
  // Closed places stay out of the list unless the "Closed" status is chosen (still counted for that chip).
  const rows = useMemo(() => allRows.filter((r) => r.match !== 'hidden'), [allRows]);
  const summary = useMemo(() => summarize(allRows.map((r) => r.facts), filter, tags, now, tr.region), [allRows, filter, tags, now, tr.region]);
  const active = isFilterActive(filter);

  const open = (id: string) => {
    if (wide) setSelected(id);
    else router.push({ pathname: '/place/[id]', params: { id } });
  };

  const renderRow = ({ item }: { item: Row }) => {
    const { hit, facts } = item;
    const faded = active && item.match !== 'match';
    const rowTags = facts.tagIds.map((id) => byId.get(id)).filter((x) => !!x);
    const statusText = hit.mine?.status ? t(`status.${hit.mine.status}`) : null;
    const dist = formatDistance(hit.distanceM, tr);
    return (
      <Pressable
        onPress={() => open(hit.id)}
        style={({ pressed }) => [
          styles.row,
          { borderColor: c.border, backgroundColor: selected === hit.id ? c.selectedBg : pressed ? c.surfaceAlt : c.surface, opacity: faded ? 0.45 : 1 },
        ]}
        accessibilityRole="button"
        testID={`row-${hit.name}`}
      >
        <View style={styles.pills}>
          {rowTags.length === 0 ? <View style={[styles.pill, { backgroundColor: c.border }]} /> : null}
          {rowTags.slice(0, 4).map((tag) => (
            <View key={tag!.id} style={[styles.pill, { backgroundColor: faded ? c.textMuted : tag!.color }]} />
          ))}
        </View>
        <View style={styles.rowBody}>
          <Text style={[styles.rowName, { color: c.text }]} maxFontSizeMultiplier={2}>
            {hit.name}
          </Text>
          <Text style={[styles.rowMeta, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {[
              rowTags.map((x) => x!.name).join(', ') || categoryLabel(facts.info?.category, tr),
              statusText,
              hit.friendsCount > 0 ? t('list.friends', { count: hit.friendsCount }) : null,
              hit.mine ? null : t('list.friendsOnly'),
              hit.status === 'maybe_closed' ? `✕ ${t('closure.badge')}` : hit.status === 'closed' ? t('placeStatus.closed') : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        {dist && (
          <Text style={[styles.dist, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {dist}
          </Text>
        )}
      </Pressable>
    );
  };

  const list = (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: gutter, paddingTop: 10, gap: 10 }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t('list.search')}
          placeholderTextColor={c.textMuted}
          style={[styles.search, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
          accessibilityLabel={t('list.search')}
          autoCorrect={false}
          testID="list-search"
        />
        <Segmented
          options={(['recent', 'distance', 'name'] as ListSort[]).map((s) => ({ value: s, label: t(`list.sort.${s}`) }))}
          value={sort}
          onChange={setSort}
          testID="list-sort"
        />
      </View>
      <View style={{ marginTop: 10, marginHorizontal: -gutter + gutter }}>
        <FilterBar
          summary={summary}
          filter={filter}
          onChange={setFilter}
          open={filterOpen}
          onOpenChange={setFilterOpen}
          showTheme={false}
          tags={tags}
          personName={(id) => repo.getPerson(id)?.displayName || id}
          onManageTags={() => router.push('/tags')}
        />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.hit.id}
        renderItem={renderRow}
        contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 10, paddingBottom: insets.bottom + 24, gap: 8 }}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {text ? t('list.noMatch') : t('list.empty')}
          </Text>
        }
        keyboardShouldPersistTaps="handled"
        testID="place-list"
      />
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScreenHeader
        title={t('list.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        right={
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: c.textMuted }} maxFontSizeMultiplier={2}>
              {t('filters.places', { count: rows.length })}
            </Text>
            <Pressable onPress={() => router.push('/import')} accessibilityRole="button" accessibilityLabel={t('import.openA11y')} hitSlop={8} testID="open-import">
              <Text style={{ color: c.accent, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                {t('import.open')}
              </Text>
            </Pressable>
          </View>
        }
      />
      {wide ? (
        <View style={styles.split}>
          <View style={{ width: Math.min(520, width * 0.5), borderRightWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>{list}</View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: gutter + 4, paddingBottom: insets.bottom + 24 }}>
            {selected ? (
              <PlaceCard key={selected} placeId={selected} onDeleted={() => setSelected(null)} />
            ) : (
              <Text style={[styles.empty, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                {t('list.pick')}
              </Text>
            )}
          </ScrollView>
        </View>
      ) : (
        list
      )}
    </View>
  );
}

export default function ListRoute() {
  return (
    <DataGate>
      <ListScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  split: { flex: 1, flexDirection: 'row' },
  search: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  pills: { flexDirection: 'row', gap: 3 },
  pill: { width: 8, height: 26, borderRadius: 4 },
  rowBody: { flex: 1 },
  rowName: { fontSize: 16, fontWeight: '700' },
  rowMeta: { fontSize: 13, marginTop: 2 },
  dist: { fontSize: 14, fontWeight: '600' },
  empty: { textAlign: 'center', marginTop: 32, fontSize: 15 },
});
