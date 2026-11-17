/**
 * Settings › Devices › Add a device (spec "Adding a device", T-206), on a device that already has
 * my identity. QR code by default (both devices side by side), link + 6-word code from afar. The
 * new device's key is certified by the master key: one tap on the primary device, else the 12 words,
 * after the user typed the last 4 digits of the number the new device shows (devices review F-03).
 * Nothing is given before that; a refusal offers a key change.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button, Segmented } from '../../components/ui';
import { Scanner } from '../../contacts/Scanner';
import { Card, LinkActions, QrCode, Strong } from '../../contacts/ui';
import { LinkSender, QrSender, maskedFingerprint, type OldDeviceDeps, type PendingDevice } from '../../devices/sessions';
import { ErrorText, Fingerprint, WordsCode, WordsField, useMachine, usePoll } from '../../devices/ui';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useIdentity } from '../../identity/IdentityProvider';
import { CopyBlock, Field, MasterKeyPrompt, Muted, StorageScreen } from '../../storage/components';
import { useStorage } from '../../storage/StorageProvider';
import { StorageNeeded } from '../../storage/useStorageForSharing';
import type { MasterKeySource } from '../../storage/certify';
import { useSync } from '../../sync/SyncProvider';

function useDeps(): OldDeviceDeps | null {
  const identity = useIdentity();
  const storage = useStorage();
  const sync = useSync();
  const cfg = storage.state.current;
  const location = storage.access.readAddress();
  return useMemo(() => {
    const w = storage.access.writeAdapter();
    if (!cfg || cfg.kind === 'https' || !w || !location) return null;
    return {
      storage: w,
      location,
      sharing: () => identity.currentSharingKey(),
      certify: (pub, master) => identity.certifyDevice(pub, master),
      register: (cert, name) => sync.addDevice(cert, name),
      trackSlot: (slot, at) => sync.trackSlot(slot, at),
    };
    // A new transfer only when the storage changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, location]);
}

function Confirm({ device, error, busy, onApprove, onRefuse }: { device: PendingDevice; error?: string; busy: boolean; onApprove: (m: MasterKeySource, digits: string) => void; onRefuse: () => void }) {
  const { t } = useI18n();
  const [digits, setDigits] = useState('');
  const ok = /^\d{4}$/.test(digits.replace(/\s/g, ''));
  return (
    <Card testID="add-confirm">
      <Strong testID="add-confirm-name">{device.name ? t('add.confirm.title', { name: device.name }) : t('add.confirm.unnamed')}</Strong>
      <Muted>{t('add.confirm.fingerprint')}</Muted>
      <Fingerprint value={maskedFingerprint(device.fingerprint)} testID="add-fingerprint" />
      <Field label={t('add.confirm.digits')} value={digits} onChange={setDigits} keyboard="number" testID="add-digits" />
      {error === 'digits' && <ErrorText testID="add-digits-error">{t('add.error.digits')}</ErrorText>}
      <Muted>{t('add.master')}</Muted>
      {busy ? <ActivityIndicator /> : ok ? <MasterKeyPrompt onReady={(m) => onApprove(m, digits)} actionLabel={t('add.confirm.go')} testID="add-master" /> : null}
      {error && error !== 'digits' && <ErrorText>{t(`device.error.${error === 'master-key-needed' ? 'phrase-mismatch' : error}`)}</ErrorText>}
      <Button kind="secondary" label={t('add.confirm.refuse')} onPress={onRefuse} disabled={busy} testID="add-refuse" />
    </Card>
  );
}

/** Refused, or the digits differed: nothing was given; a key change revokes that device for good (F-03). */
function Refused({ device }: { device: PendingDevice }) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <View style={{ gap: 12 }}>
      <Banner tone="warning" testID="add-refused">{t('add.refused.title')}</Banner>
      <Muted>{t('add.refused.body')}</Muted>
      <Button
        kind="danger"
        label={t('add.refused.keyChange')}
        onPress={() => router.push(`/devices/lost?rogue=${encodeURIComponent(device.device)}&name=${encodeURIComponent(device.name)}` as Href)}
        testID="add-refused-key"
      />
      <Button kind="secondary" label={t('add.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/devices'))} testID="add-back" />
    </View>
  );
}

function Ended({ phase, name }: { phase: 'done' | 'expired' | 'cancelled' | 'failed'; name?: string }) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <View style={{ gap: 12 }}>
      <Banner tone={phase === 'done' ? 'info' : 'warning'} testID={`add-${phase}`}>
        {phase === 'done' ? t('add.done', { name: name ?? '' }) : t(`add.${phase}`)}
      </Banner>
      <Button label={t('add.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/devices'))} testID="add-back" />
    </View>
  );
}

