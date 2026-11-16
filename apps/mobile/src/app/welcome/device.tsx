import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { ready } from '@triangulair/crypto';
import { HttpsReadOnlyAdapter } from '@triangulair/storage';

import { Banner, Button, Segmented } from '../../components/ui';
import { LinkActions, QrCode } from '../../contacts/ui';
import { Scanner } from '../../contacts/Scanner';
import { defaultDeviceName } from '../../devices/local';
import { LinkReceiver, QrReceiver, RestoreFailed, restoreWithPhrase, type Joined, type NewDeviceDeps } from '../../devices/sessions';
import { ErrorText, Fingerprint, WordsField, useMachine, usePoll } from '../../devices/ui';
import { Frame } from '../../firstLaunch/Frame';
import { ToggleRow } from '../../firstLaunch/ToggleRow';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useIdentity } from '../../identity/IdentityProvider';
import { writeAdapter } from '../../storage/adapters';
import { ChoiceCard, Field } from '../../storage/components';

type Way = 'qr' | 'link' | 'phrase';

const deps: NewDeviceDeps = {
  readAdapter: (location) => new HttpsReadOnlyAdapter({ baseUrl: location }),
  writeAdapter: (config) => writeAdapter(config),
};

/**
 * "I already have TrianguLair on another device" (spec "Adding a device", T-206): the three ways,
 * from the safest. The new device makes its own keys; the other device (or the 12 words) certifies
 * them; the sharing key, the vault data key and the storage access come with it; then it syncs.
 */
export default function DeviceEntry() {
  const { state, adoptJoined } = useIdentity();
  const { t } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{ way?: string }>();
  const initial = params.way === 'qr' || params.way === 'link' || params.way === 'phrase' ? params.way : null;
  const [way, setWay] = useState<Way | null>(initial);
  const [name, setName] = useState(defaultDeviceName());
  const [joining, setJoining] = useState(false);

  const join = useCallback(
    async (j: Joined) => {
      setJoining(true);
      try {
        await adoptJoined(j, { deviceName: name.trim() || defaultDeviceName(), profileName: j.profileName });
        router.replace('/');
      } catch (e) {
        console.error('Could not store the new device', e);
        setJoining(false);
      }
    },
    [adoptJoined, name, router],
  );

  if (state.kind === 'ready') return <Redirect href="/" />;
  const back = () => (way && !initial ? setWay(null) : router.canGoBack() ? router.back() : router.replace('/welcome'));

  return (
    <Frame
      title={t('device.title')}
      lead={t('device.lead')}
      testID="welcome-device-screen"
      actions={
        <>
          {!way && <Button label={t('device.startInstead')} onPress={() => router.replace('/welcome/profile')} testID="device-start" />}
          <Button kind="secondary" label={t('common.back')} onPress={back} testID="device-back" />
        </>
      }
    >
      {joining ? (
        <ActivityIndicator />
      ) : !way ? (
        <>
          <ChoiceCard title={t('device.qr')} help={t('device.qrHelp')} onPress={() => setWay('qr')} testID="device-qr" />
          <ChoiceCard title={t('device.link')} help={t('device.linkHelp')} onPress={() => setWay('link')} testID="device-link" />
          <ChoiceCard title={t('device.phrase')} help={t('device.phraseHelp')} onPress={() => setWay('phrase')} testID="device-phrase" />
        </>
      ) : (
        <>
          <Segmented
            options={[
              { value: 'qr' as const, label: t('add.way.qr') },
              { value: 'link' as const, label: t('add.way.link') },
              { value: 'phrase' as const, label: t('device.phrase.go') },
            ]}
            value={way}
            onChange={setWay}
            testID="device-way"
          />
          <Field label={t('device.name')} value={name} onChange={setName} help={t('device.nameHelp')} testID="device-name" />
          {way === 'qr' && <QrWay name={name} onJoined={join} />}
          {way === 'link' && <LinkWay name={name} onJoined={join} />}
          {way === 'phrase' && <PhraseWay onJoined={join} />}
        </>
      )}
    </Frame>
  );
}

function useCryptoReady(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    void ready().then(() => setOk(true));
  }, []);
  return ok;
}

