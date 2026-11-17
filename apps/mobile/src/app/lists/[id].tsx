import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DataGate } from '../../components/DataGate';
import { ScreenHeader } from '../../components/ScreenHeader';
import { Button, Segmented } from '../../components/ui';
import { useData } from '../../data/DataProvider';
import { useTags } from '../../data/usePlaces';
import { useLayout } from '../../hooks/useLayout';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { ListMap } from '../../lists/ListMap';
import { useListPlaceIds } from '../../lists/useListData';
import { categoryLabel } from '../../places/card';
import { categoryIdOf } from '../../lists/listLogic';
import { useAppState } from '../../state/AppState';
import { PlaceOrZoneCard } from '../../zones/ZoneCard';

/** One list (T-112): its places on a map and as a list; the card of the selected one. */
function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { wide, gutter, width } = useLayout();
  const { repo, version } = useData();
  const { byId } = useTags();
  const { focusPlace } = useAppState();
  const list = useMemo(() => repo.getList(String(id)), [repo, id, version]);
  const placeIds = useListPlaceIds(list ? list.id : null);
  const places = useMemo(
    () =>
      placeIds
        .map((pid) => repo.getPlace(pid))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [placeIds, repo, version],
  );
  const inIds = useMemo(() => new Set(places.map((p) => p.id)), [places]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'map' | 'list'>('map');

  const back = () => (router.canGoBack() ? router.back() : router.replace('/lists'));
  if (!list) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <ScreenHeader title={t('lists.title')} onBack={back} />
        <Text style={[styles.empty, { color: c.textMuted }]}>{t('lists.notFound')}</Text>
      </View>
    );
  }

  const rows = (
    <View style={{ gap: 6 }} testID="list-members">
      {places.length === 0 && (
        <Text style={[styles.empty, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('lists.noPlaces')}
        </Text>
      )}
      {places.map((p) => {
        const save = repo.getMySaveForPlace(p.id);
        const rowTags = (save?.tagIds ?? []).map((tid) => byId.get(tid)).filter((x) => !!x);
        return (
          <Pressable
            key={p.id}
            onPress={() => setSelected(p.id)}
            style={[styles.row, { borderColor: selected === p.id ? c.accent : c.border, backgroundColor: selected === p.id ? c.selectedBg : c.surface }]}
            accessibilityRole="button"
            testID={`member-${p.name}`}
          >
            <View style={styles.pills}>
              {rowTags.length === 0 && <View style={[styles.pill, { backgroundColor: c.border }]} />}
              {rowTags.slice(0, 4).map((tag) => (
                <View key={tag!.id} style={[styles.pill, { backgroundColor: tag!.color }, p.kind === 'zone' && { borderRadius: 2 }]} />
              ))}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.name, { color: c.text }]} maxFontSizeMultiplier={2}>
                {p.kind === 'zone' ? `◱ ${p.name}` : p.name}
              </Text>
              <Text style={[styles.meta, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                {[rowTags.map((x) => x!.name).join(', ') || (p.kind === 'zone' ? t('zoneCard.zone') : categoryLabel(categoryIdOf(p.category), tr)), save?.status ? t(`status.${save.status}`) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );

  const header = (
    <View style={{ gap: 8 }}>
      {list.description ? (
        <Text style={{ color: c.text, fontSize: 15 }} maxFontSizeMultiplier={2}>
          {list.description}
        </Text>
      ) : null}
      <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} testID="list-summary">
        {[t('filters.places', { count: places.length }), t(`lists.kind.${list.kind}`), t(`lists.visibility.${list.visibility}`)].join(' · ')}
      </Text>
      <View style={{ alignSelf: 'flex-start' }}>
        <Button label={t('sharing.open')} onPress={() => router.push({ pathname: '/lists/share', params: { id: list.id } })} testID="share-list" />
      </View>
    </View>
  );

  const map = (
    <ListMap places={places} inIds={inIds} zones={list.kind === 'filter' ? (list.filter.zones ?? []) : []} selectedId={selected} onSelect={setSelected} fitKey={places.length} />
  );

  const card = selected ? (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <PlaceOrZoneCard key={selected} placeId={selected} onClose={() => setSelected(null)} onDeleted={() => setSelected(null)} />
      <View style={{ marginTop: 10 }}>
        <Button
          kind="secondary"
          label={t('card.showOnMap')}
          onPress={() => {
            focusPlace(selected);
            if (router.canDismiss()) router.dismissAll();
            else router.replace('/');
          }}
        />
      </View>
    </View>
  ) : null;

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScreenHeader
        title={list.name}
        onBack={back}
        right={<Button kind="secondary" label={t('lists.edit')} onPress={() => router.push({ pathname: '/lists/edit', params: { id: list.id } })} testID="edit-list" />}
      />
      {wide ? (
        <View style={styles.split}>
          <View style={{ width: Math.min(480, width * 0.42) }}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: gutter, gap: 12, paddingBottom: insets.bottom + 24 }}>
              {header}
              {card}
              {rows}
            </ScrollView>
          </View>
          <View style={{ flex: 1, padding: gutter, paddingBottom: insets.bottom + gutter }}>{map}</View>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <View style={{ paddingHorizontal: gutter, paddingTop: 10, gap: 10 }}>
            {header}
            <Segmented
              options={[
                { value: 'map' as const, label: t('lists.view.map') },
                { value: 'list' as const, label: t('lists.view.list') },
              ]}
              value={view}
              onChange={setView}
              testID="list-view-mode"
            />
          </View>
          {view === 'map' ? (
            <View style={{ flex: 1, padding: gutter, paddingBottom: insets.bottom + gutter }}>
              {map}
              {card && <ScrollView style={[styles.overlay, { maxHeight: '55%' }]}>{card}</ScrollView>}
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: gutter, gap: 10, paddingBottom: insets.bottom + 24 }}>
              {card}
              {rows}
            </ScrollView>
          )}
        </View>
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1 },
  pills: { flexDirection: 'row', gap: 3 },
  pill: { width: 8, height: 26, borderRadius: 4 },
  name: { fontSize: 16, fontWeight: '700' },
  meta: { fontSize: 13, marginTop: 2 },
  empty: { textAlign: 'center', marginTop: 24, fontSize: 15 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  overlay: { position: 'absolute', left: 24, right: 24, bottom: 24 },
});
