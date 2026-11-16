/**
 * "Declare a device lost" and "Remove a device" (spec "Loss and theft", T-207), from the primary
 * device or with the 12 words: a new sharing certificate (rotation + 1, new random sharing key and
 * vault data key, the device revoked) signed by the master key; every open invitation cancelled
 * (declaration of loss); the new key sealed to my remaining devices; everything re-encrypted and
 * published; then the storage access to change (current storage and every previous one that still
 * redirects) and what changed since the theft.
 */
import { useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button } from '../../components/ui';
import { Card, Strong } from '../../contacts/ui';
import { credentialGuide, type GuideItem } from '../../devices/guide';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useIdentity, useReadyIdentity } from '../../identity/IdentityProvider';
import type { MasterKeySource } from '../../storage/certify';
import { ChoiceCard, MasterKeyPrompt, Muted, Section, StorageScreen } from '../../storage/components';
import type { OpenInvitationSummary } from '../../storage/interfaces';
import { useStorage } from '../../storage/StorageProvider';
import { useSync } from '../../sync/SyncProvider';

type Step =
  | { kind: 'choose' }
  | { kind: 'working' }
  | { kind: 'done'; name: string; cancelled: OpenInvitationSummary[]; delivered: number; device: string }
  | { kind: 'failed'; reason: string };

function Bullet({ children }: { children: string }) {
  const c = useUiColors();
  return (
    <View style={styles.bullet}>
      <Text style={{ color: c.textMuted, fontSize: 15 }} maxFontSizeMultiplier={2}>
        •
      </Text>
      <Text style={{ color: c.text, fontSize: 15, flexShrink: 1 }} maxFontSizeMultiplier={2}>
        {children}
      </Text>
    </View>
  );
}

export function GuideCard({ item }: { item: GuideItem }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const date = (ms: number) => new Date(ms).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <Card testID={`guide-${item.role}`}>
      <Strong>{item.role === 'current' ? t('lost.guide.current') : t('lost.guide.previous', { date: date(item.keepUntil ?? 0) })}</Strong>
      <Muted>{`${t(`storage.protocol.${item.protocol}`)} · ${item.address}`}</Muted>
      {item.steps.map((k, i) => (
        <Text key={k} style={{ fontSize: 15 }} maxFontSizeMultiplier={2}>
          <Muted>{`${i + 1}. ${t(k)}`}</Muted>
        </Text>
      ))}
      <View style={styles.row}>
        {item.links.map((l) => (
          <Button key={l.url} kind="secondary" label={t(l.label)} onPress={() => void Linking.openURL(l.url)} testID={`guide-link-${item.protocol}`} />
        ))}
        {item.canUpdateHere && <Button label={t('lost.guide.update')} onPress={() => router.push('/storage/setup?mode=edit')} testID="guide-update" />}
      </View>
    </Card>
  );
}

