/**
 * "Whose places" (spec "Interface" > "Whose places"): one control at the top of the filter bar.
 * A row of chips, "Me" then each friend with their avatar or initial in their colour, to tick
 * several; a long press on a chip shows only that person's places. The "▾" button opens the panel
 * with the shortcuts (Everyone, Only mine, Only my friends, "Only Léa" on each row), a search and the
 * number of places per friend. The choice is remembered on this device (friendsSelection.ts).
 */
import { useMemo, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { isFollowId } from '@triangulair/sync';

import { Button, Pill } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { foldText } from '../tags/text';
import { useFriendColors } from './friendColors';
import {
  ALL_FRIENDS,
  ONLY_MINE,
  isShown,
  onlyFriend,
  selectionKind,
  setSelection,
  toggleFriend,
  toggleMe,
  useFriendsSelection,
  type FriendsSelection,
} from './friendsSelection';

type T = (k: string, p?: Record<string, string | number>) => string;

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

/** A person's name as shown: a list followed by link (T-212) is named after the list. */
export function usePersonName(): (id: string) => string {
  const { t } = useI18n();
  const { repo, version } = useData();
  return useMemo(
    () => (id: string) => {
      const name = repo.getPerson(id)?.displayName ?? '';
      if (isFollowId(id)) return t('sharing.asSource', { name: name || t('sharing.unnamed') });
      return name || t('card.aFriend');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, version, t],
  );
}

/** "Léa", "Léa and Ben", "Léa, Ben and Sam". */
export function joinNames(names: readonly string[], t: T): string {
  if (names.length <= 1) return names[0] ?? '';
  return t('friends.names2', { a: names.slice(0, -1).join(', '), b: names[names.length - 1]! });
}

/** The selection in a few words: "Everyone", "Only mine", "Only my friends", "Only Léa", "Me + 2 friends". */
export function selectionLabel(s: FriendsSelection, everyone: readonly string[], nameOf: (id: string) => string, t: T): string {
  const k = selectionKind(s, everyone);
  if (k.kind === 'everyone') return t('whose.everyone');
  if (k.kind === 'mine') return t('whose.onlyMine');
  if (k.kind === 'friends') return t('whose.onlyFriends');
  if (k.kind === 'one') return t('whose.only', { name: nameOf(k.friend!) });
  return s.me ? t('whose.meAnd', { count: k.count }) : t('whose.friendsCount', { count: k.count });
}

export function Avatar({ name, uri, size = 32, color }: { name: string; uri: string | null; size?: number; color?: string }) {
  const c = useUiColors();
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2, ...(color ? { borderWidth: 2, borderColor: color } : {}) }}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: color ?? c.surfaceAlt, borderColor: color ? '#FFFFFF' : c.border }]}>
      <Text style={{ color: color ? '#FFFFFF' : c.text, fontWeight: '700', fontSize: size * 0.45 }} maxFontSizeMultiplier={1.4}>
        {letter}
      </Text>
    </View>
  );
}

/** A small coloured dot with a white outline: the mark of a friend's places on the map. */
export function FriendDot({ color, size = 10 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, borderWidth: 1.5, borderColor: '#FFFFFF' }} />;
}

/** At most this many friends get a chip in the row; the panel has them all, with a search. */
const MAX_CHIPS = 12;

function WhoseChip({ label, selected, color, avatar, onPress, onLongPress, a11y, hint, testID }: {
  label: string;
  selected: boolean;
  color: string;
  avatar: string | null;
  onPress: () => void;
  onLongPress: () => void;
  a11y: string;
  hint: string;
  testID: string;
}) {
  const c = useUiColors();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={450}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: selected ? color : c.border, backgroundColor: selected ? c.selectedBg : c.surface, opacity: selected ? 1 : 0.8 },
        pressed && styles.pressed,
      ]}
      accessibilityRole="checkbox"
      aria-checked={selected}
      accessibilityLabel={a11y}
      accessibilityHint={hint}
      hitSlop={4}
      testID={testID}
    >
      <Avatar name={label} uri={avatar} size={22} color={selected ? color : c.textMuted} />
      <Text style={[styles.chipText, { color: selected ? c.text : c.textMuted, fontWeight: selected ? '700' : '500' }]} maxFontSizeMultiplier={2} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The "Whose places" row of the filter bar: "Me" and my friends as chips, then "▾" for the panel.
 * Nothing when I follow nobody (only my places exist).
 */
