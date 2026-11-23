/**
 * Comments (and friends' ratings) first: when a place opens, my comment and my friends' come right under its name, before
 * the opening hours, address and photos (what people want to read first). My comment is edited
 * further down (the save's fields); a friend's private comment never reaches me, and one they marked
 * private on their save is not shown. A friend's rating shows next to their name ("★ 4"), like
 * their status in the friends section: also for a friend who wrote no comment.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { isFollowId } from '@triangulair/sync';

import { useData } from '../data/DataProvider';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { RatingBadge } from './RatingStars';
import { useFriendColors } from '../sync/friendColors';
import { FriendDot } from '../sync/FriendsPicker';
import { friendSavesOf } from '../sync/FriendsSection';

export function CommentsSection({ placeId, myComment }: { placeId: string; myComment: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  const { repo, version } = useData();
  const colorOf = useFriendColors();
  const friends = useMemo(
    () =>
      friendSavesOf(repo.savesForPlace(placeId), repo.meId)
        .map((s) => ({ s, text: s.commentVisibility !== 'private' ? s.comment.trim() : '' }))
        .filter((x) => x.text || x.s.rating !== null),
    [repo, placeId, version],
  );
  const mine = myComment.trim();
  if (!mine && friends.length === 0) return null;
  const nameOf = (id: string) =>
    isFollowId(id) ? t('sharing.asSource', { name: repo.getPerson(id)?.displayName || t('sharing.unnamed') }) : repo.getPerson(id)?.displayName || t('card.aFriend');
  return (
    <View style={styles.root} testID="card-comments">
      {mine ? (
        <View style={[styles.quote, { borderColor: c.accent }]} testID="card-my-comment">
          <Text style={[styles.who, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {t('card.myComment')}
          </Text>
          <Text style={[styles.text, { color: c.text }]} maxFontSizeMultiplier={2}>
            {mine}
          </Text>
        </View>
      ) : null}
      {friends.map(({ s, text }) => (
        <View key={s.id} style={[styles.quote, { borderColor: colorOf(s.ownerId) }]} testID="card-friend-comment-top">
          <View style={styles.whoRow}>
            <FriendDot color={colorOf(s.ownerId)} size={8} />
            <Text style={[styles.who, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
              {nameOf(s.ownerId)}
            </Text>
            {s.rating !== null ? <RatingBadge value={s.rating} testID="card-friend-rating" /> : null}
          </View>
          {text ? (
            <Text style={[styles.text, { color: c.text }]} maxFontSizeMultiplier={2}>
              {text}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10, marginTop: 12 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, gap: 2 },
  whoRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  who: { fontSize: 13, fontWeight: '600' },
  text: { fontSize: 16, lineHeight: 22 },
});