function LinkWay({ deps }: { deps: OldDeviceDeps }) {
  const { t } = useI18n();
  const c = useUiColors();
  const [sender, setSender] = useState(() => new LinkSender(deps));
  const s = useMachine(sender)!;
  const [now, setNow] = useState(Date.now());
  const [reply, setReply] = useState('');
  const poll = useCallback(async () => {
    await sender.poll();
    setNow(Date.now());
  }, [sender]);
  usePoll(s.phase === 'waiting' || s.phase === 'request' || s.phase === 'sent', poll);
  // Leaving the screen before the end cancels the transfer (the link stops working).
  useEffect(
    () => () => {
      if (sender.state.phase !== 'idle') void sender.cancel();
    },
    [sender],
  );

  if (s.phase === 'idle') {
    return (
      <View style={{ gap: 12 }}>
        <Muted>{t('add.link.lead')}</Muted>
        <Button label={t('add.link.start')} onPress={() => void sender.start()} testID="add-link-start" />
      </View>
    );
  }
  if (s.phase === 'creating') return <ActivityIndicator color={c.accent} />;
  if (s.phase === 'refused') return <Refused device={s.device} />;
  if (s.phase === 'sent') {
    return (
      <View style={{ gap: 12 }}>
        <View style={styles.row}>
          <ActivityIndicator color={c.accent} />
          <Muted testID="add-sent">{t('add.sent', { name: s.name })}</Muted>
        </View>
        <Button kind="secondary" label={t('add.cancel')} onPress={() => void sender.cancel()} testID="add-cancel" />
      </View>
    );
  }
  if (s.phase === 'done' || s.phase === 'expired' || s.phase === 'cancelled' || s.phase === 'failed') {
    return (
      <>
        <Ended phase={s.phase} {...(s.phase === 'done' && { name: s.name })} />
        {s.phase !== 'done' && <Button kind="secondary" label={t('add.again')} onPress={() => setSender(new LinkSender(deps))} testID="add-again" />}
      </>
    );
  }
  const minutes = Math.max(1, Math.ceil((s.expiresAt - now) / 60_000));
  return (
    <View style={{ gap: 12 }}>
      <Muted>{t('add.link.lead')}</Muted>
      <LinkActions link={s.link} message={t('add.link.message', { link: s.link })} testID="add-link" />
      <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={2}>
        {t('add.link.code')}
      </Text>
      <WordsCode code={s.code} testID="add-code" />
      <Muted testID="add-expires">{t('add.link.expires', { count: minutes })}</Muted>
      {s.phase === 'waiting' ? (
        <>
          <WordsField label={t('add.link.reply')} value={reply} onChange={setReply} testID="add-link-reply" lines={3} error={s.error === 'bad-link'} />
          {s.error === 'bad-link' && <ErrorText testID="add-link-reply-error">{t('add.link.badReply')}</ErrorText>}
          <Button label={t('add.link.replyOpen')} onPress={() => sender.received(reply)} disabled={!reply.trim()} testID="add-link-reply-open" />
        </>
      ) : (
        <Confirm device={s.device} {...(s.phase === 'request' && s.error && { error: s.error })} busy={s.phase === 'approving'} onApprove={(m, d) => void sender.approve(m, d)} onRefuse={() => void sender.refuse()} />
      )}
      <Button kind="secondary" label={t('add.cancel')} onPress={() => void sender.cancel()} testID="add-cancel" />
    </View>
  );
}

function QrWay({ deps }: { deps: OldDeviceDeps }) {
  const { t } = useI18n();
  const [sender, setSender] = useState(() => new QrSender(deps));
  const s = useMachine(sender)!;
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  usePoll(s.phase === 'showing', useCallback(() => sender.poll(), [sender]));
  const scanned = (v: string) => {
    try {
      sender.scanned(v);
      setBad(false);
    } catch {
      setBad(true);
    }
  };
  if (s.phase === 'done' || s.phase === 'expired' || s.phase === 'cancelled' || s.phase === 'failed') {
    return (
      <>
        <Ended phase={s.phase} {...(s.phase === 'done' && { name: s.name })} />
        {s.phase !== 'done' && <Button kind="secondary" label={t('add.again')} onPress={() => setSender(new QrSender(deps))} testID="add-again" />}
      </>
    );
  }
  if (s.phase === 'idle') {
    return (
      <View style={{ gap: 12 }}>
        <Muted>{t('add.qr.lead')}</Muted>
        <Scanner onScanned={scanned} testID="add-qr-scan" />
        <WordsField label={t('add.qr.paste')} value={text} onChange={setText} testID="add-qr-input" lines={2} error={bad} />
        {bad && <ErrorText>{t('device.error.bad-code')}</ErrorText>}
        <Button label={t('add.qr.open')} onPress={() => scanned(text)} disabled={!text.trim()} testID="add-qr-open" />
      </View>
    );
  }
  if (s.phase === 'refused') return <Refused device={s.device} />;
  if (s.phase === 'confirm' || s.phase === 'approving') {
    return <Confirm device={s.device} {...(s.phase === 'confirm' && s.error && { error: s.error })} busy={s.phase === 'approving'} onApprove={(m, d) => void sender.approve(m, d)} onRefuse={() => sender.refuse()} />;
  }
  return (
    <View style={{ gap: 12 }} testID="add-qr-showing">
      <Strong>{t('add.qr.answer')}</Strong>
      <QrCode value={s.reply} label={t('add.qr.answerLabel')} testID="add-qr-reply" />
      <CopyBlock text={s.reply} testID="add-qr-reply-text" />
      <Button kind="secondary" label={t('add.cancel')} onPress={() => void sender.cancel()} testID="add-cancel" />
    </View>
  );
}

function AddScreen() {
  const { t } = useI18n();
  const deps = useDeps();
  const [way, setWay] = useState<'qr' | 'link'>('qr');
  return (
    <StorageScreen title={t('add.deviceTitle')} testID="add-screen">
      <Muted>{t('add.lead')}</Muted>
      {!deps ? (
        <StorageNeeded reason="devices" returnTo="/devices/add" />
      ) : (
        <>
          <Segmented
            options={[
              { value: 'qr' as const, label: t('add.way.qr') },
              { value: 'link' as const, label: t('add.way.link') },
            ]}
            value={way}
            onChange={setWay}
            testID="add-way"
          />
          {way === 'qr' ? <QrWay key="qr" deps={deps} /> : <LinkWay key="link" deps={deps} />}
        </>
      )}
    </StorageScreen>
  );
}

export default function AddDeviceRoute() {
  return (
    <DataGate>
      <AddScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
});
