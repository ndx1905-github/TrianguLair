/**
 * List editor (T-112, spec "Creating a sharing list"): a saved filter (tags,
 * categories, statuses, price levels, zones by name or drawn, exceptions) or
 * a manual selection; live preview (map with the zones, retained places in
 * color and the others faded, count); visibility (public / link). Sharing
 * itself comes in phase 2. Membership is decided by the data package's
 * evaluator; this screen explains it ("Private: never in a list").
 */
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { categorize } from '@triangulair/osm';
import type { FilterZone, PriceLevel, SaveStatus } from '@triangulair/data';

import { ScreenHeader } from '../components/ScreenHeader';
import { Banner, Button, Pill, SectionTitle, Segmented } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useTags } from '../data/usePlaces';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n, type TFunction } from '../i18n';
import { osmClient } from '../osm/client';
import { categoryLabel } from '../places/card';
import { toggleIn } from '../places/filters';
import { searchAreas, type OsmArea } from '../zones/osmZones';
import { takePendingListZone } from '../zones/pendingZone';
import {
  addByHand,
  canSave,
  clearException,
  draftDefinition,
  draftFromList,
  draftToFilter,
  EMPTY_DRAFT,
  explain,
  hasCriteria,
  placeToFilterZone,
  removeByHand,
  toggleZone,
  zoneKeyOf,
  type ListDraft,
  type Reason,
} from './listLogic';
import { ListMap } from './ListMap';
import { useMyPlaces, type MyPlace } from './useListData';

const STATUSES: SaveStatus[] = ['to_try', 'tried', 'favorite'];
const PRICES: PriceLevel[] = [1, 2, 3, 4];

export function reasonText(r: Reason, t: TFunction): string {
  if (r.in) return t(`why.in.${r.why}`);
  if (r.why === 'criteria' && r.failed?.length) return t('why.out.criteriaGroups', { groups: r.failed.map((g) => t(`why.group.${g}`)).join(', ') });
  return t(`why.out.${r.why}`);
}

