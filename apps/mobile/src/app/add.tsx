import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SearchSession } from '@triangulair/osm';

import { DataGate } from '../components/DataGate';
import { SaveEditor } from '../components/SaveEditor';
import { ScreenHeader } from '../components/ScreenHeader';
import { Banner, Button, SectionTitle } from '../components/ui';
import { INITIAL_CENTER, OSM_FIXTURES } from '../config';
import { useData } from '../data/DataProvider';
import { newId } from '../data/identity';
import { useTags } from '../data/usePlaces';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { osmClient } from '../osm/client';
import { classifyOsmError, type OsmFailure } from '../osm/errors';
import {
  annotate,
  byDistance,
  canSave,
  defaultForm,
  fromLocal,
  fromNearby,
  fromSearch,
  manualCandidate,
  nearbyRadius,
  suggestTags,
  toSaveInput,
  type Candidate,
  type SaveForm,
} from '../places/add';
import { categoryLabel, formatDistance } from '../places/card';
import { useAppState } from '../state/AppState';
import { haversineM } from '@triangulair/data';

type Load = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; list: Candidate[] } | { kind: 'error'; failure: OsmFailure };

/**
 * Add a place (T-105): known places around the map center, nearest first,
 * then search as you type (Photon), or a point dropped by long-pressing the
 * map. Each candidate says whether it is already in my places or saved by
 * friends. Choosing one opens the form (tags, status, price, comment and its
 * visibility, sharing).
 */
