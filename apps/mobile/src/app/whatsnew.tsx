/**
 * What's new (spec "Interface", T-210): friends' activity since my last visit, grouped by day,
 * filterable by type and by friend; unseen items have a dot. "See on the map" highlights their places
 * (the others are faded). Pull to refresh runs a sync pass. Leaving the screen counts as the visit.
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DataGate } from '../components/DataGate';
import { ScreenHeader } from '../components/ScreenHeader';
import { Button, Pill } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { useAppState } from '../state/AppState';
import { Avatar } from '../sync/FriendsPicker';
import { usePullToRefresh } from '../sync/usePullToRefresh';
import { useSync } from '../sync/SyncProvider';
import { filterEntries, groupByDay, placesOf, type WhatsNewEntry, type WhatsNewType } from '../sync/whatsNew';

const TYPES: WhatsNewType[] = ['all', 'places', 'comments', 'statuses', 'people'];

function WhatsNewScreen() {
  const c = useUiColors();
  const { t, locale } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { gutter, wide } = useLayout();
  const { repo } = useData();
  const sync = useSync();
  const { setHighlight, focusPlace } = useAppState();
  const pull = usePullToRefresh();
  // Items newer than the last visit keep their dot while the screen is open.
  const [since] = useState(() => sync.lastVisit());
  const [type, setType] = useState<WhatsNewType>('all');
  const [owner, setOwner] = useState<string | null>(null);
  useEffect(() => () => sync.markVisited(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(() => sync.whatsNew(), [sync.snapshot]); // eslint-disable-line react-hooks/exhaustive-deps
  const owners = useMemo(() => [...new Set(entries.map((e) => e.owner))], [entries]);
  const shown = useMemo(() => filterEntries(entries, { type, owner }), [entries, type, owner]);
  const now = Date.now();
  const groups = useMemo(() => groupByDay(shown, now), [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = (id: string) => repo.getPerson(id)?.displayName || t('card.aFriend');
  const dayLabel = (daysAgo: number, day: string) => {
    if (daysAgo === 0) return t('wn.today');
    if (daysAgo === 1) return t('wn.yesterday');
    const [y, m, d] = day.split('-').map(Number);
    return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(y!, m! - 1, d!));
  };
  const time = (ms: number) => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

  const text = (e: WhatsNewEntry): string => {
    const name = nameOf(e.owner);
    const place = e.name ?? (e.placeId ? repo.getPlace(e.placeId)?.name : undefined) ?? t('wn.placeGone');
    switch (e.kind) {
      case 'added':
        return t('wn.added', { name, place });
      case 'comment':
        return t('wn.comment', { name, place });
      case 'status':
        return t(e.status === 'favorite' ? 'wn.status.favorite' : 'wn.status.tried', { name, place });
      case 'followed':
        return t('wn.followed', { name, count: e.count ?? 0 });
      case 'key':
        return t('wn.key', { name });
      case 'moved':
        return t('wn.moved', { name });
    }
  };

  const seeOnMap = (ids: string[]) => {
    if (ids.length === 0) return;
    setHighlight(ids);
    if (ids.length === 1) focusPlace(ids[0]!);
    router.dismissTo('/');
  };

  const open = (e: WhatsNewEntry) => {
    if (e.placeId && repo.getPlace(e.placeId)) {
      focusPlace(e.placeId);
      router.dismissTo('/');
    } else if (e.placeIds?.length) seeOnMap(e.placeIds);
  };

  const mapIds = placesOf(shown).filter((id) => !!repo.getPlace(id));

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScreenHeader
        title={t('wn.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        right={mapIds.length > 0 ? <Button kind="secondary" label={t('wn.seeOnMap')} onPress={() => seeOnMap(mapIds)} testID="whatsnew-map" /> : undefined}
      />
      <ScrollView
        style={{ alignSelf: 'center', width: '100%', maxWidth: wide ? 720 : undefined }}
        contentContainerStyle={{ padding: gutter, paddingBottom: insets.bottom + 24, gap: 12 }}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={c.accent} />}
        testID="whatsnew"
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {TYPES.map((x) => (
            <Pill key={x} label={t(`wn.type.${x}`)} selected={type === x} onPress={() => setType(x)} testID={`whatsnew-type-${x}`} />
          ))}
        </ScrollView>
        {owners.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Pill label={t('wn.friend.all')} selected={owner === null} onPress={() => setOwner(null)} testID="whatsnew-friend-all" />
            {owners.map((o) => (
              <Pill key={o} label={nameOf(o)} selected={owner === o} onPress={() => setOwner(owner === o ? null : o)} testID={`whatsnew-friend-${nameOf(o)}`} />
            ))}
          </ScrollView>
        )}
        {groups.length === 0 && (
          <Text style={[styles.empty, { color: c.textMuted }]} maxFontSizeMultiplier={2} testID="whatsnew-empty">
            {entries.length === 0 ? t('wn.empty') : t('wn.emptyFiltered')}
          </Text>
        )}
        {groups.map((g) => (
          <View key={g.day} style={{ gap: 8 }}>
            <Text style={[styles.day, { color: c.textMuted }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
              {dayLabel(g.daysAgo, g.day)}
            </Text>
            {g.entries.map((e) => {
              const unseen = e.at > since;
              return (
                <Pressable
                  key={e.id}
                  onPress={() => open(e)}
                  style={({ pressed }) => [styles.item, { borderColor: c.border, backgroundColor: pressed ? c.surfaceAlt : c.surface }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${unseen ? `${t('wn.new')}. ` : ''}${text(e)}${e.comment ? `. ${e.comment}` : ''}`}
                  testID={`whatsnew-item-${e.kind}`}
                >
                  <Avatar name={nameOf(e.owner)} uri={repo.getPerson(e.owner)?.avatar ?? null} size={36} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                      {text(e)}
                    </Text>
                    {e.comment ? (
                      <Text style={{ color: c.text, fontSize: 14, fontStyle: 'italic' }} maxFontSizeMultiplier={2} numberOfLines={3}>
                        “{e.comment}”
                      </Text>
                    ) : null}
                    <Text style={{ color: c.textMuted, fontSize: 12 }} maxFontSizeMultiplier={2}>
                      {time(e.at)}
                    </Text>
                  </View>
                  {unseen && <View style={[styles.dot, { backgroundColor: c.accent }]} testID="whatsnew-unseen" />}
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

export default function WhatsNewRoute() {
  return (
    <DataGate>
      <WhatsNewScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  chips: { gap: 8, paddingVertical: 2 },
  day: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 10, height: 10, borderRadius: 5 },
  empty: { textAlign: 'center', marginTop: 32, fontSize: 15 },
});
