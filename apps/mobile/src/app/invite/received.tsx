/**
 * "I received an invitation" (spec "Invitation link and return link", steps 2–3): the link is
 * checked against the inviter's index (read only at the address in the link, and it must list the
 * link), the safety code is shown, I name the person, and the app makes the return link to send
 * back (copy / share / QR). Their places shared with friends show right away with the invitation
 * key; they choose what I see once they open my answer.
 */
import { useEffect, useReducer, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Button } from '../../components/ui';
import { useContacts } from '../../contacts/ContactsProvider';
import { shareMessage } from '../../contacts/links';
import { receiveReducer } from '../../contacts/model';
import { takePendingLink } from '../../contacts/pending';
import { linkProblemOf, type LinkProblem } from '../../contacts/problems';
import type { OpenedInvitation } from '../../contacts/service';
import { Card, LinkActions, NameField, PasteField, ProblemBanner, QrCode, SafetyCodeGrid, Strong, TrustBadge } from '../../contacts/ui';
import { ToggleRow } from '../../firstLaunch/ToggleRow';
import { useLayout } from '../../hooks/useLayout';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useReadyIdentity } from '../../identity/IdentityProvider';
import { Muted, Section, StorageScreen } from '../../storage/components';

function ReceivedScreen() {
  const { t } = useI18n();
  const c = useUiColors();
  const router = useRouter();
  const svc = useContacts();
  const me = useReadyIdentity();
  const { sizeClass } = useLayout();
  const [state, dispatch] = useReducer(receiveReducer, { step: 'idle' });
  const [text, setText] = useState('');
  const [opened, setOpened] = useState<OpenedInvitation | null>(null);
  const [name, setName] = useState('');
  const [shareBack, setShareBack] = useState(true);
  const [answerProblem, setAnswerProblem] = useState<LinkProblem | null>(null);
  const [faceToFace, setFaceToFace] = useState(false);

  const check = async (link: string, f2f: boolean) => {
    if (!svc) return;
    dispatch({ type: 'submit', link });
    try {
      const o = await svc.openInvitation(link, { faceToFace: f2f });
      setOpened(o);
      setName(o.name);
      dispatch({ type: 'checked', opened: { owner: o.owner, expires: o.expires, known: o.known } });
    } catch (e) {
      dispatch({ type: 'failed', problem: linkProblemOf(e) });
    }
  };

  // A link handed over by a deep link, the first launch or the face-to-face scanner.
  useEffect(() => {
    if (!svc || state.step !== 'idle') return;
    const p = takePendingLink();
    if (p) {
      setText(p.text);
      setFaceToFace(p.faceToFace);
      void check(p.text, p.faceToFace);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc]);

  const answer = async () => {
    if (!svc || !opened) return;
    dispatch({ type: 'answer' });
    setAnswerProblem(null);
    try {
      const r = await svc.answerInvitation(opened.token, { name, shareBack: shareBack && svc.canInvite() });
      dispatch({ type: 'answered', returnLink: r.link });
    } catch (e) {
      setAnswerProblem(linkProblemOf(e));
      dispatch({ type: 'failed', problem: linkProblemOf(e) });
    }
  };

  const shownName = name || t('contacts.someone');

  return (
    <StorageScreen title={t('received.title')} testID="received-screen">
      {(state.step === 'idle' || state.step === 'problem' || state.step === 'checking') && (
        <Section title={t('received.paste')}>
          <Muted>{t('received.lead')}</Muted>
          <PasteField label={t('received.linkLabel')} value={text} onChange={setText} onSubmit={() => void check(text, faceToFace)} action={t('received.open')} busy={state.step === 'checking'} disabled={!svc} testID="received" />
          {state.step === 'checking' && <Muted testID="received-checking">{t('received.checking')}</Muted>}
          {state.step === 'problem' && <ProblemBanner problem={state.problem} testID="received-problem" />}
        </Section>
      )}

      {(state.step === 'verified' || state.step === 'answering') && opened && (
        <Card testID="received-verified">
          <Strong>{t('received.verifiedTitle')}</Strong>
          <Muted>{opened.known ? t('received.known', { name: opened.name || t('contacts.someone') }) : t('received.verifiedLead')}</Muted>
          <NameField label={t('received.whoSent')} help={t('received.whoSentHelp')} value={name} onChange={setName} testID="received-name" />
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <Strong>{t('contacts.safetyTitle')}</Strong>
              <TrustBadge verified={opened.faceToFace} checkable testID="received-badge" />
            </View>
            <Muted>{opened.faceToFace ? t('received.faceToFace') : t('received.compareLater', { name: shownName })}</Muted>
            <SafetyCodeGrid groups={opened.safety} wide={sizeClass !== 'compact'} testID="received-code" />
          </View>
          {svc?.canInvite() ? (
            <ToggleRow label={t('received.shareBack', { name: shownName })} help={t('received.shareBackHelp')} value={shareBack} onChange={setShareBack} testID="received-share-back" />
          ) : (
            <Muted testID="received-no-storage">{t('received.noStorage')}</Muted>
          )}
          {answerProblem && <ProblemBanner problem={answerProblem} testID="received-answer-problem" />}
          <Button label={t('received.answer')} onPress={() => void answer()} disabled={state.step === 'answering'} testID="received-answer" />
          {state.step === 'answering' && <ActivityIndicator color={c.accent} />}
        </Card>
      )}

      {state.step === 'answered' && (
        <Card testID="received-answered">
          <Strong>{t('received.sendBack', { name: shownName })}</Strong>
          <Muted>{state.opened && faceToFace ? t('received.sendBackFace', { name: shownName }) : t('received.sendBackHelp', { name: shownName })}</Muted>
          <QrCode value={state.returnLink} ecc="L" size={280} testID="received-qr" label={t('received.qrLabel')} />
          <LinkActions link={state.returnLink} message={shareMessage(t('received.shareSentence', { name: me.profile.name }), state.returnLink)} testID="received-return" />
          <Muted>{t('received.meanwhile', { name: shownName })}</Muted>
          <Button kind="secondary" label={t('received.toMap')} onPress={() => router.replace('/')} testID="received-map" />
          <Button kind="secondary" label={t('contacts.open')} onPress={() => router.push('/contacts')} testID="received-contacts" />
        </Card>
      )}
    </StorageScreen>
  );
}

export default function ReceivedRoute() {
  return (
    <DataGate>
      <ReceivedScreen />
    </DataGate>
  );
}