export function WhoseRow() {
  const { t } = useI18n();
  const c = useUiColors();
  const { repo, version } = useData();
  const people = useFollowed();
  const sel = useFriendsSelection();
  const colorOf = useFriendColors();
  const nameOf = usePersonName();
  const [open, setOpen] = useState(false);
  const me = useMemo(() => repo.getPerson(repo.meId), [repo, version]);
  if (people.length === 0) return null;
  const everyone = people.map((p) => p.id);
  const chips = people.slice(0, MAX_CHIPS);
  const label = selectionLabel(sel, everyone, nameOf, t);
  return (
    <View style={styles.whose} testID="whose-row">
      <View style={styles.whoseHead}>
        <Text style={[styles.whoseTitle, { color: c.textMuted }]} maxFontSizeMultiplier={1.8}>
          {t('whose.title')}
        </Text>
        <Text style={[styles.whoseLabel, { color: c.text }]} maxFontSizeMultiplier={1.8} testID="whose-label">
          {label}
        </Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
        <WhoseChip
          label={t('whose.me')}
          selected={sel.me}
          color={c.accent}
          avatar={me?.avatar ?? null}
          onPress={() => setSelection(toggleMe(sel, everyone))}
          onLongPress={() => setSelection(ONLY_MINE)}
          a11y={t('whose.meA11y')}
          hint={t('whose.longPressMe')}
          testID="whose-me"
        />
        {chips.map((p) => (
          <WhoseChip
            key={p.id}
            label={nameOf(p.id)}
            selected={isShown(sel, p.id)}
            color={colorOf(p.id)}
            avatar={p.avatar}
            onPress={() => setSelection(toggleFriend(sel, p.id, everyone))}
            onLongPress={() => setSelection(onlyFriend(p.id))}
            a11y={`${nameOf(p.id)}, ${t('friends.picker.places', { count: p.places })}`}
            hint={t('whose.longPress', { name: nameOf(p.id) })}
            testID={`whose-friend-${p.name}`}
          />
        ))}
        <Pill
          label={people.length > MAX_CHIPS ? t('whose.morePeople', { count: people.length - MAX_CHIPS }) : '▾'}
          onPress={() => setOpen(true)}
          accessibilityLabel={t('whose.menuA11y')}
          testID="friends-picker-open"
        />
      </ScrollView>
      {open && <FriendsPicker people={people} onClose={() => setOpen(false)} />}
    </View>
  );
}

/** The collapsed bar's pill: shown when not everyone is shown, with a cross back to "Everyone". */
export function WhoseSummaryPill() {
  const { t } = useI18n();
  const people = useFollowed();
  const sel = useFriendsSelection();
  const nameOf = usePersonName();
  const everyone = people.map((p) => p.id);
  // My places hidden with no friend left would show nothing: the pill stays to bring them back.
  if (people.length === 0 && sel.me) return null;
  if (selectionKind(sel, everyone).kind === 'everyone') return null;
  const label = selectionLabel(sel, everyone, nameOf, t);
  return (
    <Pill label={label} selected onRemove={() => setSelection(ALL_FRIENDS)} removeLabel={t('filters.remove', { name: label })} testID="filter-pill-friends-shown" />
  );
}

/** Whether the selection hides something (the bar's summary line then has a pill). */
export function useWhoseFiltered(): boolean {
  const people = useFollowed();
  const sel = useFriendsSelection();
  if (people.length === 0) return !sel.me;
  return selectionKind(sel, people.map((p) => p.id)).kind !== 'everyone';
}

