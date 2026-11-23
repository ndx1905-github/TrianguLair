/**
 * "3 friends" on the place card (spec "Friends' places"): the mention with their names, which opens
 * who saved it, when, their status, their tags in their author's color and their comments, within
 * what each has made visible (a private comment never reaches me; one marked private on a save
 * received anyway is not shown).
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SaveRecord } from '@triangulair/data';
import { isFollowId } from '@triangulair/sync';

import { Pill } from '../components/ui';
import { useData } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { UNTAGGED_COLOR } from '../theme/tags';
import { useFriendColors } from './friendColors';
import { onlyFriend, setSelection } from './friendsSelection';
import { Avatar, FriendDot } from './FriendsPicker';

/** "Léa", "Léa and Sam", "Léa, Sam and 2 others". */
export function namesPreview(names: readonly string[], t: (k: string, p?: Record<string, string | number>) => string): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return t('friends.names2', { a: names[0]!, b: names[1]! });
  return t('friends.namesMore', { names: names.slice(0, 2).join(', '), count: names.length - 2 });
}

export function friendSavesOf(saves: readonly SaveRecord[], meId: string): SaveRecord[] {
  return saves
    .filter((s) => s.ownerId !== meId && s.deletedAt === null && s.sharing !== 'private')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function FriendsSection({ placeId, initiallyOpen = false }: { placeId: string; initiallyOpen?: boolean }) {
  const c = useUiColors();
  const { t, locale } = useI18n();
  const { repo, version } = useData();
  const [open, setOpen] = useState(initiallyOpen);
  const colorOf = useFriendColors();
  const saves = useMemo(() => friendSavesOf(repo.savesForPlace(placeId), repo.meId), [repo, placeId, version]);
  const tags = useMemo(() => {
    const m = new Map<string, { name: string; color: string | null }[]>();
    for (const r of repo.friendTags()) {
      if (r.placeId !== placeId) continue;
      const list = m.get(r.personId) ?? [];
      list.push({ name: r.name, color: r.color });
      m.set(r.personId, list);
    }
    return m;
  }, [repo, placeId, version]);
  if (saves.length === 0) return null;
  // A list followed by link (T-212) owns its places in my cache: named after the list.
  const nameOf = (id: string) => (isFollowId(id) ? t('sharing.asSource', { name: repo.getPerson(id)?.displayName || t('sharing.unnamed') }) : repo.getPerson(id)?.displayName || t('card.aFriend'));
  const names = saves.map((s) => nameOf(s.ownerId));
  const date = (ms: number) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));

  // "On the maps of: Ben, Léa": one name per person (by name), each in their colour; a tap shows
  // only that person's places.
  const owners = [...new Set(saves.map((s) => s.ownerId))].sort((a, b) => nameOf(a).localeCompare(nameOf(b), locale));

  return (
    <>
    <View style={styles.onMaps} testID="card-on-maps">
      <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {t('card.onMapsOf')}
      </Text>
      {owners.map((id, i) => (
        <Pressable
          key={id}
          onPress={() => setSelection(onlyFriend(id))}
          style={({ pressed }) => [styles.onMapsName, pressed && { opacity: 0.7 }]}
          accessibilityRole="button"
          accessibilityLabel={t('card.onlyTheirs', { name: nameOf(id) })}
          hitSlop={6}
          testID={`card-on-map-${repo.getPerson(id)?.displayName ?? id}`}
        >
          <FriendDot color={colorOf(id)} />
          <Text style={{ color: c.accent, fontSize: 14, fontWeight: '600' }} maxFontSizeMultiplier={2}>
            {nameOf(id)}
            {i < owners.length - 1 ? ',' : ''}
          </Text>
        </Pressable>
      ))}
    </View>
    <View style={[styles.box, { borderColor: c.border, backgroundColor: c.surfaceAlt }]} testID="card-friends">
      <Pressable
        onPress={() => setOpen(!open)}
        style={styles.head}
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityLabel={`${t('friends.mention', { count: saves.length })}: ${namesPreview(names, t)}. ${open ? t('friends.hide') : t('friends.show')}`}
        testID="card-friends-toggle"
      >
        <View style={styles.faces}>
          {saves.slice(0, 3).map((s, i) => (
            <View key={s.id} style={{ marginLeft: i === 0 ? 0 : -8 }}>
              <Avatar name={nameOf(s.ownerId)} uri={repo.getPerson(s.ownerId)?.avatar ?? null} size={28} color={colorOf(s.ownerId)} />
            </View>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.count, { color: c.text }]} maxFontSizeMultiplier={2} testID="card-friends-count">
            {t('friends.mention', { count: saves.length })}
          </Text>
          <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2} numberOfLines={open ? undefined : 1}>
            {namesPreview(names, t)}
          </Text>
        </View>
        <Text style={{ color: c.accent, fontWeight: '600' }} maxFontSizeMultiplier={2}>
          {open ? t('friends.hide') : t('friends.show')}
        </Text>
      </Pressable>
      {open &&
        saves.map((s) => {
          const theirTags = tags.get(s.ownerId) ?? [];
          const comment = s.commentVisibility !== 'private' ? s.comment.trim() : '';
          return (
            <View key={s.id} style={[styles.friend, { borderColor: c.border }]} testID={`card-friend-${nameOf(s.ownerId)}`}>
              <View style={styles.friendHead}>
                <Avatar name={nameOf(s.ownerId)} uri={repo.getPerson(s.ownerId)?.avatar ?? null} color={colorOf(s.ownerId)} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.text, fontWeight: '700', fontSize: 15 }} maxFontSizeMultiplier={2}>
                    {nameOf(s.ownerId)}
                  </Text>
                  <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2}>
                    {[
                      t('friends.savedOn', { date: date(s.createdAt) }),
                      s.updatedAt - s.createdAt > 60_000 ? t('friends.updatedOn', { date: date(s.updatedAt) }) : null,
                      s.status ? t(`status.${s.status}`) : null,
                      s.rating !== null ? `★ ${s.rating}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
              </View>
              {comment ? (
                <Text style={[styles.comment, { color: c.text }]} maxFontSizeMultiplier={2} testID="card-friend-comment">
                  “{comment}”
                </Text>
              ) : null}
              {theirTags.length > 0 && (
                <View style={styles.tags} accessibilityLabel={t('friends.theirTags')}>
                  {theirTags.map((tag) => (
                    <Pill key={tag.name} label={tag.name} color={tag.color ?? UNTAGGED_COLOR} />
                  ))}
                </View>
              )}
            </View>
          );
        })}
    </View>
    </>
  );
}

const styles = StyleSheet.create({
  onMaps: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4, marginTop: 14 },
  onMapsName: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 32 },
  box: { marginTop: 10, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  faces: { flexDirection: 'row' },
  count: { fontSize: 16, fontWeight: '700' },
  friend: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 6 },
  friendHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  comment: { fontSize: 15, fontStyle: 'italic' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
