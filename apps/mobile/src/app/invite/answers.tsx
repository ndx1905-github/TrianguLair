/**
 * The answers to one invitation (spec "One answer per invitation", "Late answers"): every answer
 * with its warnings (several people, a second person after acceptance, opened after expiry, no
 * storage to check them against), the safety code to compare, then "Accept" → what they can see
 * (by default everything I share with friends) → re-encryption at the publication that follows.
 */
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button } from '../../components/ui';
import { useContacts } from '../../contacts/ContactsProvider';
import { DEFAULT_SCOPE, type AnswerRow, type ShareScope } from '../../contacts/model';
import { linkProblemOf, type LinkProblem } from '../../contacts/problems';
import type { AnswerDetail } from '../../contacts/service';
import { Card, NameField, ProblemBanner, SafetyCodeGrid, ShareChoice, Strong, TrustBadge, WarningBanner, shortKey } from '../../contacts/ui';
import { useData } from '../../data/DataProvider';
import { ToggleRow } from '../../firstLaunch/ToggleRow';
import { useLayout } from '../../hooks/useLayout';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { Muted, Section, StorageScreen } from '../../storage/components';

function AnswerCard({ row, detail, invitationId }: { row: AnswerRow; detail: AnswerDetail; invitationId: string }) {
  const { t, locale } = useI18n();
  const c = useUiColors();
  const svc = useContacts();
  const { repo } = useData();
  const { sizeClass } = useLayout();
  const faceToFace = svc?.faceToFaceOwner(invitationId) === row.owner;
  const [open, setOpen] = useState(false);
  const [showCode, setShowCode] = useState(faceToFace ? false : row.confirm);
  const [name, setName] = useState(detail.names[row.owner] ?? '');
  const [scope, setScope] = useState<ShareScope>(DEFAULT_SCOPE);
  const [follow, setFollow] = useState(row.location !== undefined);
  const [verified, setVerified] = useState(faceToFace);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LinkProblem | null>(null);
  const lists = repo.lists().map((l) => ({ id: l.id, name: l.name }));
  const label = name || detail.names[row.owner] || shortKey(row.owner);
  const testID = `answer-${row.owner.slice(8, 16)}`;

  const accept = async () => {
    if (!svc) return;
    setBusy(true);
    setProblem(null);
    try {
      await svc.acceptAnswer(invitationId, row.owner, { name: name || detail.names[row.owner] || '', share: scope, follow, verified });
      setOpen(false);
    } catch (e) {
      setProblem(linkProblemOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card testID={testID}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Strong>{row.accepted ? t('answers.acceptedTitle', { name: label }) : t('answers.requestTitle', { name: label })}</Strong>
        <TrustBadge verified={faceToFace || (detail.known[row.owner] && verified)} checkable={row.location !== undefined} testID={`${testID}-badge`} />
      </View>
      <Muted>{t('answers.received', { date: new Date(row.created).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })}</Muted>
      {faceToFace && <Muted testID={`${testID}-face`}>{t('answers.faceToFace')}</Muted>}
      {row.warnings.includes('after-expiry') && !row.accepted && <WarningBanner warning="after-expiry" name={label} testID={`${testID}-after-expiry`} />}
      {row.warnings.includes('uncheckable') && <Muted testID={`${testID}-uncheckable`}>{t('answers.uncheckable')}</Muted>}

      {showCode ? (
        <View style={{ gap: 6 }}>
          <Muted>{t('answers.compare', { name: label })}</Muted>
          <SafetyCodeGrid groups={detail.safety[row.owner] ?? []} wide={sizeClass !== 'compact'} testID={`${testID}-code`} />
        </View>
      ) : (
        <Button kind="secondary" label={t('answers.showCode')} onPress={() => setShowCode(true)} testID={`${testID}-show-code`} />
      )}

      {row.accepted ? null : open ? (
        <View style={{ gap: 10 }}>
          <NameField label={t('answers.name')} value={name} onChange={setName} testID={`${testID}-name`} />
          <Text style={{ color: c.text, fontSize: 15, fontWeight: '700' }} maxFontSizeMultiplier={2}>
            {t('answers.whatTheySee', { name: label })}
          </Text>
          <ShareChoice value={scope} onChange={setScope} lists={lists} testID={`${testID}-scope`} />
          <ToggleRow
            label={t('contacts.follow', { name: label })}
            help={row.location === undefined ? t('contacts.followNoStorage', { name: label }) : t('contacts.followHelp')}
            value={follow}
            onChange={setFollow}
            disabled={row.location === undefined}
            testID={`${testID}-follow`}
          />
          {!faceToFace && <ToggleRow label={t('contacts.compared')} help={t('contacts.comparedHelp')} value={verified} onChange={setVerified} testID={`${testID}-verified`} />}
          {row.confirm && <Banner tone="warning">{t('answers.confirmHelp', { name: label })}</Banner>}
          {problem && <ProblemBanner problem={problem} testID={`${testID}-problem`} />}
          <Button label={row.confirm ? t('answers.acceptAnyway') : t('answers.confirm')} onPress={() => void accept()} disabled={busy} testID={`${testID}-confirm`} />
          {busy && <Muted>{t('answers.publishing')}</Muted>}
        </View>
      ) : (
        <Button label={t('answers.accept')} onPress={() => setOpen(true)} testID={`${testID}-accept`} />
      )}
    </Card>
  );
}

function AnswersScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const svc = useContacts();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const detail = svc && typeof id === 'string' ? svc.answers(id) : null;
  const [removing, setRemoving] = useState(false);
  if (!detail || typeof id !== 'string') {
    return (
      <StorageScreen title={t('answers.title')} testID="answers-screen">
        <Muted testID="answers-missing">{t('answers.missing')}</Muted>
        <Button kind="secondary" label={t('inviting.title')} onPress={() => router.replace('/invite')} />
      </StorageScreen>
    );
  }
  const accepted = detail.invitation.accepted;
  const acceptedName = accepted ? detail.names[accepted] || shortKey(accepted) : '';
  return (
    <StorageScreen title={t('answers.title')} testID="answers-screen">
      <Section title={detail.invitation.name ? t('answers.for', { name: detail.invitation.name }) : t('answers.forUnnamed')}>
        {detail.warnings.map((w) => (
          <WarningBanner key={w} warning={w} name={w === 'late-after-accept' ? acceptedName : ''} />
        ))}
        {detail.warnings.includes('late-after-accept') && accepted && svc && (
          <Button
            kind="danger"
            label={t('answers.revokeFirst', { name: acceptedName })}
            onPress={() => {
              setRemoving(true);
              void svc.removeContact(accepted).finally(() => setRemoving(false));
            }}
            disabled={removing || !svc.contact(accepted)}
            testID="answers-revoke-first"
          />
        )}
        {detail.rejected > 0 && <Muted>{t('answers.rejected', { count: detail.rejected })}</Muted>}
        {detail.rows.map((r) => (
          <AnswerCard key={r.owner} row={r} detail={detail} invitationId={id} />
        ))}
      </Section>
      {accepted && (
        <Button kind="secondary" label={t('contacts.open')} onPress={() => router.push('/contacts')} testID="answers-contacts" />
      )}
    </StorageScreen>
  );
}

export default function AnswersRoute() {
  return (
    <DataGate>
      <AnswersScreen />
    </DataGate>
  );
}
