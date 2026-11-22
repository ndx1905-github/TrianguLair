/**
 * Friends and access (T-209, spec "Asymmetric relationships"): every contact with what goes each
 * way and their verified badge, the key-change notices ("Marie changed her key"), and the ways to
 * add someone (invite by link, face to face, open a link received) or to follow a list by link.
 * Reached from the map's "Friends" button and Settings. With nobody yet, it explains how to invite
 * and puts "Invite a friend" first; the example friend (src/data/demo.ts), when there, has a card
 * of its own with "See their places".
 */
import { useEffect, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button } from '../../components/ui';
import { useContacts } from '../../contacts/ContactsProvider';
import type { ContactView } from '../../contacts/service';
import { Card, Strong, TrustBadge, shortKey } from '../../contacts/ui';
import { useShowFriendPlaces } from '../../contacts/useShowFriendPlaces';
import { useData } from '../../data/DataProvider';
import { DEMO_FRIEND } from '../../data/demo';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { Muted, Section, StorageScreen } from '../../storage/components';

function summary(t: (k: string, p?: Record<string, string | number>) => string, c: ContactView): string {
  const see = c.follow ? t('contacts.summary.iSee') : t('contacts.summary.iDontSee');
  const they = t(`contacts.summary.they.${c.share.kind}`, { count: c.share.kind === 'lists' ? c.share.lists.length : 0 });
  return `${see} · ${they}`;
}

function ContactRow({ c }: { c: ContactView }) {
  const { t } = useI18n();
  const ui = useUiColors();
  const router = useRouter();
  const name = c.name || shortKey(c.owner);
  return (
    <Pressable
      onPress={() => router.push(`/contacts/${encodeURIComponent(c.owner)}` as Href)}
      style={({ pressed }) => [{ borderWidth: 1, borderRadius: 14, padding: 14, gap: 6, borderColor: ui.border, backgroundColor: ui.surface, opacity: pressed ? 0.85 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={name}
      testID={`contact-${c.owner.slice(8, 16)}`}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Strong>{name}</Strong>
        <TrustBadge verified={c.verified} checkable={c.checkable} />
      </View>
      <Text style={{ color: ui.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2}>
        {summary(t, c)}
      </Text>
    </Pressable>
  );
}

function ContactsScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const svc = useContacts();
  useEffect(() => svc?.refresh(), [svc]);
  const contacts = svc?.contacts() ?? [];
  const notices = svc?.notices() ?? [];
  const nameOf = (owner: string) => svc?.contact(owner)?.name || shortKey(owner);
  const { repo, version } = useData();
  const showPlaces = useShowFriendPlaces();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const example = useMemo(() => repo.getPerson(DEMO_FRIEND.id), [repo, version]);
  return (
    <StorageScreen title={t('contacts.title')} testID="contacts-screen">
      {notices.map((n) => (
        <View key={`${n.owner}-${n.kind}`} style={{ gap: 6 }} testID={`notice-${n.kind}`}>
          <Banner tone={n.kind === 'identity-moved' ? 'warning' : 'info'}>{t(`contacts.notice.${n.kind}`, { name: nameOf(n.owner) })}</Banner>
          <View style={{ alignSelf: 'flex-start' }}>
            <Button kind="secondary" label={t('contacts.notice.ok')} onPress={() => svc?.dismissNotice(n.owner)} testID={`notice-${n.kind}-ok`} />
          </View>
        </View>
      ))}
      <Section title={t('contacts.people')}>
        {contacts.length === 0 ? (
          <>
            <Muted testID="contacts-empty">{t('contacts.empty')}</Muted>
            <Button label={t('inviting.title')} onPress={() => router.push('/invite')} testID="contacts-empty-invite" />
          </>
        ) : (
          contacts.map((c) => <ContactRow key={c.owner} c={c} />)
        )}
        {example && (
          <Card testID="contact-example">
            <Strong>{example.displayName}</Strong>
            <Muted>{t('contacts.example', { name: example.displayName })}</Muted>
            <Button kind="secondary" label={t('contacts.seePlaces')} onPress={() => showPlaces(example.id)} testID="contact-example-see-places" />
          </Card>
        )}
        <Muted>{t('contacts.friendsMeaning')}</Muted>
      </Section>
      <Section title={t('contacts.add')}>
        <Button label={t('inviting.title')} onPress={() => router.push('/invite')} testID="contacts-invite" />
        <Button kind="secondary" label={t('face.open')} onPress={() => router.push('/invite/face')} testID="contacts-face" />
        <Button kind="secondary" label={t('received.title')} onPress={() => router.push('/invite/received')} testID="contacts-received" />
        <Button kind="secondary" label={t('follow.title')} onPress={() => router.push('/lists/follow')} testID="contacts-follow-list" />
      </Section>
    </StorageScreen>
  );
}

export default function ContactsRoute() {
  return (
    <DataGate>
      <ContactsScreen />
    </DataGate>
  );
}
