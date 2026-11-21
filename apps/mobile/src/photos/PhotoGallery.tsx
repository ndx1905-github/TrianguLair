/**
 * Personal photos on the place card (T-111b; spec "User photos: you and your friends, visible
 * according to the place's visibility"): my photos first (add from the camera or the library,
 * remove), then each friend's, under their name. Thumbnails only; a tap opens the viewer, which
 * downloads a friend's full photo then (spec: "friends download the full photo only when opening
 * it").
 */
import { useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { PhotoError, isFollowId, type PhotoItem, type Photos } from '@triangulair/sync';

import { Banner, Button, SectionTitle } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { useMaybeSync } from '../sync/SyncProvider';
import { QUALITY, photoQuality } from './model';
import { pickImage, processImage } from './pick';
import { PhotoPermissionError, PhotoProcessError, type PickSource } from './pick.types';
import { PhotoViewer } from './PhotoViewer';
import { usePhotoImage, usePhotosService } from './usePhotos';

const THUMB = 96;

export function PhotoGallery({ placeId, mine }: { placeId: string; mine: boolean }) {
  const c = useUiColors();
  const { t } = useI18n();
  const { repo, mutate, version } = useData();
  const svc = usePhotosService();
  const sync = useMaybeSync();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const items = useMemo(() => (svc ? svc.list(placeId) : []), [svc, placeId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => {
    const out: { owner: string; mine: boolean; items: PhotoItem[] }[] = [];
    for (const it of items) {
      let g = out.find((x) => x.owner === it.ownerId);
      if (!g) out.push((g = { owner: it.ownerId, mine: it.mine, items: [] }));
      g.items.push(it);
    }
    return out;
  }, [items]);
  if (!svc || (!mine && items.length === 0)) return null;

  const nameOf = (owner: string) =>
    owner === repo.meId ? t('photos.byMe') : isFollowId(owner) ? t('sharing.asSource', { name: repo.getPerson(owner)?.displayName || t('sharing.unnamed') }) : repo.getPerson(owner)?.displayName || t('card.aFriend');
  const status = sync?.snapshot?.status;
  const publishes = !!sync?.snapshot?.publishes;
  const waitingText = !publishes ? t('photos.waitingLocal') : status?.problem?.kind === 'quota' ? t('photos.waitingQuota') : t('photos.waiting');

  const add = async (from: PickSource) => {
    setError(null);
    let picked;
    try {
      picked = await pickImage(from);
    } catch (e) {
      setError(e instanceof PhotoPermissionError ? t('photos.error.permission') : t('photos.error.other'));
      return;
    }
    if (!picked) return;
    setBusy(true);
    try {
      const input = await processImage(picked, QUALITY[photoQuality()]);
      // Through mutate: the card redraws and the edit is published like any other.
      mutate(() => svc.add(placeId, input));
    } catch (e) {
      // Never refused for its size (made to fit when processed): only a file that is not an image.
      if (e instanceof PhotoProcessError || (e instanceof PhotoError && e.code !== 'no-save')) setError(t('photos.error.format'));
      else setError(t('photos.error.other'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID="personal-photos">
      <SectionTitle>{t('photos.section')}</SectionTitle>
      {groups.length === 0 && (
        <Text style={[styles.muted, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
          {t('photos.none')}
        </Text>
      )}
      {groups.map((g) => (
        <View key={g.owner} style={{ marginTop: 6 }} testID={g.mine ? 'photos-mine' : 'photos-friend'}>
          <Text style={[styles.owner, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {g.mine ? t('photos.mine') : t('photos.by', { name: nameOf(g.owner) })}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
            {g.items.map((it) => (
              <Thumb
                key={it.id}
                svc={svc}
                item={it}
                label={t('photos.thumb', { name: nameOf(it.ownerId), date: new Date(it.createdAt).toLocaleDateString() })}
                waiting={it.state === 'waiting' ? waitingText : null}
                refreshKey={`${version}`}
                onPress={() => setOpen(items.indexOf(it))}
              />
            ))}
          </ScrollView>
        </View>
      ))}
      {mine && (
        <View style={{ gap: 6, marginTop: 8 }}>
          <View style={styles.actions}>
            <Button kind="secondary" label={t('photos.camera')} onPress={() => void add('camera')} disabled={busy} testID="photo-camera" />
            <Button kind="secondary" label={t('photos.library')} onPress={() => void add('library')} disabled={busy} testID="photo-add" />
          </View>
          {busy && (
            <View style={styles.actions} testID="photo-busy">
              <ActivityIndicator color={c.accent} />
              <Text style={{ color: c.textMuted }} maxFontSizeMultiplier={2}>
                {t('photos.processing')}
              </Text>
            </View>
          )}
          <Text style={[styles.hint, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {t('photos.privacy')}
          </Text>
        </View>
      )}
      {error && (
        <View style={{ marginTop: 8 }}>
          <Banner tone="warning" testID="photo-error">
            {error}
          </Banner>
        </View>
      )}
      {open !== null && items[open] && (
        <PhotoViewer
          svc={svc}
          items={items}
          index={open}
          nameOf={nameOf}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          onRemove={(it) => {
            mutate(() => svc.remove(placeId, it.id));
            setOpen(null);
          }}
        />
      )}
    </View>
  );
}

function Thumb({ svc, item, label, waiting, refreshKey, onPress }: { svc: Photos; item: PhotoItem; label: string; waiting: string | null; refreshKey: string; onPress: () => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  const img = usePhotoImage(svc, item.id, 'thumb', refreshKey);
  return (
    <Pressable onPress={onPress} accessibilityRole="imagebutton" accessibilityLabel={waiting ? `${label}. ${waiting}` : label} testID={`photo-thumb-${item.id}`}>
      <View style={[styles.thumb, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}>
        {img.kind === 'ready' ? (
          <Image source={{ uri: img.uri }} style={styles.thumb} resizeMode="cover" testID="photo-thumb-image" />
        ) : img.kind === 'loading' ? (
          <ActivityIndicator color={c.textMuted} />
        ) : (
          <Text style={{ color: c.textMuted, fontSize: 11, textAlign: 'center', padding: 4 }} maxFontSizeMultiplier={1.5}>
            {t('photos.unavailable')}
          </Text>
        )}
      </View>
      {waiting && (
        <Text style={[styles.badge, { color: c.textMuted }]} numberOfLines={2} maxFontSizeMultiplier={1.5} testID="photo-waiting">
          {waiting}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingVertical: 4 },
  owner: { fontSize: 13, fontWeight: '600' },
  thumb: { width: THUMB, height: THUMB, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  badge: { width: THUMB, fontSize: 11, marginTop: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  muted: { fontSize: 14 },
  hint: { fontSize: 12 },
});