export function ListEditor({ listId }: { listId: string | null }) {
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { wide, gutter, width } = useLayout();
  const { repo, mutate } = useData();
  const { tags } = useTags();
  const mine = useMyPlaces();
  const existing = useMemo(() => (listId ? repo.getList(listId) : null), [repo, listId]);
  const [draft, setDraft] = useState<ListDraft>(() => (existing ? draftFromList(existing) : { ...EMPTY_DRAFT, name: '' }));
  const set = (patch: Partial<ListDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const [selected, setSelected] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [showOut, setShowOut] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Zones by name (Nominatim, on submit).
  const [zq, setZq] = useState('');
  const [zResults, setZResults] = useState<OsmArea[] | null>(null);
  const [zBusy, setZBusy] = useState(false);
  const [zError, setZError] = useState(false);

  // An area drawn in the zone editor (purpose=list) comes back here.
  useFocusEffect(
    useCallback(() => {
      const z = takePendingListZone();
      if (z) {
        setDraft((d) => ({ ...d, zones: toggleZone(d.zones.filter((x) => zoneKeyOf(x) !== zoneKeyOf(z)), z) }));
        setFitKey((k) => k + 1);
      }
    }, []),
  );

  const ctx = useMemo(() => repo.filterContext(), [repo, mine]);
  const def = useMemo(() => draftDefinition(draft), [draft]);
  const inSaveIds = useMemo(() => new Set(repo.evaluateList(def)), [repo, def, mine]);
  const rows = useMemo(
    () => mine.map((m) => ({ ...m, in: inSaveIds.has(m.save.id), reason: explain(m.subject, draft, ctx) })),
    [mine, inSaveIds, draft, ctx],
  );
  const inRows = rows.filter((r) => r.in);
  const outRows = rows.filter((r) => !r.in);
  const inPlaceIds = useMemo(() => new Set(inRows.map((r) => r.place.id)), [inRows]);

  const categories = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const m of mine) if (m.place.category) byCat.set(m.place.category, (byCat.get(m.place.category) ?? 0) + 1);
    // Several OSM categories can share a label (shop=books, shop=bakery… → their own; office=* → "Service"): one chip per label.
    const byLabel = new Map<string, { cats: string[]; count: number }>();
    for (const [cat, count] of byCat) {
      const [k, v] = cat.split('=');
      const id = k && v ? categorize({ [k]: v })?.category : undefined;
      const label = categoryLabel(id, tr);
      const e = byLabel.get(label) ?? { cats: [], count: 0 };
      e.cats.push(cat);
      e.count += count;
      byLabel.set(label, e);
    }
    return [...byLabel.entries()].map(([label, e]) => ({ label, ...e })).sort((a, b) => a.label.localeCompare(b.label));
  }, [mine, tr]);

  const myZones = useMemo(() => mine.filter((m) => m.place.kind === 'zone' && m.place.geometry.type !== 'Point'), [mine]);

  const runZoneSearch = async () => {
    if (!zq.trim()) return;
    setZBusy(true);
    setZError(false);
    try {
      setZResults(await searchAreas(osmClient(), zq, tr.locale));
    } catch {
      setZError(true);
      setZResults(null);
    } finally {
      setZBusy(false);
    }
  };

  const addZone = (z: FilterZone | null) => {
    if (!z) return;
    set({ zones: toggleZone(draft.zones, z) });
    setFitKey((k) => k + 1);
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/lists'));

  const save = () => {
    if (!canSave(draft)) return;
    const filter = draftToFilter(draft);
    const id = mutate((s) =>
      s.change((tx) => {
        if (listId && existing) {
          // The manual selection changes item by item (merge-friendly); add/remove act on
          // the selection while the list is manual, so switch to manual for the diff.
          const now = new Set(existing.manualItems);
          const want = new Set(draft.items);
          const added = [...want].filter((p) => !now.has(p));
          const removed = [...now].filter((p) => !want.has(p));
          const itemsChanged = added.length + removed.length > 0;
          tx.updateList(listId, { name: draft.name, description: draft.description, visibility: draft.visibility, kind: itemsChanged ? 'manual' : draft.kind });
          for (const p of added) tx.addToList(listId, p);
          for (const p of removed) tx.removeFromList(listId, p);
          if (itemsChanged) tx.updateList(listId, { kind: draft.kind });
          tx.setListFilter(listId, filter);
          return listId;
        }
        return tx.createList({
          name: draft.name,
          description: draft.description,
          visibility: draft.visibility,
          kind: draft.kind,
          filter,
          items: draft.items,
        });
      }),
    );
    router.replace({ pathname: '/lists/[id]', params: { id } });
  };

  const placeRow = (r: MyPlace & { in: boolean; reason: Reason }) => {
    const main = tags.find((x) => x.id === r.save.tagIds[0]);
    const pid = r.place.id;
    const isException = draft.include.includes(pid) || draft.exclude.includes(pid);
    const blocked = !r.in && ['private', 'trash', 'notMine', 'closedPublic'].includes(r.reason.why);
    return (
      <Pressable
        key={pid}
        onPress={() => setSelected(pid)}
        style={[styles.row, { borderColor: selected === pid ? c.accent : c.border, backgroundColor: c.surface, opacity: r.in ? 1 : 0.8 }]}
        testID={`list-row-${r.place.name}`}
      >
        <View style={[r.place.kind === 'zone' ? styles.square : styles.dot, { backgroundColor: r.in ? (main?.color ?? c.textMuted) : c.border }]} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowName, { color: c.text }]} maxFontSizeMultiplier={2}>
            {r.place.name}
          </Text>
          <Text style={[styles.rowMeta, { color: r.reason.why === 'private' ? c.warning : c.textMuted }]} maxFontSizeMultiplier={2}>
            {reasonText(r.reason, t)}
          </Text>
        </View>
        {isException && draft.kind === 'filter' ? (
          <Button kind="secondary" label={t('listEdit.undoException')} onPress={() => setDraft((d) => clearException(d, pid))} />
        ) : r.in ? (
          <Button kind="secondary" label={t('listEdit.remove')} onPress={() => setDraft((d) => removeByHand(d, pid))} testID={`list-remove-${r.place.name}`} />
        ) : !blocked ? (
          <Button kind="secondary" label={t('listEdit.add')} onPress={() => setDraft((d) => addByHand(d, pid))} testID={`list-add-${r.place.name}`} />
        ) : null}
      </Pressable>
    );
  };

  const form = (
    <View>
      <SectionTitle>{t('listEdit.name')}</SectionTitle>
      <TextInput
        value={draft.name}
        onChangeText={(name) => set({ name })}
        placeholder={t('listEdit.namePlaceholder')}
        placeholderTextColor={c.textMuted}
        style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surfaceAlt }]}
        accessibilityLabel={t('listEdit.name')}
        testID="list-name"
      />
      <TextInput
        value={draft.description}
        onChangeText={(description) => set({ description })}
        placeholder={t('listEdit.descriptionPlaceholder')}
        placeholderTextColor={c.textMuted}
        multiline
        style={[styles.input, { marginTop: 8, minHeight: 56, color: c.text, borderColor: c.border, backgroundColor: c.surfaceAlt }]}
        accessibilityLabel={t('listEdit.description')}
      />

      <SectionTitle>{t('listEdit.kind')}</SectionTitle>
      <Segmented
        options={[
          { value: 'filter' as const, label: t('listEdit.kind.filter') },
          { value: 'manual' as const, label: t('listEdit.kind.manual') },
        ]}
        value={draft.kind}
        onChange={(kind) => set({ kind })}
        testID="list-kind"
      />
      <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {draft.kind === 'filter' ? t('listEdit.kind.filterHint') : t('listEdit.kind.manualHint')}
      </Text>

      {draft.kind === 'filter' && (
        <>
          <SectionTitle>{t('listEdit.tags')}</SectionTitle>
          <View style={styles.wrap}>
            {tags.map((tag) => (
              <Pill
                key={tag.id}
                label={tag.parentId ? `› ${tag.name}` : tag.name}
                color={tag.color}
                selected={draft.tags.includes(tag.id)}
                onPress={() => set({ tags: toggleIn(draft.tags, tag.id) })}
                testID={`list-tag-${tag.name}`}
              />
            ))}
          </View>

          {categories.length > 0 && (
            <>
              <SectionTitle>{t('listEdit.categories')}</SectionTitle>
              <View style={styles.wrap}>
                {categories.map((k) => {
                  const on = k.cats.every((x) => draft.categories.includes(x));
                  return (
                    <Pill
                      key={k.label}
                      label={k.label}
                      count={k.count}
                      selected={on}
                      onPress={() =>
                        set({ categories: on ? draft.categories.filter((x) => !k.cats.includes(x)) : [...new Set([...draft.categories, ...k.cats])] })
                      }
                    />
                  );
                })}
              </View>
            </>
          )}

          <SectionTitle>{t('listEdit.statuses')}</SectionTitle>
          <View style={styles.wrap}>
            {STATUSES.map((s) => (
              <Pill key={s} label={t(`status.${s}`)} selected={draft.statuses.includes(s)} onPress={() => set({ statuses: toggleIn(draft.statuses, s) })} testID={`list-status-${s}`} />
            ))}
            {PRICES.map((p) => (
              <Pill key={p} label={'€'.repeat(p)} selected={draft.priceLevels.includes(p)} onPress={() => set({ priceLevels: toggleIn(draft.priceLevels, p) })} />
            ))}
          </View>

          <SectionTitle>{t('listEdit.zones')}</SectionTitle>
          {draft.zones.length > 0 && (
            <View style={[styles.wrap, { marginBottom: 8 }]}>
              {draft.zones.map((z) => (
                <Pill
                  key={zoneKeyOf(z)}
                  label={z.name || t('listEdit.drawnArea')}
                  selected
                  onRemove={() => set({ zones: draft.zones.filter((x) => zoneKeyOf(x) !== zoneKeyOf(z)) })}
                  removeLabel={t('filters.remove', { name: z.name || t('listEdit.drawnArea') })}
                  testID={`list-zone-${z.name ?? 'drawn'}`}
                />
              ))}
            </View>
          )}
          {myZones.length > 0 && (
            <>
              <Text style={[styles.label, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                {t('listEdit.myZones')}
              </Text>
              <View style={styles.wrap}>
                {myZones.map((m) => {
                  const z = placeToFilterZone(m.place);
                  if (!z) return null;
                  const on = draft.zones.some((x) => zoneKeyOf(x) === zoneKeyOf(z));
                  return <Pill key={m.place.id} label={`◱ ${m.place.name}`} selected={on} onPress={() => addZone(z)} testID={`list-myzone-${m.place.name}`} />;
                })}
              </View>
            </>
          )}
          <Text style={[styles.label, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {t('listEdit.zoneByName')}
          </Text>
          <View style={styles.searchRow}>
            <TextInput
              value={zq}
              onChangeText={setZq}
              onSubmitEditing={() => void runZoneSearch()}
              returnKeyType="search"
              placeholder={t('zone.area.searchList')}
              placeholderTextColor={c.textMuted}
              style={[styles.input, { flexGrow: 1, flexShrink: 1, flexBasis: 160, minWidth: 0, color: c.text, borderColor: c.border, backgroundColor: c.surfaceAlt }]}
              accessibilityLabel={t('listEdit.zoneByName')}
              testID="list-zone-search"
            />
            <Button kind="secondary" label={t('zone.area.go')} onPress={() => void runZoneSearch()} disabled={zBusy || !zq.trim()} testID="list-zone-go" />
          </View>
          {zBusy && <ActivityIndicator color={c.accent} />}
          {zError && <Banner tone="warning">{t('zone.offline')}</Banner>}
          {zResults && (
            <View style={[styles.wrap, { marginTop: 8 }]}>
              {zResults.length === 0 ? (
                <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                  {t('zone.area.noResult')}
                </Text>
              ) : (
                zResults.map((a) => (
                  <Pill
                    key={`${a.osmType}/${a.osmId}`}
                    label={a.description ? `${a.name} · ${a.description.split(',').slice(1, 3).join(',').trim()}` : a.name}
                    selected={draft.zones.some((z) => z.kind === 'osm' && z.osmId === a.osmId)}
                    onPress={() => addZone({ kind: 'osm', osmType: a.osmType, osmId: a.osmId, name: a.name, geometry: a.geometry })}
                    testID={`list-zone-result-${a.name}`}
                  />
                ))
              )}
            </View>
          )}
          <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
            <Button kind="secondary" label={`✎ ${t('listEdit.drawZone')}`} onPress={() => router.push({ pathname: '/zone/new', params: { purpose: 'list' } })} testID="list-draw-zone" />
          </View>
        </>
      )}

      <SectionTitle>{t('listEdit.visibility')}</SectionTitle>
      <Segmented
        options={[
          { value: 'link' as const, label: t('listEdit.visibility.link') },
          { value: 'public' as const, label: t('listEdit.visibility.public') },
        ]}
        value={draft.visibility}
        onChange={(visibility) => set({ visibility })}
        testID="list-visibility"
      />
      <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {draft.visibility === 'public' ? t('listEdit.visibility.publicHint') : t('listEdit.visibility.linkHint')}
      </Text>
      <View style={{ marginTop: 8 }}>
        <Banner>{t('lists.sharingLater')}</Banner>
      </View>
    </View>
  );

  const preview = (
    <View style={{ gap: 10 }}>
      <View style={styles.previewHead}>
        <Text style={[styles.count, { color: c.text }]} maxFontSizeMultiplier={2} testID="list-count">
          {t('filters.places', { count: inRows.length })}
        </Text>
        {draft.kind === 'filter' && !hasCriteria(draft) && (
          <Text style={[styles.hint, { color: c.warning, flex: 1 }]} maxFontSizeMultiplier={2}>
            {t('listEdit.noCriteria')}
          </Text>
        )}
      </View>
      <View style={{ height: wide ? 340 : 260 }}>
        <ListMap places={mine.map((m) => m.place)} inIds={inPlaceIds} zones={draft.kind === 'filter' ? draft.zones : []} selectedId={selected} onSelect={setSelected} fitKey={fitKey} />
      </View>
      <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {t('listEdit.privateNote')}
      </Text>
      <SectionTitle>{t('listEdit.inList', { count: inRows.length })}</SectionTitle>
      <View style={{ gap: 6 }}>{inRows.map(placeRow)}</View>
      <Pressable onPress={() => setShowOut((s) => !s)} accessibilityRole="button" testID="list-toggle-out">
        <SectionTitle>
          {showOut ? '▾' : '▸'} {t('listEdit.notInList', { count: outRows.length })}
        </SectionTitle>
      </Pressable>
      {showOut && <View style={{ gap: 6 }}>{outRows.map(placeRow)}</View>}
    </View>
  );

  const actions = (
    <View style={[styles.actions, { paddingBottom: insets.bottom + 16 }]}>
      {listId &&
        (confirmDelete ? (
          <>
            <Button
              kind="danger"
              label={t('lists.delete')}
              onPress={() => {
                mutate((s) => s.deleteList(listId));
                router.replace('/lists');
              }}
              testID="list-confirm-delete"
            />
            <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirmDelete(false)} />
          </>
        ) : (
          <Button kind="secondary" label={t('lists.delete')} onPress={() => setConfirmDelete(true)} testID="list-delete" />
        ))}
      <Button label={t('listEdit.save')} onPress={save} disabled={!canSave(draft)} testID="list-save" />
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScreenHeader title={listId ? t('listEdit.titleEdit') : t('listEdit.titleNew')} onBack={back} />
      {wide ? (
        <View style={styles.split}>
          <View style={{ width: Math.min(520, width * 0.46) }}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: gutter }} keyboardShouldPersistTaps="handled" testID="list-editor">
              {form}
              {actions}
            </ScrollView>
          </View>
          <ScrollView style={{ flex: 1, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: c.border }} contentContainerStyle={{ padding: gutter }}>
            {preview}
          </ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: gutter }} keyboardShouldPersistTaps="handled" testID="list-editor">
          {form}
          <View style={{ marginTop: 16 }}>{preview}</View>
          {actions}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  split: { flex: 1, flexDirection: 'row' },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16, textAlignVertical: 'top' },
  hint: { fontSize: 13, marginTop: 6 },
  label: { fontSize: 13, marginTop: 6, marginBottom: 6 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  searchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  previewHead: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  count: { fontSize: 20, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  square: { width: 12, height: 12, borderRadius: 3 },
  rowName: { fontSize: 15, fontWeight: '700' },
  rowMeta: { fontSize: 13, marginTop: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end', marginTop: 24 },
});
