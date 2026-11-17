/**
 * Someone else's list in my cache (a list I follow by link, or a friend's list shared with me):
 * its places on a map and as rows (their author's tags, status and comment), the card of the
 * selected one. Same layout as my own list (`/lists/[id]`): split on wide screens, map / list on
 * phones.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '../components/ScreenHeader';
import { Button, Segmented } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { categoryLabel } from '../places/card';
import { useAppState } from '../state/AppState';
import { PlaceOrZoneCard } from '../zones/ZoneCard';
import { categoryIdOf } from './listLogic';
import { ListMap } from './ListMap';

export function ListPlacesView({
  title,
  owner,
  placeIds,
  header,
  onBack,
  testID,
}: {
  title: string;
  /** Whose saves the rows show (the followed list's id, or the friend). */
  owner: string;
  placeIds: readonly string[];
  header: ReactNode;
  onBack: () => void;
  testID: string;
}) {
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { wide, gutter, width } = useLayout();
  const { repo, version } = useData();
  const { focusPlace } = useAppState();
  const places = useMemo(
    () =>
      placeIds
        .map((pid) => repo.getPlace(pid))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [placeIds, repo, version],
  );
  const inIds = useMemo(() => new Set(places.map((p) => p.id)), [places]);
  const tagsOf = useMemo(() => {
    const m = new Map<string, { name: string; color: string | null }[]>();
    for (const r of repo.friendTags()) {
      if (r.personId !== owner) continue;
      const l = m.get(r.placeId) ?? [];
      l.push({ name: r.name, color: r.color });
      m.set(r.placeId, l);
    }
    return m;
  }, [repo, owner, version]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'map' | 'list'>('map');

  const rows = (
    <View style={{ gap: 6 }} testID={`${testID}-places`}>
      {places.length === 0 && (
        <Text style={[styles.empty, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('lists.noPlaces')}
        </Text>
      )}
      {places.map((p) => {
        const save = repo.savesForPlace(p.id).find((s) => s.ownerId === owner);
        const tags = tagsOf.get(p.id) ?? [];
        return (
          <Pressable
            key={p.id}
            onPress={() => setSelected(p.id)}
            style={[styles.row, { borderColor: selected === p.id ? c.accent : c.border, backgroundColor: selected === p.id ? c.selectedBg : c.surface }]}
            accessibilityRole="button"
            testID={`${testID}-place-${p.name}`}
          >
            <View style={styles.pills}>
              {tags.length === 0 && <View style={[styles.pill, { backgroundColor: c.border }]} />}
              {tags.slice(0, 4).map((tag, i) => (
                <View key={i} style={[styles.pill, { backgroundColor: tag.color ?? c.border }, p.kind === 'zone' && { borderRadius: 2 }]} />
              ))}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.name, { color: c.text }]} maxFontSizeMultiplier={2}>
                {p.kind === 'zone' ? `◱ ${p.name}` : p.name}
              </Text>
              <Text style={[styles.meta, { color: c.textMuted }]} maxFontSizeMultiplier={2} numberOfLines={2}>
                {[tags.map((x) => x.name).join(', ') || (p.kind === 'zone' ? t('zoneCard.zone') : categoryLabel(categoryIdOf(p.category), tr)), save?.status ? t(`status.${save.status}`) : null, save?.comment || null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );

  const map = <ListMap places={places} inIds={inIds} zones={[]} selectedId={selected} onSelect={setSelected} fitKey={places.length} />;
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
    <View style={[styles.root, { backgroundColor: c.background }]} testID={testID}>
      <ScreenHeader title={title} onBack={onBack} />
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
          <ScrollView style={{ flexGrow: 0, maxHeight: '45%' }} contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 10, gap: 10, paddingBottom: 10 }}>
            {header}
            <Segmented
              options={[
                { value: 'map' as const, label: t('lists.view.map') },
                { value: 'list' as const, label: t('lists.view.list') },
              ]}
              value={view}
              onChange={setView}
              testID={`${testID}-view-mode`}
            />
          </ScrollView>
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