function FriendsPicker({ people, onClose }: { people: FollowedPerson[]; onClose: () => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  const { wide, gutter } = useLayout();
  const sel = useFriendsSelection();
  const colorOf = useFriendColors();
  const nameOf = usePersonName();
  const [q, setQ] = useState('');
  const everyone = people.map((p) => p.id);
  const shown = q ? people.filter((p) => foldText(nameOf(p.id)).includes(foldText(q))) : people;
  const kind = selectionKind(sel, everyone).kind;
  const pick = (s: FriendsSelection) => {
    setSelection(s);
    onClose();
  };
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
            <Pill label={t('whose.everyone')} selected={kind === 'everyone'} onPress={() => pick(ALL_FRIENDS)} testID="whose-everyone" />
            <Pill label={t('whose.onlyMine')} selected={kind === 'mine'} onPress={() => pick(ONLY_MINE)} testID="whose-only-mine" />
            <Pill label={t('whose.onlyFriends')} selected={kind === 'friends'} onPress={() => pick({ mode: 'all', me: false })} testID="whose-only-friends" />
          </View>
          <View style={styles.row}>
            <Pill label={t('friends.picker.all')} selected={sel.mode === 'all'} onPress={() => setSelection({ mode: 'all', me: sel.me })} testID="friends-all" />
            <Pill label={t('friends.picker.none')} selected={sel.mode === 'none'} onPress={() => setSelection({ mode: 'none', me: true })} testID="friends-none" />
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
            {!q && (
              <PersonRow
                name={t('whose.me')}
                detail={t('whose.meA11y')}
                avatar={null}
                color={c.accent}
                on={sel.me}
                onToggle={() => setSelection(toggleMe(sel, everyone))}
                onOnly={() => pick(ONLY_MINE)}
                onlyLabel={t('whose.onlyMine')}
                testID="friends-person-me"
              />
            )}
            {shown.map((p) => (
              <PersonRow
                key={p.id}
                name={nameOf(p.id)}
                detail={t('friends.picker.places', { count: p.places })}
                avatar={p.avatar}
                color={colorOf(p.id)}
                on={isShown(sel, p.id)}
                onToggle={() => setSelection(toggleFriend(sel, p.id, everyone))}
                onOnly={() => pick(onlyFriend(p.id))}
                onlyLabel={t('whose.only', { name: nameOf(p.id) })}
                testID={`friends-person-${p.name}`}
              />
            ))}
          </ScrollView>
          <View style={{ alignItems: 'flex-end' }}>
            <Button label={t('friends.picker.done')} onPress={onClose} testID="friends-done" />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function PersonRow({ name, detail, avatar, color, on, onToggle, onOnly, onlyLabel, testID }: {
  name: string;
  detail: string;
  avatar: string | null;
  color: string;
  on: boolean;
  onToggle: () => void;
  onOnly: () => void;
  onlyLabel: string;
  testID: string;
}) {
  const c = useUiColors();
  const { t } = useI18n();
  return (
    <View style={styles.personRow}>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [styles.person, { backgroundColor: pressed ? c.surfaceAlt : 'transparent' }]}
        accessibilityRole="checkbox"
        aria-checked={on}
        accessibilityLabel={`${name}, ${detail}`}
        testID={testID}
      >
        <Avatar name={name} uri={avatar} color={color} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }} maxFontSizeMultiplier={2}>
            {name}
          </Text>
          <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2}>
            {detail}
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
      <Pressable
        onPress={onOnly}
        style={({ pressed }) => [styles.only, { borderColor: c.border, backgroundColor: pressed ? c.surfaceAlt : c.surface }]}
        accessibilityRole="button"
        accessibilityLabel={onlyLabel}
        testID={`${testID}-only`}
      >
        <Text style={{ color: c.accent, fontWeight: '600', fontSize: 13 }} maxFontSizeMultiplier={1.8}>
          {t('whose.onlyShort')}
        </Text>
      </Pressable>
    </View>
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
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  person: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 6, borderRadius: 10 },
  only: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 999, borderWidth: 1 },
  avatar: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  check: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  whose: { paddingTop: 2, paddingBottom: 4 },
  whoseHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, paddingHorizontal: 12 },
  whoseTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  whoseLabel: { fontSize: 13, fontWeight: '600' },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 4, paddingRight: 10, paddingVertical: 4, minHeight: 34, borderRadius: 999, borderWidth: 1.5, maxWidth: 180 },
  chipText: { fontSize: 14, flexShrink: 1 },
  pressed: { transform: [{ scale: 0.96 }] },
});
