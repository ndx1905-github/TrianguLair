/**
 * Face to face (spec: "an exchange of QR codes replaces the two links … and the contact is marked
 * as verified automatically"). The compact face-to-face format is not specified yet (crypto
 * THREATS.md, R-13), so this screen exchanges the existing structures, unchanged, as QR codes:
 *
 *   1. one person shows an invitation QR code (the short link, created and listed as usual);
 *   2. the other scans it, the link is checked against the inviter's index, and their answer is
 *      shown as a QR code (the full return link, ~600 characters, QR version ≤ 20 at level L);
 *   3. the first person scans that answer and accepts it.
 *
 * Both sides read the other's key from a screen held in front of them, so each marks the other
 * as verified. It still goes through an invitation key and the inviter's storage (one more
 * publication than a dedicated format would need); a later format can replace steps 1–3.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button, Segmented } from '../../components/ui';
import { useContacts } from '../../contacts/ContactsProvider';
import { findLink } from '../../contacts/links';
import { setPendingLink } from '../../contacts/pending';
import { linkProblemOf, type LinkProblem } from '../../contacts/problems';
import { Scanner } from '../../contacts/Scanner';
import { Card, PasteField, ProblemBanner, QrCode, Strong } from '../../contacts/ui';
import { useI18n } from '../../i18n';
import { Muted, Section, StorageScreen } from '../../storage/components';
import { StorageNeeded, useStorageForSharing } from '../../storage/useStorageForSharing';

type Mode = 'show' | 'scan';

function FaceScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const svc = useContacts();
  const sharing = useStorageForSharing();
  const [mode, setMode] = useState<Mode>('show');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LinkProblem | null>(null);
  const [text, setText] = useState('');

  const show = async () => {
    if (!svc) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await svc.createInvitation({ faceToFace: true });
      setLink(r.link);
    } catch (e) {
      setProblem(linkProblemOf(e));
    } finally {
      setBusy(false);
    }
  };

  /** A scanned or pasted code: their invitation (I answer) or their answer (I accept). */
  const handle = async (scanned: string) => {
    if (!svc) return;
    setProblem(null);
    const f = findLink(scanned);
    if (f?.kind === 'invitation') {
      setPendingLink(f.link, true);
      router.push('/invite/received');
      return;
    }
    if (f?.kind === 'return') {
      setBusy(true);
      try {
        const r = await svc.receiveAnswer(f.link, { faceToFace: true });
        router.push(`/invite/answers?id=${encodeURIComponent(r.invitationId)}` as Href);
      } catch (e) {
        setProblem(linkProblemOf(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    setProblem(f ? 'wrong-kind' : 'malformed');
  };

  return (
    <StorageScreen title={t('face.title')} testID="face-screen">
      <Muted>{t('face.lead')}</Muted>
      <Segmented
        options={[
          { value: 'show', label: t('face.show') },
          { value: 'scan', label: t('face.scan') },
        ]}
        value={mode}
        onChange={setMode}
        testID="face-mode"
      />
      {mode === 'show' ? (
        <Section title={t('face.showTitle')}>
          {sharing.loaded && !sharing.connected ? (
            <>
              <StorageNeeded reason="invite" returnTo="/invite/face" />
              <Muted>{t('face.noStorage')}</Muted>
            </>
          ) : link ? (
            <Card testID="face-code">
              <Strong>{t('face.step1')}</Strong>
              <QrCode value={link} size={280} testID="face-qr" label={t('inviting.qrLabel')} />
              <Muted>{t('face.step2')}</Muted>
              <Button label={t('face.scanAnswer')} onPress={() => setMode('scan')} testID="face-scan-answer" />
            </Card>
          ) : (
            <Button label={t('face.create')} onPress={() => void show()} disabled={busy || !svc} testID="face-create" />
          )}
        </Section>
      ) : (
        <Section title={t('face.scanTitle')}>
          <Muted>{t('face.scanHelp')}</Muted>
          <Scanner onScanned={(s) => void handle(s)} testID="face-scanner" />
          <PasteField label={t('face.pasteLabel')} value={text} onChange={setText} onSubmit={() => void handle(text)} action={t('face.pasteOpen')} busy={busy} disabled={!svc} testID="face-paste" />
        </Section>
      )}
      {problem && <ProblemBanner problem={problem} testID="face-problem" />}
      <View style={{ gap: 6 }}>
        <Banner>{t('face.note')}</Banner>
      </View>
    </StorageScreen>
  );
}

export default function FaceRoute() {
  return (
    <DataGate>
      <FaceScreen />
    </DataGate>
  );
}
