import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AreaGeometry, SavePatch } from '@triangulair/data';
import type { LineString, MultiLineString } from 'geojson';

import { PlaceCard } from '../components/PlaceCard';
import { SaveEditor, type SaveFields } from '../components/SaveEditor';
import { Button, SectionTitle } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useTags } from '../data/usePlaces';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { STREET_BUFFER_M } from '../lists/listLogic';
import { formatDistance } from '../places/card';
import { useAppState } from '../state/AppState';
import { bufferLines } from './raster';
import { linesLengthM, linesOf } from './streets';

interface Props {
  placeId: string;
  onClose?: () => void;
  onDeleted?: () => void;
  /** Tap on a place listed inside the zone. */
  onOpenPlace?: (placeId: string) => void;
}

/** The place card, or the zone card when the place is a zone. Drop-in for PlaceCard. */
export function PlaceOrZoneCard(props: Props) {
  const { repo, version } = useData();
  const isZone = useMemo(() => repo.getPlace(props.placeId)?.kind === 'zone', [repo, props.placeId, version]);
  return isZone ? <ZoneCard {...props} /> : <PlaceCard {...props} />;
}

/** Area a zone covers, for "places inside" (a street: within STREET_BUFFER_M of it). */
export function zoneArea(g: { type: string }): AreaGeometry | null {
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') return g as AreaGeometry;
  if (g.type === 'LineString' || g.type === 'MultiLineString') return bufferLines(linesOf(g as LineString | MultiLineString), STREET_BUFFER_M);
  return null;
}

/**
 * Zone card (spec "Zones"): like the place card (name, kind of zone, my tags,
 * status, comment, sharing), without opening hours or closure detection, plus
 * the places saved inside it (mine and my friends').
 */
