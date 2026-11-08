/**
 * Under the map's filter bar: the note about my storage when there is something to say ("Offline ·
 * 3 changes pending", "Your storage hasn't responded since yesterday", "Reconnect your storage"),
 * the What's new button with its badge, and the What's new highlight once "See on the map" was used.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Pill } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { useAppState } from '../state/AppState';
import { noteText } from './noteText';
import { ownNote } from './problems';
import { useMaybeSync } from './SyncProvider';
import { useFollowed } from './FriendsPicker';

export function SyncBar() {
  const c = useUiColors();
  const { t, locale } = useI18n();
  const router = useRouter();
  const sync = useMaybeSync();
  const followed = useFollowed();
  const { highlight, setHighlight } = useAppState();
  const snap = sync?.snapshot ?? null;
  if (!snap) return null;
  const note = ownNote(snap.status, snap.publishes);
  const showNews = followed.length > 0 || snap.friends.length > 0 || snap.unseen > 0;
  if (!note && !showNews && !highlight) return null;
  const toneBg = note?.tone === 'error' ? c.warningBg : note?.tone === 'warning' ? c.warningBg : c.surface;
  const toneBorder = note?.tone === 'error' ? c.danger : note?.tone === 'warning' ? c.warning : c.border;

  return (
    <View style={styles.row} pointerEvents="box-none">
      {note && (
        <Pressable
          onPress={() => router.push(note.action === 'storage' ? '/storage' : '/sync')}
          style={[styles.note, { backgroundColor: toneBg, borderColor: toneBorder, shadowColor: c.shadow }]}
          accessibilityRole="button"
          accessibilityLiveRegion="polite"
          testID={`sync-note-${note.id}`}
        >
          <Text style={{ color: c.text, fontSize: 14, fontWeight: '600', flexShrink: 1 }} maxFontSizeMultiplier={2}>
            {noteText(note, snap.status, t, locale, Date.now())}
          </Text>
          <Text style={{ color: c.accent, fontSize: 14, fontWeight: '700' }} maxFontSizeMultiplier={2}>
            {note.action === 'storage' ? t('sync.note.fix') : t('sync.note.open')}
          </Text>
        </Pressable>
      )}
      {showNews && (
        <Pressable
          onPress={() => router.push('/whatsnew')}
          style={[styles.news, { backgroundColor: c.surface, borderColor: c.border, shadowColor: c.shadow }]}
          accessibilityRole="button"
          accessibilityLabel={t('wn.openA11y', { count: snap.unseen })}
          testID="open-whatsnew"
        >
          <Text style={{ color: c.text, fontSize: 14, fontWeight: '700' }} maxFontSizeMultiplier={2}>
            {t('wn.open')}
          </Text>
          {snap.unseen > 0 && (
            <View style={[styles.badge, { backgroundColor: c.accent }]} testID="whatsnew-badge">
              <Text style={styles.badgeText} maxFontSizeMultiplier={1.4}>
                {snap.unseen > 99 ? '99+' : String(snap.unseen)}
              </Text>
            </View>
          )}
        </Pressable>
      )}
      {highlight && (
        <Pill
          label={t('wn.highlight')}
          selected
          onRemove={() => setHighlight(null)}
          removeLabel={t('wn.highlightClear')}
          testID="whatsnew-highlight"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    maxWidth: 460,
    flexShrink: 1,
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  news: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  badge: { minWidth: 22, minHeight: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
});
