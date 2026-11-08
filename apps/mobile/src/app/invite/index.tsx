/**
 * "Invite a friend" (T-208, spec "Invitation link and return link", "Later, at the right moment"):
 * needs a storage (its index vouches for the link), creates the short link and its QR code after
 * publishing the index that lists it, share sheet / copy; the pending invitations with their expiry
 * and a cancel button; a field to paste the return link a friend sent back.
 */
import { useEffect, useReducer, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button } from '../../components/ui';
import { useContacts } from '../../contacts/ContactsProvider';
import { findLink, shareMessage } from '../../contacts/links';
import { takePendingLink } from '../../contacts/pending';
import { daysLeft, inviteReducer, isPending, needsAttention, type InvitationPhase } from '../../contacts/model';
import { linkProblemOf, type LinkProblem } from '../../contacts/problems';
import type { InvitationView } from '../../contacts/service';
import { Card, LinkActions, NameField, PasteField, ProblemBanner, QrCode, Strong } from '../../contacts/ui';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useReadyIdentity } from '../../identity/IdentityProvider';
import { Muted, Section, StorageScreen } from '../../storage/components';
import { StorageNeeded, useStorageForSharing } from '../../storage/useStorageForSharing';

function phaseText(t: (k: string, p?: Record<string, string | number>) => string, i: InvitationView, now: number): string {
  const p: InvitationPhase = i.phase;
  if (p === 'waiting') {
    const days = daysLeft(i.expires, now);
    return t('inviting.phase.waiting', { days, count: days });
  }
  return t(`inviting.phase.${p}`, { count: i.responders });
}

function PendingRow({ i, onCancel, busy }: { i: InvitationView; onCancel: () => void; busy: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const c = useUiColors();
  const now = Date.now();
  return (
    <Card testID={`invitation-${i.id}`}>
      <Strong>{i.name || t('inviting.unnamed', { date: new Date(i.created).toLocaleDateString(locale, { month: 'long', day: 'numeric' }) })}</Strong>
      <Text style={{ color: needsAttention(i.phase) ? c.warning : c.textMuted, fontSize: 14, fontWeight: needsAttention(i.phase) ? '700' : '400' }} maxFontSizeMultiplier={2} testID={`invitation-${i.id}-phase`}>
        {phaseText(t, i, now)}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {i.responders > 0 && <Button label={t('inviting.seeAnswers')} onPress={() => router.push(`/invite/answers?id=${encodeURIComponent(i.id)}` as Href)} testID={`invitation-${i.id}-answers`} />}
        {i.phase === 'cancelled' || i.phase === 'expired' ? null : <Button kind="secondary" label={t('inviting.cancel')} onPress={onCancel} disabled={busy} testID={`invitation-${i.id}-cancel`} />}
      </View>
    </Card>
  );
}

function InviteScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const svc = useContacts();
  const me = useReadyIdentity();
  const sharing = useStorageForSharing();
  const [name, setName] = useState('');
  const [state, dispatch] = useReducer(inviteReducer, { step: 'idle' });
  const [answer, setAnswer] = useState('');
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerProblem, setAnswerProblem] = useState<LinkProblem | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  // A return link that could not be opened from a deep link: shown in the field.
  useEffect(() => {
    const p = takePendingLink();
    if (p && findLink(p.text)?.kind === 'return') setAnswer(p.text);
  }, []);

  const create = async () => {
    if (!svc || !sharing.ensure('invite', '/invite')) return;
    dispatch({ type: 'create' });
    try {
      const r = await svc.createInvitation({ name });
      dispatch({ type: 'created', ...r });
    } catch (e) {
      dispatch({ type: 'failed', problem: linkProblemOf(e) });
    }
  };

  const openAnswer = async () => {
    if (!svc) return;
    setAnswerBusy(true);
    setAnswerProblem(null);
    try {
      const r = await svc.receiveAnswer(answer);
      setAnswer('');
      router.push(`/invite/answers?id=${encodeURIComponent(r.invitationId)}` as Href);
    } catch (e) {
      setAnswerProblem(linkProblemOf(e));
    } finally {
      setAnswerBusy(false);
    }
  };

  const cancel = async (id: string) => {
    if (!svc) return;
    setCancelling(id);
    try {
      await svc.cancelInvitation(id);
    } catch {
      // Withdrawn locally; published at the next sync.
    } finally {
      setCancelling(null);
    }
  };

  const pending = svc ? svc.invitations().filter((i) => isPending(i.phase)) : [];
  const myName = me.profile.name;

  return (
    <StorageScreen title={t('inviting.title')} testID="invite-screen">
      <Section title={t('inviting.new')}>
        {sharing.loaded && !sharing.connected ? (
          <StorageNeeded reason="invite" returnTo="/invite" />
        ) : state.step === 'ready' ? (
          <Card testID="invite-ready">
            <Strong>{t('inviting.readyTitle')}</Strong>
            <QrCode value={state.link} testID="invite-qr" label={t('inviting.qrLabel')} />
            <LinkActions link={state.link} message={shareMessage(t('inviting.shareSentence', { name: myName }), state.link)} testID="invite" />
            <Muted>{t('inviting.readyHelp', { days: daysLeft(state.expires, Date.now()) })}</Muted>
            <Button kind="secondary" label={t('inviting.another')} onPress={() => { setName(''); dispatch({ type: 'reset' }); }} testID="invite-another" />
          </Card>
        ) : (
          <>
            <Muted>{t('inviting.lead')}</Muted>
            <NameField label={t('inviting.forWhom')} help={t('inviting.forWhomHelp')} value={name} onChange={setName} testID="invite-name" />
            {state.step === 'problem' && <ProblemBanner problem={state.problem} testID="invite-problem" />}
            {state.step === 'creating' && <Banner testID="invite-creating">{t('inviting.creating')}</Banner>}
            <Button label={t('inviting.create')} onPress={() => void create()} disabled={!svc || state.step === 'creating'} testID="invite-create" />
          </>
        )}
      </Section>

      <Section title={t('inviting.answerTitle')}>
        <Muted>{t('inviting.answerHelp')}</Muted>
        <PasteField label={t('inviting.answerLabel')} value={answer} onChange={setAnswer} onSubmit={() => void openAnswer()} action={t('inviting.answerOpen')} busy={answerBusy} disabled={!svc} testID="answer" />
        {answerProblem && <ProblemBanner problem={answerProblem} testID="answer-problem" />}
      </Section>

      <Section title={t('inviting.pending')}>
        {pending.length === 0 ? (
          <Muted testID="invite-none">{t('inviting.noneOpen')}</Muted>
        ) : (
          pending.map((i) => <PendingRow key={i.id} i={i} busy={cancelling === i.id} onCancel={() => void cancel(i.id)} />)
        )}
      </Section>

      <Section title={t('inviting.more')}>
        <Button kind="secondary" label={t('face.open')} onPress={() => router.push('/invite/face')} testID="invite-face" />
        <Button kind="secondary" label={t('contacts.open')} onPress={() => router.push('/contacts')} testID="invite-contacts" />
      </Section>
    </StorageScreen>
  );
}

export default function InviteRoute() {
  return (
    <DataGate>
      <InviteScreen />
    </DataGate>
  );
}
