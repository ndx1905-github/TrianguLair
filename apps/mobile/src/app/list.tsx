/**
 * My places as a list: search, sort, the filter bar, and the "Select" mode (beta feedback): tick
 * places, "Select all" takes those shown (search, zone and filters respected), and the bottom bar
 * deletes or edits my saves among them at once (`BulkBar`). The header also opens Friends.
 */
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PlaceHit } from '@triangulair/data';

import { BulkBar } from '../components/BulkBar';
import { DataGate } from '../components/DataGate';
import { ExamplesBanner } from '../components/ExamplesBanner';
import { FilterBar } from '../components/FilterBar';
import { PlaceOrZoneCard as PlaceCard } from '../zones/ZoneCard';
import { ScreenHeader } from '../components/ScreenHeader';
import { TrashUndo } from '../components/TrashUndo';
import { Banner, Segmented } from '../components/ui';
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
import { shownIds, splitSelection, toggle, toggleAll } from '../places/selection';
import { useAppState } from '../state/AppState';
import { usePullToRefresh } from '../sync/usePullToRefresh';

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
  const pull = usePullToRefresh();
  // "Select" mode: the ticked place ids (null: not selecting).
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // While selecting, the filter bar starts folded (room for the rows and the bottom bar), without
  // changing the remembered choice.
  const [selectFiltersOpen, setSelectFiltersOpen] = useState(false);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

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
  const selectable = useMemo(() => rows.map((r) => ({ id: r.hit.id, mine: !!r.hit.mine, match: r.match })), [rows]);
  const shown = useMemo(() => shownIds(selectable, active), [selectable, active]);
  const split = useMemo(() => (picked ? splitSelection(picked, selectable) : { mine: [], friends: 0 }), [picked, selectable]);
  const pickedCount = split.mine.length + split.friends;
  const allPicked = !!picked && shown.length > 0 && shown.every((id) => picked.has(id));
  const names = useMemo(() => new Map(rows.map((r) => [r.hit.id, r.hit.name])), [rows]);

  const open = (id: string) => {
    if (picked) {
      setPicked(toggle(picked, id));
      return;
    }
    if (wide) setSelected(id);
    else router.push({ pathname: '/place/[id]', params: { id } });
  };

  const renderRow = ({ item }: { item: Row }) => {
    const { hit, facts } = item;
    const faded = active && item.match !== 'match';
    const rowTags = facts.tagIds.map((id) => byId.get(id)).filter((x) => !!x);
    const statusText = hit.mine?.status ? t(`status.${hit.mine.status}`) : null;
    const dist = formatDistance(hit.distanceM, tr);
    const ticked = !!picked?.has(hit.id);
    return (
      <Pressable
        onPress={() => open(hit.id)}
        style={({ pressed }) => [
          styles.row,
          {
            borderColor: ticked ? c.accent : c.border,
            backgroundColor: ticked || selected === hit.id ? c.selectedBg : pressed ? c.surfaceAlt : c.surface,
            opacity: faded ? 0.45 : 1,
          },
        ]}
        {...(picked ? { accessibilityRole: 'checkbox' as const, 'aria-checked': ticked } : { accessibilityRole: 'button' as const })}
        testID={`row-${hit.name}`}
      >
        {picked && (
          <View style={[styles.check, { borderColor: ticked ? c.accent : c.textMuted, backgroundColor: ticked ? c.accent : 'transparent' }]} testID={`check-${hit.name}`}>
            {ticked && (
              <Text style={styles.checkMark} maxFontSizeMultiplier={1.4}>
                ✓
              </Text>
            )}
          </View>
        )}
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
              facts.friendCount ? t('list.friends', { count: facts.friendCount }) : null,
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
        <TrashUndo />
        {notice && <Banner testID="bulk-notice">{notice}</Banner>}
        <ExamplesBanner />
        {picked && (
          <View style={styles.selectBar} testID="select-bar">
            <Text style={{ color: c.text, fontWeight: '600', flexShrink: 1 }} maxFontSizeMultiplier={2} testID="select-count">
              {t('bulk.selected', { count: pickedCount })}
            </Text>
            <Pressable
              onPress={() => setPicked(toggleAll(picked, shown))}
              accessibilityRole="button"
              hitSlop={8}
              disabled={shown.length === 0}
              testID="select-all"
            >
              <Text style={{ color: c.accent, fontWeight: '700' }} maxFontSizeMultiplier={2}>
                {allPicked ? t('bulk.clear') : t('bulk.selectAll', { count: shown.length })}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
      <View style={{ marginTop: 10, marginHorizontal: -gutter + gutter }}>
        <FilterBar
          summary={summary}
          filter={filter}
          onChange={setFilter}
          open={picked ? selectFiltersOpen : filterOpen}
          onOpenChange={picked ? setSelectFiltersOpen : setFilterOpen}
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
        extraData={picked}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 10, paddingBottom: insets.bottom + 24, gap: 8 }}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {text ? t('list.noMatch') : t('list.empty')}
          </Text>
        }
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={c.accent} />}
        testID="place-list"
      />
      {picked && (
        <BulkBar
          mine={split.mine}
          friends={split.friends}
          tags={tags}
          nameOf={(id) => names.get(id) ?? ''}
          bottomInset={insets.bottom}
          onDone={(n) => {
            setPicked(null);
            setNotice(n);
          }}
        />
      )}
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
            <View style={styles.headerLinks}>
              {/* Friends (beta feedback: only reachable from Settings before). */}
              <Pressable onPress={() => router.push('/contacts')} accessibilityRole="button" accessibilityLabel={t('nav.friendsA11y')} hitSlop={8} testID="open-friends">
                <Text style={{ color: c.accent, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                  {t('nav.friends')}
                </Text>
              </Pressable>
              <Pressable onPress={() => router.push('/import')} accessibilityRole="button" accessibilityLabel={t('import.openA11y')} hitSlop={8} testID="open-import">
                <Text style={{ color: c.accent, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                  {t('import.open')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setPicked(picked ? null : new Set());
                  setSelectFiltersOpen(false);
                  setSelected(null);
                }}
                accessibilityRole="button"
                accessibilityLabel={picked ? t('bulk.doneA11y') : t('bulk.selectA11y')}
                hitSlop={8}
                testID="list-select"
              >
                <Text style={{ color: c.accent, fontWeight: '700' }} maxFontSizeMultiplier={2}>
                  {picked ? t('common.cancel') : t('bulk.select')}
                </Text>
              </Pressable>
            </View>
          </View>
        }
      />
      {wide ? (
        <View style={styles.split}>
          <View style={{ width: Math.min(520, width * 0.5), borderRightWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>{list}</View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: gutter + 4, paddingBottom: insets.bottom + 24 }}>
            {selected && !picked ? (
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
  check: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  checkMark: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  selectBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 36 },
  headerLinks: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 14 },
  pill: { width: 8, height: 26, borderRadius: 4 },
  rowBody: { flex: 1 },
  rowName: { fontSize: 16, fontWeight: '700' },
  rowMeta: { fontSize: 13, marginTop: 2 },
  dist: { fontSize: 14, fontWeight: '600' },
  empty: { textAlign: 'center', marginTop: 32, fontSize: 15 },
});
