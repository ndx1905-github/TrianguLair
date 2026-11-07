import { useEffect, useMemo, useState } from 'react';
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { parseOsmPlaceId, type SavePatch } from '@triangulair/data';
import type { Photo } from '@triangulair/osm';

import { useRouter } from 'expo-router';

import { isDueOnCardOpen } from '../closure/glue';
import { checkPlaces, resolveClosure } from '../closure/run';
import { useData } from '../data/DataProvider';
import { useFactsLookup, useTags } from '../data/usePlaces';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { osmClient } from '../osm/client';
import { classifyOsmError } from '../osm/errors';
import { cardInfo } from '../places/card';
import { placeInfoOf } from '../places/model';
import { useAppState } from '../state/AppState';
import { ClosureSection } from './ClosureSection';
import { DirectionsSection } from './DirectionsSection';
import { ListsSection } from './ListsSection';
import { SaveEditor, type SaveFields } from './SaveEditor';
import { FriendsSection } from '../sync/FriendsSection';
import { Banner, Button, Pill, SectionTitle } from './ui';

/** Refresh the OSM data of a place at most this often when its card opens. */
const REFRESH_AFTER_MS = 7 * 24 * 3600_000;

interface Props {
  placeId: string;
  onClose?: () => void;
  /** After the save went to the trash. */
  onDeleted?: () => void;
}

/**
 * Place card (T-107): name, category, address, opening line, happy hour,
 * practical chips, free photos with their credit lines; then my tags,
 * status, price, comment (editable, saved immediately) and the trash.
 */
