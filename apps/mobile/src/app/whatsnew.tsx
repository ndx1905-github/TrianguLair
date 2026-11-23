/**
 * What's new (spec "Interface", T-210): friends' activity since my last visit, grouped by day,
 * filterable by type and by friend; unseen items have a dot. "See on the map" highlights their places
 * (the others are faded). Pull to refresh runs a sync pass. Leaving the screen counts as the visit.
 * My own places that may no longer exist according to OpenStreetMap (closed-place check, import) are
 * listed too, with their own icon and type: tapping one opens its card, where I can answer.
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { signalText } from '../closure/labels';
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
import { filterEntries, groupByDay, isOwnEntry, placesOf, type WhatsNewEntry, type WhatsNewType } from '../sync/whatsNew';
import { PhotoStrip } from '../photos/PhotoStrip';

const TYPES: WhatsNewType[] = ['all', 'places', 'comments', 'statuses', 'photos', 'people', 'closures'];

/** mdiMapMarkerOff (Material Design Icons, Apache License 2.0): a place that may be gone. */
const MARKER_OFF =
  'M16.37,16.1L11.75,11.47L11.64,11.36L3.27,3L2,4.27L5.18,7.45C5.06,7.95 5,8.46 5,9C5,14.25 12,22 12,22C12,22 13.67,20.15 15.37,17.65L18.73,21L20,19.72M12,6.5A2.5,2.5 0 0,1 14.5,9C14.5,9.73 14.17,10.39 13.67,10.85L17.3,14.5C18.28,12.62 19,10.68 19,9A7,7 0 0,0 12,2C10,2 8.24,2.82 6.96,4.14L10.15,7.33C10.61,6.82 11.26,6.5 12,6.5Z';

/** The icon of my own entries (instead of a friend's avatar). */
function ClosureIcon({ size = 36 }: { size?: number }) {
  const c = useUiColors();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.warningBg, borderColor: c.warning, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }} testID="whatsnew-closure-icon">
      <Svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24">
        <Path d={MARKER_OFF} fill={c.text} />
      </Svg>
    </View>
  );
}

function WhatsNewScreen() {
  const c = useUiColors();
  const tr = useI18n();
  const { t, locale } = tr;
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
  const owners = useMemo(() => [...new Set(entries.filter((e) => !isOwnEntry(e)).map((e) => e.owner))], [entries]);
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
      case 'photo':
        return t('wn.photo', { name, place, count: e.count ?? 1 });
      case 'followed':
        return t('wn.followed', { name, count: e.count ?? 0 });
      case 'key':
        return t('wn.key', { name });
      case 'moved':
        return t('wn.moved', { name });
      case 'identity':
        return t('wn.identity', { name });
      case 'closure':
        return t('wn.closure', { place });
      case 'closureImport':
        return t('wn.closureImport', { count: e.count ?? e.placeIds?.length ?? 0 });
    }
  };
  /** Second line: the reason of a closure entry, or the friend's comment. */
  const detail = (e: WhatsNewEntry): string | null => (e.kind === 'closure' && e.signal ? signalText(e.signal, tr) : null);

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
                  accessibilityLabel={`${unseen ? `${t('wn.new')}. ` : ''}${text(e)}${e.comment ? `. ${e.comment}` : ''}${detail(e) ? `. ${detail(e)}` : ''}`}
                  testID={`whatsnew-item-${e.kind}`}
                >
                  {isOwnEntry(e) ? <ClosureIcon /> : <Avatar name={nameOf(e.owner)} uri={repo.getPerson(e.owner)?.avatar ?? null} size={36} />}
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                      {text(e)}
                    </Text>
                    {detail(e) ? (
                      <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} numberOfLines={2} testID="whatsnew-reason">
                        {detail(e)}
                      </Text>
                    ) : null}
                    {e.comment ? (
                      <Text style={{ color: c.text, fontSize: 14, fontStyle: 'italic' }} maxFontSizeMultiplier={2} numberOfLines={3}>
                        “{e.comment}”
                      </Text>
                    ) : null}
                    {e.kind === 'photo' && e.mediaIds?.length ? <PhotoStrip mediaIds={e.mediaIds} /> : null}
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
