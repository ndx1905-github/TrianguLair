import { useEffect, useState } from 'react';
import { Redirect, useRouter } from 'expo-router';

import { Banner, Button } from '../../components/ui';
import { linkProblemOf, type LinkProblem } from '../../contacts/problems';
import { PasteField, ProblemBanner } from '../../contacts/ui';
import { checkInvitationText, type CheckedLink } from '../../contacts/verify';
import { Frame } from '../../firstLaunch/Frame';
import { useI18n } from '../../i18n';
import { useIdentity } from '../../identity/IdentityProvider';

/**
 * "I received an invitation link" (spec "Three entry points"): paste the link (it does not always
 * survive the installation) or come from it. It is checked against the inviter's index right away
 * (no key of mine is needed for that); then the first name, and the answer is made once my keys
 * exist (PendingInvitation opens it after the first launch).
 */
export default function InvitationEntry() {
  const { state, secrets } = useIdentity();
  const { t } = useI18n();
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LinkProblem | null>(null);
  const [ok, setOk] = useState<CheckedLink | null>(null);

  const check = async (value: string) => {
    setBusy(true);
    setProblem(null);
    setOk(null);
    try {
      const r = await checkInvitationText(value);
      await secrets?.set('pending-invitation', r.link);
      setOk(r);
    } catch (e) {
      setProblem(linkProblemOf(e));
    } finally {
      setBusy(false);
    }
  };

  // Came from the link itself (deep link): it is already waiting.
  useEffect(() => {
    if (!secrets) return;
    void secrets.get('pending-invitation').then((l) => {
      if (l) {
        setText(l);
        void check(l);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secrets]);

  if (state.kind === 'ready') return <Redirect href="/" />;
  return (
    <Frame
      title={t('invite.title')}
      lead={t('invite.lead')}
      testID="welcome-invitation-screen"
      actions={
        <>
          {ok ? <Button label={t('welcomeInvite.continue')} onPress={() => router.replace('/welcome/profile')} testID="invite-continue" /> : null}
          <Button kind="secondary" label={t('device.startInstead')} onPress={() => router.replace('/welcome/profile')} testID="invite-start" />
        </>
      }
    >
      <PasteField label={t('invite.link')} value={text} onChange={setText} onSubmit={() => void check(text)} action={t('invite.open')} busy={busy} testID="welcome-invite" />
      {problem && <ProblemBanner problem={problem} testID="welcome-invite-problem" />}
      {ok && <Banner testID="welcome-invite-ok">{t('welcomeInvite.ok')}</Banner>}
      <Frame.Note>{t('welcomeInvite.note')}</Frame.Note>
    </Frame>
  );
}