export function ZoneCard({ placeId, onClose, onDeleted, onOpenPlace }: Props) {
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const { repo, mutate, version } = useData();
  const { tags } = useTags();
  const { setTrashed } = useAppState();
  const place = useMemo(() => repo.getPlace(placeId), [repo, placeId, version]);
  const save = useMemo(() => {
    const s = repo.getMySaveForPlace(placeId);
    return s && s.deletedAt === null ? s : null;
  }, [repo, placeId, version]);
  const [comment, setComment] = useState(save?.comment ?? '');
  useEffect(() => setComment(save?.comment ?? ''), [save?.id, save?.comment]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const inside = useMemo(() => {
    if (!place) return [];
    const area = zoneArea(place.geometry);
    if (!area) return [];
    return repo
      .queryPlaces({ within: area, limit: 200, sort: 'name' })
      // `within` tests shapes exactly; zones overlapping this one are not "places inside".
      .filter((p) => p.id !== placeId && p.kind !== 'zone');
  }, [repo, place, placeId, version]);

  if (!place) {
    return (
      <Text style={{ color: c.textMuted }} maxFontSizeMultiplier={2}>
        {t('card.notFound')}
      </Text>
    );
  }

  const g = place.geometry;
  const kindLabel =
    g.type === 'LineString' || g.type === 'MultiLineString'
      ? t('zoneCard.street', {
          count: g.type === 'LineString' ? 1 : g.coordinates.length,
          length: formatDistance(linesLengthM(linesOf(g)), tr) ?? '',
        })
      : place.osmType
        ? t('zoneCard.osm')
        : place.edge === 'blurred'
          ? t('zoneCard.painted')
          : t('zoneCard.drawn');

  const fields: SaveFields | null = save
    ? {
        tagIds: save.tagIds.filter((id) => tags.some((x) => x.id === id)),
        status: save.status,
        priceLevel: save.priceLevel,
        comment,
        commentVisibility: save.commentVisibility,
        sharing: save.sharing,
      }
    : null;

  const apply = (patch: Partial<SaveFields>) => {
    if (!save) return;
    if (patch.comment !== undefined) setComment(patch.comment);
    const { tagIds, comment: _c, ...rest } = patch;
    const p: SavePatch = rest;
    mutate((s) => {
      if (tagIds) s.setSaveTags(placeId, tagIds, tagIds[0] ?? null);
      if (Object.keys(p).length) s.updateSave(placeId, p);
    });
  };

  return (
    <View testID="zone-card">
      <View style={styles.headerRow}>
        <View style={[styles.badge, { backgroundColor: tags.find((x) => x.id === fields?.tagIds[0])?.color ?? c.textMuted }]} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
            {place.name}
          </Text>
          <Text style={[styles.meta, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {kindLabel}
            {save ? ` · ${t('card.inMyPlaces')}` : ''}
          </Text>
        </View>
        {onClose && (
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            hitSlop={10}
            style={[styles.close, { backgroundColor: c.surfaceAlt }]}
            testID="card-close"
          >
            <Text style={{ color: c.textMuted, fontSize: 16 }} maxFontSizeMultiplier={1.5}>
              ✕
            </Text>
          </Pressable>
        )}
      </View>
      {place.osmType && (
        <Text style={[styles.attrib, { color: c.textMuted }]} maxFontSizeMultiplier={1.6}>
          {t('zoneCard.osmAttribution')}
        </Text>
      )}

      <SectionTitle>{t('zoneCard.inside', { count: inside.length })}</SectionTitle>
      {inside.length === 0 ? (
        <Text style={[styles.line, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('zoneCard.insideNone')}
        </Text>
      ) : (
        <View style={styles.wrap} testID="zone-inside">
          {inside.slice(0, 30).map((p) => {
            const main = p.mine?.tagIds[0] ? tags.find((x) => x.id === p.mine!.tagIds[0]) : undefined;
            return (
              <Pressable
                key={p.id}
                onPress={onOpenPlace ? () => onOpenPlace(p.id) : undefined}
                style={[styles.insidePill, { borderColor: c.border, backgroundColor: c.surface }]}
                accessibilityRole={onOpenPlace ? 'button' : 'text'}
              >
                <View style={[styles.dot, { backgroundColor: main?.color ?? c.textMuted }]} />
                <Text style={{ color: c.text, fontSize: 14 }} maxFontSizeMultiplier={2}>
                  {p.name}
                  {p.mine ? '' : ` · ${t('list.friendsOnly')}`}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {fields ? (
        <>
          <SaveEditor value={fields} tags={tags} onChange={apply} onCommentCommit={(text) => {
            // Typing only updates the field; the comment is saved when the field is left.
            if (save && text !== save.comment) mutate((st) => st.updateSave(placeId, { comment: text }));
          }} />
          <View style={{ marginTop: 20 }}>
            {confirmDelete ? (
              <View style={{ gap: 8 }}>
                <Text style={{ color: c.text }} maxFontSizeMultiplier={2}>
                  {t('zoneCard.confirmDelete')}
                </Text>
                <View style={styles.wrap}>
                  <Button
                    kind="danger"
                    label={t('card.delete')}
                    onPress={() => {
                      mutate((s) => s.deleteSave(placeId));
                      setTrashed({ placeId, name: place.name });
                      setConfirmDelete(false);
                      onDeleted?.();
                    }}
                    testID="confirm-delete"
                  />
                  <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirmDelete(false)} />
                </View>
              </View>
            ) : (
              <Button kind="secondary" label={t('card.delete')} onPress={() => setConfirmDelete(true)} testID="delete" />
            )}
          </View>
        </>
      ) : (
        <View style={{ marginTop: 16 }}>
          <Button label={t('card.addToMine')} onPress={() => mutate((s) => s.putSave({ place }))} testID="add-to-mine" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 4 },
  badge: { width: 28, height: 28, borderRadius: 8, borderWidth: 2.5, borderColor: '#FFFFFF', marginTop: 2 },
  name: { fontSize: 22, fontWeight: '700' },
  meta: { fontSize: 14, marginTop: 2 },
  close: { minWidth: 44, minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  line: { fontSize: 15 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  insidePill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, minHeight: 32, borderRadius: 999, borderWidth: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  attrib: { fontSize: 11, marginTop: 6 },
});
