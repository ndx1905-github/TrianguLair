/**
 * Report a list I follow (gap #6, spec "Store rules": "report a public list to its author and to the host";
 * "Moderation": no centralized moderation, a public list is published on its author's storage, under their
 * responsibility). There is no project server to send a report to: the screen explains who can act (the author, the
 * host of their storage), gives a report text to send them (the list's public address, never a link-only list's
 * key), hides the list here (unfollowed, and not offered again on this device), and offers to block the author.
 */
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button } from '../../components/ui';
import { useContacts } from '../../contacts/ContactsProvider';
import { Card, LinkActions, Strong } from '../../contacts/ui';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { authorLabel } from '../../lists/sharing';
import { BlockSection } from '../../privacy/BlockSection';
import { hostOf, reportTarget } from '../../privacy/blocked';
import { Muted, Section, StorageScreen } from '../../storage/components';
import { useSync } from '../../sync/SyncProvider';

function ReportScreen() {
  const { id: raw } = useLocalSearchParams<{ id: string }>();
  const id = decodeURIComponent(String(raw ?? ''));
  const { t } = useI18n();
  const c = useUiColors();
  const router = useRouter();
  const sync = useSync();
  const svc = useContacts();
  const ctl = sync.controller();
  const info = (ctl ? ctl.followedLists() : []).find((l) => l.id === id) ?? null;
  const [reason, setReason] = useState('');
  const [hidden, setHidden] = useState(false);
  if (!info) {
    return (
      <StorageScreen title={t('report.title')} testID="report-screen">
        <Muted testID="report-missing">{hidden ? t('report.hidden') : t('followed.notFollowed')}</Muted>
        <Button kind="secondary" label={t('followed.title')} onPress={() => router.replace('/lists/followed')} />
      </StorageScreen>
    );
  }
  const contactName = svc?.contact(info.owner)?.name || undefined;
  const author = authorLabel(t, { owner: info.owner, declared: info.author, contactName });
  const host = hostOf(info.location);
  // A link-only list is never pointed at by its key: the host gets the folder address only.
  const where = info.kind === 'public' ? reportTarget(info.location) : info.location;
  const text = t(info.kind === 'public' ? 'report.text.public' : 'report.text.link', { name: info.name, where, reason: reason.trim() || t('report.text.noReason') });

  return (
    <StorageScreen title={t('report.title')} testID="report-screen">
      <Strong>{info.name}</Strong>
      <Muted>{author}</Muted>
      <Banner>{t('report.lead')}</Banner>

      <Section title={t('report.reasonTitle')}>
        <TextInput
          value={reason}
          onChangeText={setReason}
          multiline
          style={{ borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 72, fontSize: 16, color: c.text, borderColor: c.border, backgroundColor: c.surface, textAlignVertical: 'top' }}
          accessibilityLabel={t('report.reasonLabel')}
          placeholder={t('report.reasonPlaceholder')}
          placeholderTextColor={c.textMuted}
          maxFontSizeMultiplier={2}
          testID="report-reason"
        />
      </Section>

      <Section title={t('report.whoTitle')}>
        <Card testID="report-author">
          <Strong>{t('report.authorTitle')}</Strong>
          <Muted>{contactName ? t('report.authorContact', { name: contactName }) : t('report.authorUnknown')}</Muted>
        </Card>
        <Card testID="report-host">
          <Strong>{t('report.hostTitle', { host: host || '?' })}</Strong>
          <Muted>{t('report.hostHelp', { host: host || '?' })}</Muted>
        </Card>
        <Muted>{t('report.textHelp')}</Muted>
        <LinkActions link={text} message={text} testID="report-text" />
        <Muted>{t('report.illegal')}</Muted>
      </Section>

      <Section title={t('report.hideTitle')}>
        <Muted>{t('report.hideHelp')}</Muted>
        <Button
          label={t('report.hide')}
          onPress={() =>
            void sync.hideReportedList({ id: info.id, name: info.name, owner: info.owner, location: info.location }).then(() => {
              setHidden(true);
              router.replace('/lists/followed');
            })
          }
          testID="report-hide"
        />
      </Section>

      <Section title={t('block.title')}>
        <View>
          <BlockSection owner={info.owner} name={contactName || info.author || t('report.theAuthor')} onBlocked={() => router.replace('/blocked')} />
        </View>
      </Section>
    </StorageScreen>
  );
}

export default function ReportRoute() {
  return (
    <DataGate>
      <ReportScreen />
    </DataGate>
  );
}