export function PlaceCard({ placeId, onClose, onDeleted }: Props) {
  const c = useUiColors();
  const tr = useI18n();
  const { t } = tr;
  const { repo, mutate, version } = useData();
  const { tags } = useTags();
  const lookup = useFactsLookup();
  const router = useRouter();
  const { setTrashed } = useAppState();

  const place = useMemo(() => repo.getPlace(placeId), [repo, placeId, version]);
  const save = useMemo(() => {
    const s = repo.getMySaveForPlace(placeId);
    return s && s.deletedAt === null ? s : null;
  }, [repo, placeId, version]);
  const info = useMemo(() => (place ? placeInfoOf(place) : null), [place]);
  const now = new Date();
  const card = place ? cardInfo(place, info, now, tr, tr.region) : null;

  const [comment, setComment] = useState(save?.comment ?? '');
  useEffect(() => setComment(save?.comment ?? ''), [save?.id, save?.comment]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [offline, setOffline] = useState(false);

  // Enrich from OSM: refresh the cached tags (monthly in the spec; here when stale), then photos.
  const osmRef = place ? parseOsmPlaceId(place.id) : null;
  useEffect(() => {
    if (!place || !osmRef) return;
    const ctrl = new AbortController();
    const osm = osmClient();
    (async () => {
      let current = info;
      const stale = !place.osmSyncedAt || Date.now() - place.osmSyncedAt > REFRESH_AFTER_MS;
      if (save && (stale || isDueOnCardOpen(place, new Date()))) {
        // My place: the refresh is the closed-place check (spec: card opened, last check over a month old).
        try {
          const [res] = await checkPlaces([place], osm, mutate, ctrl.signal);
          if (res?.place) current = res.place;
        } catch (e) {
          if (classifyOsmError(e) === 'aborted') return;
          setOffline(true);
        }
      } else if (stale) {
        try {
          const fresh = await osm.overpass.getPlace({ type: osmRef.osmType, id: osmRef.osmId }, { signal: ctrl.signal });
          if (fresh && !ctrl.signal.aborted) {
            mutate(() =>
              repo.updatePlaceOsmData(place.id, {
                osmTags: fresh.tags,
                openingHours: fresh.openingHours ?? null,
                address: fresh.address.formatted ?? null,
                website: fresh.contact.website ?? null,
                phone: fresh.contact.phones[0] ?? null,
                osmSyncedAt: Date.now(),
              }),
            );
            current = fresh;
          }
        } catch (e) {
          if (classifyOsmError(e) === 'aborted') return;
          setOffline(true);
        }
      }
      if (!current) return;
      try {
        const list = await osm.placePhotos(current, { signal: ctrl.signal, limit: 4, width: 480 });
        if (!ctrl.signal.aborted) setPhotos(list);
      } catch (e) {
        if (classifyOsmError(e) !== 'aborted') setOffline(true);
      }
    })();
    return () => ctrl.abort();
    // Only when the card opens for another place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeId]);

  if (!place || !card) {
    return (
      <Text style={{ color: c.textMuted }} maxFontSizeMultiplier={2}>
        {t('card.notFound')}
      </Text>
    );
  }

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

  const addToMine = () => {
    const facts = lookup(placeId);
    mutate((s) => s.putSave({ place, tagIds: facts?.tagIds ?? [], mainTagId: facts?.tagIds[0] ?? null }));
  };

  const toneColor = card.opening?.tone === 'open' ? c.open : card.opening?.tone === 'closed' ? c.closed : c.textMuted;

  return (
    <View testID="place-card">
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
            {place.name}
          </Text>
          <Text style={[styles.meta, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {card.category}
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

      <ClosureSection place={place} mine={!!save} />
      {card.opening && (
        <Text style={[styles.opening, { color: toneColor }]} maxFontSizeMultiplier={2} testID="opening-line">
          {card.opening.text}
        </Text>
      )}
      {card.happyHour && (
        <Text style={[styles.line, { color: c.text }]} maxFontSizeMultiplier={2} testID="happy-hour">
          🍹 {card.happyHour}
        </Text>
      )}
      {card.address && (
        <Text style={[styles.line, { color: c.text }]} maxFontSizeMultiplier={2}>
          {card.address}
        </Text>
      )}
      {card.chips.length > 0 && (
        <View style={styles.wrap}>
          {card.chips.map((chip) => (
            <Pill key={chip.key} label={chip.label} />
          ))}
        </View>
      )}
      {(card.website || card.phone) && (
        <View style={[styles.wrap, { marginTop: 10 }]}>
          {card.website && (
            <Button kind="secondary" label={t('card.website')} onPress={() => void Linking.openURL(card.website!.startsWith('http') ? card.website! : `https://${card.website}`)} />
          )}
          {card.phone && <Button kind="secondary" label={t('card.call')} onPress={() => void Linking.openURL(`tel:${card.phone!.replace(/\s/g, '')}`)} />}
        </View>
      )}

      <DirectionsSection place={place} address={card.address} />

      {photos.length > 0 && (
        <>
          <SectionTitle>{t('card.photos')}</SectionTitle>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photos} testID="photos">
            {photos.map((p) => (
              <View key={p.id} style={styles.photo}>
                <Image
                  source={{ uri: p.thumbnailUrl || p.url }}
                  style={[styles.photoImg, { backgroundColor: c.surfaceAlt }]}
                  accessibilityLabel={p.streetLevel ? t('card.streetPhoto') : t('card.photo')}
                />
                <Pressable onPress={() => void Linking.openURL(p.pageUrl)} accessibilityRole="link">
                  <Text style={[styles.credit, { color: c.textMuted }]} maxFontSizeMultiplier={1.8} testID="photo-credit">
                    {t('card.photoCredit', {
                      author: p.author ?? t('card.unknownAuthor'),
                      license: p.license.name,
                      source: p.source === 'panoramax' ? 'Panoramax' : 'Wikimedia Commons',
                    })}
                  </Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </>
      )}
      {offline && (
        <View style={{ marginTop: 10 }}>
          <Banner>{t('card.offline')}</Banner>
        </View>
      )}
      {info && (
        <Text style={[styles.attrib, { color: c.textMuted }]} maxFontSizeMultiplier={1.6}>
          {place.osmType ? t('card.osmAttribution') : t('card.manualInfo')}
        </Text>
      )}

      <FriendsSection placeId={placeId} />

      {fields ? (
        <>
          <SaveEditor value={fields} tags={tags} onChange={apply} onCommentCommit={(text) => {
            // Typing only updates the field; the comment is saved when the field is left.
            if (save && text !== save.comment) mutate((st) => st.updateSave(placeId, { comment: text }));
          }} />
          <View style={[styles.wrap, { marginTop: 8 }]}>
            <Button kind="secondary" label={t('fb.manageTags')} onPress={() => router.push('/tags')} testID="card-manage-tags" />
            {place.status === 'open' && (
              <Button kind="secondary" label={t('closure.report')} onPress={() => resolveClosure(place, 'closed', mutate)} testID="closure-report" />
            )}
          </View>
          {save && <ListsSection placeId={placeId} save={save} />}
          <View style={{ marginTop: 20 }}>
            {confirmDelete ? (
              <View style={{ gap: 8 }}>
                <Text style={{ color: c.text }} maxFontSizeMultiplier={2}>
                  {t('card.confirmDelete')}
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
          <Button label={t('card.addToMine')} onPress={addToMine} testID="add-to-mine" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 4 },
  name: { fontSize: 22, fontWeight: '700' },
  meta: { fontSize: 14, marginTop: 2 },
  close: { minWidth: 44, minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  opening: { fontSize: 15, fontWeight: '700', marginTop: 10 },
  line: { fontSize: 15, marginTop: 6 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  photos: { gap: 10 },
  photo: { width: 200 },
  photoImg: { width: 200, height: 140, borderRadius: 10 },
  credit: { fontSize: 11, marginTop: 4 },
  attrib: { fontSize: 11, marginTop: 10 },
});
