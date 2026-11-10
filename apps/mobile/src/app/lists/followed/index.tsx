/**
 * "Followed lists" (T-212, spec "Following a list without following the person"): the lists I
 * follow by link, by author, each with its number of places, its date and, when it is gone, "This
 * list no longer exists" or "This link no longer works"; then the lists my friends shared with me
 * (T-211, "some lists"). Their places show on the map like friends' places.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import type { FollowedListInfo } from '@triangulair/sync';

import { DataGate } from '../../../components/DataGate';
import { Button } from '../../../components/ui';
import { useContacts } from '../../../contacts/ContactsProvider';
import { shortKey } from '../../../contacts/ui';
import { useData } from '../../../data/DataProvider';
import { useUiColors } from '../../../hooks/useUiColors';
import { useI18n } from '../../../i18n';
import { goneKey, groupByAuthor } from '../../../lists/sharing';
import { Muted, Section, StorageScreen } from '../../../storage/components';
import { useSync } from '../../../sync/SyncProvider';

function Row({ title, meta, warn, onPress, testID }: { title: string; meta: string; warn?: string; onPress: () => void; testID: string }) {
  const c = useUiColors();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, { borderColor: c.border, backgroundColor: pressed ? c.surfaceAlt : c.surface }]} accessibilityRole="button" testID={testID}>
      <Text style={[styles.icon, { color: warn ? c.warning : c.accent }]} maxFontSizeMultiplier={1.5}>
        {warn ? '⚠' : '☰'}
      </Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }} maxFontSizeMultiplier={2}>
          {title}
        </Text>
        <Text style={{ color: warn ? c.warning : c.textMuted, fontSize: 13, marginTop: 2 }} maxFontSizeMultiplier={2}>
          {warn ?? meta}
        </Text>
      </View>
    </Pressable>
  );
}

function FollowedScreen() {
  const { t, locale } = useI18n();
  const c = useUiColors();
  const router = useRouter();
  const sync = useSync();
  const svc = useContacts();
  const { repo } = useData();
  const ctl = sync.controller();
  void sync.snapshot; // redraw on every pass
  const followed = ctl ? ctl.followedLists() : [];
  const nameOf = (owner: string) => svc?.contact(owner)?.name || repo.getPerson(owner)?.displayName || undefined;
  const groups = groupByAuthor(followed, nameOf);
  const friendLists = ctl ? ctl.friendLists() : [];
  const date = (iso: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const meta = (l: FollowedListInfo) =>
    [t('filters.places', { count: l.count }), l.updated ? t('follow.updated', { date: date(l.updated) }) : null, l.kind === 'public' ? t('follow.kind.public') : null].filter(Boolean).join(' · ');

  return (
    <StorageScreen title={t('followed.title')} testID="followed-screen">
      <Section title={t('followed.byLink')}>
        {groups.length === 0 ? (
          <Muted testID="followed-none">{t('followed.none')}</Muted>
        ) : (
          groups.map((g) => (
            <View key={g.owner} style={{ gap: 8 }} testID={`followed-author-${g.name || shortKey(g.owner)}`}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.textMuted }} maxFontSizeMultiplier={2}>
                {g.name ? t('follow.by', { name: g.name }) : t('follow.byKey', { key: shortKey(g.owner) })}
              </Text>
              {g.lists.map((l) => (
                <Row
                  key={l.id}
                  title={l.name || t('sharing.unnamed')}
                  meta={meta(l)}
                  {...(l.gone && { warn: t(goneKey(l.gone)) })}
                  onPress={() => router.push(`/lists/followed/${encodeURIComponent(l.id)}` as Href)}
                  testID={`followed-${l.name}`}
                />
              ))}
            </View>
          ))
        )}
        <Button kind="secondary" label={t('follow.title')} onPress={() => router.push('/lists/follow')} testID="followed-follow" />
      </Section>

      <Section title={t('followed.fromFriends')}>
        {friendLists.length === 0 ? (
          <Muted testID="followed-friends-none">{t('followed.fromFriendsNone')}</Muted>
        ) : (
          friendLists.flatMap((f) =>
            f.lists.map((l) => (
              <Row
                key={`${f.owner} ${l.id}`}
                title={l.name}
                meta={[nameOf(f.owner) ? t('follow.by', { name: nameOf(f.owner)! }) : null, t('filters.places', { count: l.items.length })].filter(Boolean).join(' · ')}
                onPress={() => router.push({ pathname: '/lists/friend', params: { owner: f.owner, list: l.id } })}
                testID={`friend-list-${l.name}`}
              />
            )),
          )
        )}
      </Section>
    </StorageScreen>
  );
}

export default function FollowedRoute() {
  return (
    <DataGate>
      <FollowedScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  icon: { fontSize: 20, width: 26, textAlign: 'center' },
});