function LostScreen() {
  const { t } = useI18n();
  const c = useUiColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ device?: string; mode?: string }>();
  const remove = params.mode === 'remove';
  const identity = useIdentity();
  const me = useReadyIdentity().record.deviceId;
  const storage = useStorage();
  const sync = useSync();
  const others = sync.devices().filter((d) => d.removed === undefined && d.cert.device !== me);
  const [chosen, setChosen] = useState<string | null>(typeof params.device === 'string' ? params.device : null);
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [wrong, setWrong] = useState(false);
  const target = others.find((d) => d.cert.device === chosen) ?? null;

  const run = async (master: MasterKeySource) => {
    if (!target) return;
    setWrong(false);
    let rotation;
    try {
      rotation = await identity.rotateSharingCert({ revokeDevices: [target.cert.device], newKey: true }, master);
    } catch (e) {
      if (e instanceof Error && (e.message === 'phrase-mismatch' || e.message === 'master-key-needed')) return setWrong(true);
      return setStep({ kind: 'failed', reason: e instanceof Error ? e.message : 'error' });
    }
    setStep({ kind: 'working' });
    try {
      const r = await sync.declareLost(rotation, { cancelInvitations: !remove });
      setStep({ kind: 'done', name: target.name || t('devices.unnamed'), cancelled: r.cancelled, delivered: r.delivered.length, device: target.cert.device });
    } catch (e) {
      setStep({ kind: 'failed', reason: e instanceof Error ? e.message.replace(/^sync: /, '') : 'error' });
    }
  };

  const title = remove ? t('lost.removeTitle') : t('lost.title');
  if (step.kind === 'working') {
    return (
      <StorageScreen title={title} testID="lost-screen">
        <View style={styles.row}>
          <ActivityIndicator color={c.accent} />
          <Muted>{t('lost.working')}</Muted>
        </View>
      </StorageScreen>
    );
  }
  if (step.kind === 'done') {
    const guide = remove ? [] : credentialGuide(storage.state, Date.now());
    return (
      <StorageScreen title={title} testID="lost-screen">
        <Banner testID="lost-done">{remove ? t('lost.removed', { name: step.name }) : t('lost.done', { name: step.name })}</Banner>
        <Muted>{t('lost.delivered', { count: step.delivered })}</Muted>
        {!remove && (
          <Section title={t('inviting.title')}>
            {step.cancelled.length ? (
              <>
                <Muted testID="lost-cancelled">{t('lost.cancelled')}</Muted>
                {step.cancelled.map((i, n) => (
                  <Bullet key={n}>{i.name || t('lost.unnamed')}</Bullet>
                ))}
                <Button kind="secondary" label={t('lost.invite')} onPress={() => router.push('/invite')} testID="lost-invite" />
              </>
            ) : (
              <Muted testID="lost-cancelled-none">{t('lost.cancelledNone')}</Muted>
            )}
          </Section>
        )}
        {guide.length > 0 && (
          <Section title={t('lost.guide.title')}>
            <Muted>{t('lost.guide.lead')}</Muted>
            {guide.map((g, i) => (
              <GuideCard key={i} item={g} />
            ))}
          </Section>
        )}
        {!remove && <Button label={t('lost.changes')} onPress={() => router.push(`/devices/changes?device=${encodeURIComponent(step.device)}` as Href)} testID="lost-changes" />}
        <Button kind="secondary" label={t('add.back')} onPress={() => router.replace('/devices')} testID="lost-back" />
      </StorageScreen>
    );
  }
  return (
    <StorageScreen title={title} testID="lost-screen">
      <Muted>{remove ? t('lost.removeLead') : t('lost.lead')}</Muted>
      {step.kind === 'failed' && <Banner tone="warning" testID="lost-failed">{t('lost.failed', { reason: step.reason })}</Banner>}
      <Section title={t('lost.choose')}>
        {others.length === 0 && <Muted>{t('lost.noOther')}</Muted>}
        {others.map((d) => (
          <ChoiceCard key={d.cert.device} title={d.name || t('devices.unnamed')} help={d.added ? t('devices.added', { date: new Date(d.added).toLocaleDateString() }) : ''} selected={chosen === d.cert.device} onPress={() => setChosen(d.cert.device)} testID="lost-device" />
        ))}
      </Section>
      {target && (
        <>
          <Section title={t('lost.what.title')}>
            <Bullet>{t('lost.what.key')}</Bullet>
            {!remove && <Bullet>{t('lost.what.invites')}</Bullet>}
            <Bullet>{t('lost.what.wipe')}</Bullet>
            {!remove && <Bullet>{t('lost.what.access')}</Bullet>}
          </Section>
          <Muted>{t('lost.master')}</Muted>
          <MasterKeyPrompt onReady={(m) => void run(m)} actionLabel={remove ? t('lost.removeGo') : t('lost.go')} testID="lost-master" />
          {wrong && <Text style={{ color: c.danger }} maxFontSizeMultiplier={2}>{t('settings.primaryMismatch')}</Text>}
        </>
      )}
    </StorageScreen>
  );
}

export default function LostRoute() {
  return (
    <DataGate>
      <LostScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  bullet: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
});