function LinkWay({ name, onJoined }: { name: string; onJoined: (j: Joined) => void }) {
  const { t } = useI18n();
  const c = useUiColors();
  const cryptoOk = useCryptoReady();
  const [receiver, setReceiver] = useState<LinkReceiver | null>(null);
  const [link, setLink] = useState('');
  const [code, setCode] = useState('');
  const [phrase, setPhrase] = useState('');
  const s = useMachine(receiver);

  // The device keys are made once the name is typed and the link opened (a new receiver per try).
  const open = async () => {
    const r = receiver && receiver.state.phase === 'enter' ? receiver : new LinkReceiver(deps, name.trim());
    setReceiver(r);
    await r.open(link, code);
  };
  const poll = useCallback(() => receiver?.poll(), [receiver]);
  usePoll(s?.phase === 'waiting', poll);
  useEffect(() => {
    if (s?.phase === 'approved') onJoined(s.joined);
  }, [s, onJoined]);

  if (!cryptoOk) return <ActivityIndicator color={c.accent} />;
  const enterError = s?.phase === 'enter' ? s.error : undefined;
  if (!s || s.phase === 'enter') {
    return (
      <View style={{ gap: 12 }} testID="device-link-form">
        <Frame.Note>{t('device.link.lead')}</Frame.Note>
        <WordsField label={t('device.link.field')} value={link} onChange={setLink} testID="device-link-input" lines={3} error={enterError === 'bad-link'} />
        <WordsField label={t('device.link.code')} value={code} onChange={setCode} testID="device-code" lines={2} error={enterError === 'wrong-code'} />
        <Frame.Note>{t('device.link.codeHelp')}</Frame.Note>
        {enterError && <ErrorText testID="device-link-error">{t(`device.error.${enterError}`)}</ErrorText>}
        <Button label={t('device.link.open')} onPress={() => void open()} disabled={!link.trim() || code.trim().split(/[\s-]+/).length !== 6} testID="device-link-open" />
      </View>
    );
  }
  if (s.phase === 'opening' || s.phase === 'approved') return <ActivityIndicator color={c.accent} accessibilityLabel={t('device.working')} />;
  if (s.phase === 'failed') {
    return (
      <View style={{ gap: 12 }}>
        <Banner tone="warning" testID="device-link-failed">{t(`device.error.${s.error}`)}</Banner>
        <Button kind="secondary" label={t('add.again')} onPress={() => setReceiver(null)} testID="device-link-again" />
      </View>
    );
  }
  return (
    <View style={{ gap: 12 }} testID="device-link-waiting">
      <Frame.Note>{t('device.link.reply')}</Frame.Note>
      <LinkActions link={s.requestLink} message={t('device.link.message', { link: s.requestLink })} testID="device-request" />
      <Frame.Note>{t('device.link.check')}</Frame.Note>
      <Fingerprint value={s.fingerprint} testID="device-fingerprint" />
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <ActivityIndicator color={c.accent} />
        <Frame.Note>{t('device.link.waiting')}</Frame.Note>
      </View>
      <Frame.Note>{t('device.link.orPhrase')}</Frame.Note>
      <WordsField label={t('device.link.phrase')} value={phrase} onChange={setPhrase} testID="device-link-phrase" error={!!s.error} />
      {s.error && <ErrorText>{t(`device.error.${s.error}`)}</ErrorText>}
      <Button kind="secondary" label={t('device.link.usePhrase')} onPress={() => void receiver?.certifyWithPhrase(phrase)} disabled={phrase.trim().split(/\s+/).length !== 12} testID="device-link-use-phrase" />
    </View>
  );
}

function QrWay({ name, onJoined }: { name: string; onJoined: (j: Joined) => void }) {
  const { t } = useI18n();
  const c = useUiColors();
  const cryptoOk = useCryptoReady();
  const [answer, setAnswer] = useState('');
  // One receiver per device name (the name is in the code shown).
  const receiver = useMemo(() => (cryptoOk ? new QrReceiver(deps, name.trim()) : null), [cryptoOk, name]);
  const s = useMachine(receiver);
  useEffect(() => {
    if (s?.phase === 'approved') onJoined(s.joined);
  }, [s, onJoined]);
  if (!receiver || !s) return <ActivityIndicator color={c.accent} />;
  if (s.phase !== 'showing') return <ActivityIndicator color={c.accent} accessibilityLabel={t('device.working')} />;
  return (
    <View style={{ gap: 12 }} testID="device-qr-showing">
      <Frame.Note>{t('device.qr.lead')}</Frame.Note>
      <QrCode value={s.offer} label={t('device.qr.label')} testID="device-qr-code" />
      <Frame.Note>{t('device.qr.check')}</Frame.Note>
      <Fingerprint value={s.fingerprint} testID="device-fingerprint" />
      <Frame.Note>{t('device.qr.answer')}</Frame.Note>
      <Scanner onScanned={(text) => void receiver.scanned(text)} testID="device-qr-scan" />
      <WordsField label={t('device.qr.paste')} value={answer} onChange={setAnswer} testID="device-qr-answer" lines={2} />
      {s.error && <ErrorText testID="device-qr-error">{t(`device.error.${s.error}`)}</ErrorText>}
      <Button label={t('device.qr.open')} onPress={() => void receiver.scanned(answer)} disabled={!answer.trim()} testID="device-qr-open" />
    </View>
  );
}

function PhraseWay({ onJoined }: { onJoined: (j: Joined) => void }) {
  const { t } = useI18n();
  const c = useUiColors();
  const [phrase, setPhrase] = useState('');
  const [address, setAddress] = useState('');
  const [primary, setPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await ready();
      onJoined(await restoreWithPhrase(phrase, address, deps, { primary }));
    } catch (e) {
      setError(e instanceof RestoreFailed ? e.code : 'failed');
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 12 }} testID="device-phrase-form">
      <Frame.Note>{t('device.phrase.lead')}</Frame.Note>
      <WordsField label={t('device.phrase.words')} value={phrase} onChange={setPhrase} testID="device-phrase-words" error={error === 'phrase'} />
      <Field label={t('device.phrase.address')} value={address} onChange={setAddress} keyboard="url" placeholder="https://…" testID="device-phrase-address" />
      <ToggleRow label={t('device.phrase.primary')} help={t('device.phrase.primaryHelp')} value={primary} onChange={setPrimary} testID="device-phrase-primary" />
      {error && <ErrorText testID="device-phrase-error">{t(`device.error.${error}`)}</ErrorText>}
      {busy ? (
        <ActivityIndicator color={c.accent} />
      ) : (
        <Button label={t('device.phrase.go')} onPress={() => void go()} disabled={phrase.trim().split(/\s+/).length !== 12 || !address.trim()} testID="device-phrase-go" />
      )}
    </View>
  );
}
