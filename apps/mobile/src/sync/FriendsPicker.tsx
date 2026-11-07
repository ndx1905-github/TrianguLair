/**
 * The friends panel of the filter bar (spec "Interface"): "All my friends", "None" or a selection,
 * with search, avatar and number of places per friend; the choice is remembered on this device.
 */
import { useMemo, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, Pill } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { foldText } from '../tags/text';
import { ALL_FRIENDS, isShown, setSelection, toggleFriend, useFriendsSelection, type FriendsSelection } from './friendsSelection';

export interface FollowedPerson {
  id: string;
  name: string;
  avatar: string | null;
  places: number;
}

/** People whose places are in my cache or whom I follow, with their number of places. */
export function useFollowed(): FollowedPerson[] {
  const { repo, version } = useData();
  return useMemo(() => {
    try {
      return repo.db
        .all<{ id: string; name: string; avatar: string | null; n: number }>(
          `SELECT p.id, p.display_name AS name, p.avatar, count(s.id) AS n FROM people p
             LEFT JOIN saves s ON s.owner_id = p.id AND s.deleted_at IS NULL AND s.sharing <> 'private'
            WHERE p.is_me = 0 GROUP BY p.id HAVING max(p.i_follow) = 1 OR count(s.id) > 0 ORDER BY p.display_name, p.id`,
        )
        .map((r) => ({ id: r.id, name: r.name, avatar: r.avatar, places: r.n }));
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, version]);
}

export function selectionLabel(s: FriendsSelection, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (s.mode === 'all') return t('friends.filter.all');
  if (s.mode === 'none') return t('friends.filter.none');
  return t('friends.filter.some', { count: s.ids.length });
}

export function Avatar({ name, uri, size = 32 }: { name: string; uri: string | null; size?: number }) {
  const c = useUiColors();
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  if (uri) return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} accessibilityIgnoresInvertColors />;
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: c.surfaceAlt, borderColor: c.border }]}>
      <Text style={{ color: c.text, fontWeight: '700', fontSize: size * 0.45 }} maxFontSizeMultiplier={1.4}>
        {letter}
      </Text>
    </View>
  );
}

/**
 * The pill that opens the panel (filter bar), or, in the collapsed summary (`summary`), a removable
 * pill shown only when not every friend is shown. Nothing when I follow nobody.
 */
export function FriendsFilterPill({ summary = false }: { summary?: boolean }) {
  const { t } = useI18n();
  const people = useFollowed();
  const sel = useFriendsSelection();
  const [open, setOpen] = useState(false);
  if (people.length === 0) return null;
  if (summary) {
    if (sel.mode === 'all') return null;
    return (
      <Pill
        label={selectionLabel(sel, t)}
        selected
        onRemove={() => setSelection(ALL_FRIENDS)}
        removeLabel={t('filters.remove', { name: selectionLabel(sel, t) })}
        testID="filter-pill-friends-shown"
      />
    );
  }
  return (
    <>
      <Pill label={`${selectionLabel(sel, t)} ▾`} selected={sel.mode !== 'all'} onPress={() => setOpen(true)} testID="friends-picker-open" />
      {open && <FriendsPicker people={people} onClose={() => setOpen(false)} />}
    </>
  );
}

function FriendsPicker({ people, onClose }: { people: FollowedPerson[]; onClose: () => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  const { wide, gutter } = useLayout();
  const sel = useFriendsSelection();
  const [q, setQ] = useState('');
  const everyone = people.map((p) => p.id);
  const shown = q ? people.filter((p) => foldText(p.name).includes(foldText(q))) : people;
  const name = (p: FollowedPerson) => p.name || t('card.aFriend');
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable style={[styles.scrim, { backgroundColor: c.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close')} />
      <View style={[styles.sheetWrap, wide && styles.sheetWrapWide]} pointerEvents="box-none">
        <View style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border, padding: gutter, maxWidth: wide ? 480 : undefined }]} testID="friends-picker">
          <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
            {t('friends.picker.title')}
          </Text>
          <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
            {t('friends.picker.lead')}
          </Text>
          <View style={styles.row}>
            <Pill label={t('friends.picker.all')} selected={sel.mode === 'all'} onPress={() => setSelection(ALL_FRIENDS)} testID="friends-all" />
            <Pill label={t('friends.picker.none')} selected={sel.mode === 'none'} onPress={() => setSelection({ mode: 'none' })} testID="friends-none" />
          </View>
          {people.length > 6 && (
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder={t('friends.picker.search')}
              placeholderTextColor={c.textMuted}
              accessibilityLabel={t('friends.picker.search')}
              style={[styles.search, { color: c.text, borderColor: c.border, backgroundColor: c.background }]}
              testID="friends-search"
            />
          )}
          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 4 }}>
            {shown.map((p) => {
              const on = isShown(sel, p.id);
              return (
                <Pressable
                  key={p.id}
                  onPress={() => setSelection(toggleFriend(sel, p.id, everyone))}
                  style={({ pressed }) => [styles.person, { backgroundColor: pressed ? c.surfaceAlt : 'transparent' }]}
                  accessibilityRole="checkbox"
                  aria-checked={on}
                  accessibilityLabel={`${name(p)}, ${t('friends.picker.places', { count: p.places })}`}
                  testID={`friends-person-${p.name}`}
                >
                  <Avatar name={name(p)} uri={p.avatar} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                      {name(p)}
                    </Text>
                    <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2}>
                      {t('friends.picker.places', { count: p.places })}
                    </Text>
                  </View>
                  <View style={[styles.check, { borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accent : 'transparent' }]}>
                    {on ? (
                      <Text style={{ color: '#FFFFFF', fontWeight: '800' }} maxFontSizeMultiplier={1.4}>
                        ✓
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={{ alignItems: 'flex-end' }}>
            <Button label={t('friends.picker.done')} onPress={onClose} testID="friends-done" />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheetWrapWide: { justifyContent: 'center', alignItems: 'center' },
  sheet: { width: '100%', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, gap: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  search: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 6, borderRadius: 10 },
  avatar: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  check: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
