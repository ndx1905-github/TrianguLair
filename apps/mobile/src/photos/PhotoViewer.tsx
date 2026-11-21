/**
 * Full-screen photo viewer (T-111b): the full photo (a friend's is downloaded now, then kept in the
 * friends' cache), its author and date, previous / next, and "Remove" on my own photos.
 */
import { useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PhotoItem, Photos } from '@triangulair/sync';

import { Button } from '../components/ui';
import { useI18n } from '../i18n';
import { usePhotoImage } from './usePhotos';

interface Props {
  svc: Photos;
  items: PhotoItem[];
  index: number;
  nameOf: (owner: string) => string;
  onIndex: (i: number) => void;
  onClose: () => void;
  onRemove: (item: PhotoItem) => void;
}

const FG = '#FFFFFF';
const MUTED = '#C8C8C8';
const BG = '#000000';
const BTN = 'rgba(255,255,255,0.16)';

export function PhotoViewer({ svc, items, index, nameOf, onIndex, onClose, onRemove }: Props) {
  const { t, locale } = useI18n();
  const insets = useSafeAreaInsets();
  const item = items[index]!;
  const full = usePhotoImage(svc, item.id, 'full');
  const thumb = usePhotoImage(svc, item.id, 'thumb');
  const [confirm, setConfirm] = useState(false);
  const shown = full.kind === 'ready' ? full : thumb.kind === 'ready' ? thumb : null;
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(item.createdAt));
  const go = (d: number) => {
    setConfirm(false);
    onIndex((index + d + items.length) % items.length);
  };

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} transparent={false}>
      <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 }]} testID="photo-viewer">
        <View style={styles.top}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} maxFontSizeMultiplier={2} testID="photo-viewer-author">
              {item.mine ? t('photos.byMe') : t('photos.by', { name: nameOf(item.ownerId) })}
            </Text>
            <Text style={styles.meta} maxFontSizeMultiplier={2}>
              {items.length > 1 ? `${date} · ${t('photos.of', { n: index + 1, count: items.length })}` : date}
            </Text>
          </View>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close')} hitSlop={10} style={styles.round} testID="photo-viewer-close">
            <Text style={{ color: FG, fontSize: 18 }} maxFontSizeMultiplier={1.5}>
              ✕
            </Text>
          </Pressable>
        </View>
        <View style={styles.stage}>
          {shown ? (
            <Image
              source={{ uri: shown.uri }}
              style={styles.image}
              resizeMode="contain"
              accessibilityLabel={t('photos.thumb', { name: item.mine ? t('photos.byMe') : nameOf(item.ownerId), date })}
              testID={full.kind === 'ready' ? 'photo-full' : 'photo-preview'}
            />
          ) : null}
          {full.kind === 'loading' && (
            <View style={styles.overlay} testID="photo-loading">
              <ActivityIndicator color={FG} />
              <Text style={styles.meta} maxFontSizeMultiplier={2}>
                {t('photos.loading')}
              </Text>
            </View>
          )}
          {(full.kind === 'missing' || full.kind === 'error') && !shown && (
            <Text style={styles.meta} maxFontSizeMultiplier={2} testID="photo-unavailable">
              {t('photos.unavailable')}
            </Text>
          )}
        </View>
        <View style={styles.bottom}>
          {items.length > 1 && (
            <Pressable onPress={() => go(-1)} accessibilityRole="button" accessibilityLabel={t('photos.previous')} style={styles.round} testID="photo-prev">
              <Text style={{ color: FG, fontSize: 22 }} maxFontSizeMultiplier={1.5}>
                ‹
              </Text>
            </Pressable>
          )}
          <View style={{ flex: 1, alignItems: 'center', gap: 8 }}>
            {item.mine &&
              (confirm ? (
                <View style={{ gap: 8, alignItems: 'center' }}>
                  <Text style={styles.title} maxFontSizeMultiplier={2}>
                    {t('photos.removeConfirm')}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button kind="danger" label={t('photos.remove')} onPress={() => onRemove(item)} testID="photo-remove-confirm" />
                    <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirm(false)} />
                  </View>
                </View>
              ) : (
                <Button kind="secondary" label={t('photos.remove')} onPress={() => setConfirm(true)} testID="photo-remove" />
              ))}
          </View>
          {items.length > 1 && (
            <Pressable onPress={() => go(1)} accessibilityRole="button" accessibilityLabel={t('photos.next')} style={styles.round} testID="photo-next">
              <Text style={{ color: FG, fontSize: 22 }} maxFontSizeMultiplier={1.5}>
                ›
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG, paddingHorizontal: 16 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { color: FG, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  meta: { color: MUTED, fontSize: 13 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', marginVertical: 12 },
  image: { width: '100%', height: '100%' },
  overlay: { position: 'absolute', alignItems: 'center', gap: 8 },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: BTN },
});