function AddScreen() {
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { gutter, wide } = useLayout();
  const { repo, mutate } = useData();
  const { tags } = useTags();
  const { region, focusPlace } = useAppState();
  const params = useLocalSearchParams<{ lat?: string; lon?: string; manual?: string }>();

  const center = useMemo(() => {
    const lat = Number(params.lat);
    const lon = Number(params.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : (region?.center ?? INITIAL_CENTER);
  }, [params.lat, params.lon, region?.center]);
  const radius = useMemo(() => {
    if (!region) return nearbyRadius(null);
    const [w, s, e, n] = region.bbox;
    return nearbyRadius(haversineM({ lat: s, lon: w }, { lat: n, lon: e }));
  }, [region]);

  const known = (placeId: string) => {
    const mine = repo.getMySaveForPlace(placeId);
    const friends = repo.savesForPlace(placeId).filter((s) => s.ownerId !== repo.meId && s.deletedAt === null && s.sharing !== 'private').length;
    return { mine: !!mine && mine.deletedAt === null, friendsCount: friends };
  };
  const localNearby = () =>
    repo.queryPlaces({ sort: 'distance', from: center, limit: 30 }).map(fromLocal).filter((x) => (x.distance ?? 0) < 5000);

  const [nearby, setNearby] = useState<Load>({ kind: 'loading' });
  const [text, setText] = useState('');
  const [search, setSearch] = useState<Load>({ kind: 'idle' });
  const [picked, setPicked] = useState<Candidate | null>(() =>
    params.manual === '1' ? manualCandidate(center) : null,
  );
  const [form, setForm] = useState<SaveForm | null>(() =>
    params.manual === '1' ? defaultForm(manualCandidate(center), []) : null,
  );

  // Nearby places (Overpass), nearest first; on failure, the places on this device.
  useEffect(() => {
    const ctrl = new AbortController();
    setNearby({ kind: 'loading' });
    osmClient()
      .overpass.nearby(center, { radius, limit: 40, signal: ctrl.signal })
      .then((list) => {
        const cands = list.map(fromNearby).filter((x): x is Candidate => x !== null);
        setNearby({ kind: 'ok', list: annotate(cands, known).sort(byDistance) });
      })
      .catch((e: unknown) => {
        const failure = classifyOsmError(e);
        if (failure !== 'aborted') setNearby({ kind: 'error', failure });
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.lat, center.lon, radius]);

  // Search as you type: Photon through a session (debounce, superseded requests aborted).
  const session = useRef<SearchSession | null>(null);
  useEffect(() => {
    session.current = osmClient().newSearchSession({ near: center, lang: tr.locale, limit: 15 });
    return () => session.current?.cancel();
  }, [center, tr.locale]);
  useEffect(() => {
    const s = session.current;
    if (!s) return;
    if (text.trim().length < 3) {
      s.cancel();
      setSearch({ kind: 'idle' });
      return;
    }
    setSearch({ kind: 'loading' });
    s.update(text).then(
      (results) => {
        if (results === null) return; // superseded or too short
        setSearch({ kind: 'ok', list: annotate(results.map(fromSearch), known) });
      },
      (e: unknown) => {
        const failure = classifyOsmError(e);
        if (failure !== 'aborted') setSearch({ kind: 'error', failure });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Local part of the search (my places and my friends'): instant, offline.
  const localMatches = useMemo(
    () => (text.trim().length >= 2 ? repo.search(text, { from: center, limit: 10 }).map(fromLocal) : []),
    [repo, text, center],
  );

  const pick = (cand: Candidate) => {
    if (cand.alreadyMine && cand.placeId) {
      router.replace({ pathname: '/place/[id]', params: { id: cand.placeId } });
      return;
    }
    setPicked(cand);
    setForm(defaultForm(cand, suggestTags(cand, tags)));
  };

  const save = () => {
    if (!picked || !form || !canSave(picked, form)) return;
    const input = toSaveInput(picked, form, newId);
    const placeId = mutate((store) => {
      const id = store.putSave(input);
      if (picked.tags) {
        store.repo.updatePlaceOsmData(id, {
          osmTags: picked.tags,
          openingHours: picked.tags.opening_hours ?? null,
          address: picked.address,
          website: picked.tags.website ?? picked.tags['contact:website'] ?? null,
          phone: picked.tags.phone ?? picked.tags['contact:phone'] ?? null,
          osmSyncedAt: Date.now(),
        });
      }
      return id;
    });
    focusPlace(placeId);
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const failureText = (f: OsmFailure) => t(f === 'offline' ? 'osm.offline' : f === 'busy' ? 'osm.busy' : 'osm.unavailable');

  const renderCandidate = (cand: Candidate) => {
    const dist = formatDistance(cand.distance, tr);
    const cat = cand.category ? categoryLabel(cand.category, tr) : cand.source === 'local' ? t('add.onDevice') : null;
    return (
      <Pressable
        key={cand.key}
        onPress={() => pick(cand)}
        style={({ pressed }) => [styles.row, { borderColor: c.border, backgroundColor: pressed ? c.surfaceAlt : c.surface }]}
        accessibilityRole="button"
        testID={`candidate-${cand.name}`}
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowName, { color: c.text }]} maxFontSizeMultiplier={2}>
            {cand.name || t('add.unnamed')}
          </Text>
          <Text style={[styles.rowMeta, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {[cat, cand.address].filter(Boolean).join(' · ')}
          </Text>
          {(cand.alreadyMine || cand.friendsCount > 0) && (
            <View style={styles.badges}>
              {cand.alreadyMine && (
                <Text style={[styles.badge, { color: c.open, borderColor: c.open }]} maxFontSizeMultiplier={2} testID="badge-mine">
                  ✓ {t('add.alreadyMine')}
                </Text>
              )}
              {cand.friendsCount > 0 && (
                <Text style={[styles.badge, { color: c.accent, borderColor: c.accent }]} maxFontSizeMultiplier={2}>
                  {t('add.friends', { count: cand.friendsCount })}
                </Text>
              )}
            </View>
          )}
        </View>
        {dist && (
          <Text style={[styles.dist, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {dist}
          </Text>
        )}
      </Pressable>
    );
  };

  // ---- Form for the chosen candidate.
  if (picked && form) {
    const manual = picked.source === 'manual' || !picked.ref;
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <ScreenHeader title={manual ? t('add.manualTitle') : t('add.formTitle')} onBack={() => (params.manual === '1' ? router.back() : setPicked(null))} />
        <ScrollView
          contentContainerStyle={{ padding: gutter + 4, paddingBottom: insets.bottom + 40, maxWidth: wide ? 640 : undefined, width: '100%', alignSelf: 'center' }}
          keyboardShouldPersistTaps="handled"
          testID="add-form"
        >
          {manual ? (
            <>
              <SectionTitle>{t('add.name')}</SectionTitle>
              <TextInput
                value={form.name}
                onChangeText={(name) => setForm({ ...form, name })}
                placeholder={t('add.namePlaceholder')}
                placeholderTextColor={c.textMuted}
                style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
                autoFocus
                testID="manual-name"
              />
              <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                {t('add.manualAt', { lat: picked.lat.toFixed(5), lon: picked.lon.toFixed(5) })}
              </Text>
            </>
          ) : (
            <>
              <Text style={[styles.title, { color: c.text }]} maxFontSizeMultiplier={2}>
                {picked.name}
              </Text>
              <Text style={[styles.rowMeta, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                {[picked.category ? categoryLabel(picked.category, tr) : null, picked.address].filter(Boolean).join(' · ')}
              </Text>
              {picked.friendsCount > 0 && (
                <Text style={[styles.hint, { color: c.accent }]} maxFontSizeMultiplier={2}>
                  {t('add.friends', { count: picked.friendsCount })}
                </Text>
              )}
            </>
          )}
          <SaveEditor value={form} tags={tags} onChange={(patch) => setForm({ ...form, ...patch })} />
          <View style={{ marginTop: 24 }}>
            <Button label={t('add.save')} onPress={save} disabled={!canSave(picked, form)} testID="save-place" />
          </View>
          {manual && nearby.kind === 'ok' && nearby.list.length > 0 && (
            <>
              <SectionTitle>{t('add.orExisting')}</SectionTitle>
              <View style={{ gap: 8 }}>{nearby.list.slice(0, 5).map(renderCandidate)}</View>
            </>
          )}
        </ScrollView>
      </View>
    );
  }

  // ---- Candidate lists.
  const searching = text.trim().length >= 3;
  const sections: { title: string; items: Candidate[] }[] = [];
  if (localMatches.length) sections.push({ title: t('add.onDeviceSection'), items: localMatches });
  if (searching && search.kind === 'ok') {
    const localIds = new Set(localMatches.map((x) => x.placeId));
    sections.push({ title: t('add.results'), items: search.list.filter((x) => !localIds.has(x.placeId)) });
  }
  if (!searching) {
    if (nearby.kind === 'ok') sections.push({ title: t('add.nearby'), items: nearby.list });
    if (nearby.kind === 'error') sections.push({ title: t('add.nearbyOnDevice'), items: localNearby() });
  }
  const status =
    searching && search.kind === 'loading'
      ? 'loading'
      : !searching && nearby.kind === 'loading'
        ? 'loading'
        : null;
  const error = searching ? (search.kind === 'error' ? search.failure : null) : nearby.kind === 'error' ? nearby.failure : null;
  const emptyText =
    searching && search.kind === 'ok' && sections.every((s) => s.items.length === 0)
      ? t('add.noResults')
      : !searching && nearby.kind === 'ok' && nearby.list.length === 0
        ? t('add.noNearby')
        : null;

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScreenHeader title={t('add.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <View style={{ paddingHorizontal: gutter, paddingTop: 10, gap: 8, maxWidth: wide ? 720 : undefined, width: '100%', alignSelf: 'center' }}>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => {
            if (!session.current || !text.trim()) return;
            setSearch({ kind: 'loading' });
            session.current.submit(text).then(
              (r) => r && setSearch({ kind: 'ok', list: annotate(r.map(fromSearch), known) }),
              (e: unknown) => setSearch({ kind: 'error', failure: classifyOsmError(e) }),
            );
          }}
          placeholder={t('add.search')}
          placeholderTextColor={c.textMuted}
          style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t('add.search')}
          testID="add-search"
        />
        <View style={styles.inline}>
          <Button kind="secondary" label={t('add.dropPoint')} onPress={() => pick(manualCandidate(center))} testID="drop-point" />
        </View>
        <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('add.longPressHint')}
        </Text>
        {OSM_FIXTURES && <Banner>{t('osm.fixtureMode')}</Banner>}
        {error && <Banner tone="warning">{failureText(error)}</Banner>}
      </View>
      <FlatList
        data={sections}
        keyExtractor={(s) => s.title}
        contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: insets.bottom + 32, maxWidth: wide ? 720 : undefined, width: '100%', alignSelf: 'center' }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          status === 'loading' ? (
            <View style={styles.loading}>
              <ActivityIndicator color={c.accent} />
              <Text style={{ color: c.textMuted }} maxFontSizeMultiplier={2}>
                {searching ? t('add.searching') : t('add.loadingNearby')}
              </Text>
            </View>
          ) : emptyText ? (
            <Text style={[styles.hint, { color: c.textMuted, marginTop: 16 }]} maxFontSizeMultiplier={2}>
              {emptyText}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View>
            <SectionTitle>{item.title}</SectionTitle>
            <View style={{ gap: 8 }}>{item.items.map(renderCandidate)}</View>
          </View>
        )}
        ListFooterComponent={
          <Text style={[styles.attrib, { color: c.textMuted }]} maxFontSizeMultiplier={1.6}>
            {searching ? t('add.photonAttribution') : t('card.osmAttribution')}
          </Text>
        }
        testID="candidates"
      />
    </View>
  );
}

export default function AddRoute() {
  return (
    <DataGate>
      <AddScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  inline: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { fontSize: 13 },
  title: { fontSize: 22, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  rowName: { fontSize: 16, fontWeight: '700' },
  rowMeta: { fontSize: 13, marginTop: 2 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  badge: { fontSize: 12, fontWeight: '700', borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  dist: { fontSize: 14, fontWeight: '600' },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 },
  attrib: { fontSize: 11, marginTop: 16 },
});
