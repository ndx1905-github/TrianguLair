/**
 * Storage wizard (spec "Later, at the right moment" › Storage): choose the protocol, fill in the
 * form, run the full connection test, then:
 * - no storage yet: certify the read address with the master key and connect;
 * - `mode=edit` (same read address): save new credentials, no new certificate;
 * - otherwise: hand the tested config to the move screen (copy, verify, certify, redirect).
 *
 * Params: `reason` (invite | link-list | public-list | backup: why it is asked now), `return`
 * (in-app path to go to afterwards), `mode` (edit | move).
 */
import { useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button, Segmented } from '../../components/ui';
import { useI18n } from '../../i18n';
import {
  DEFAULT_S3_REGION,
  EMPTY_DRAFT,
  buildConfig,
  draftFromConfig,
  nextcloudDavUrl,
  normalizePrefix,
  suggestedReadUrl,
  type DraftField,
  type DraftProblem,
  type StorageChoice,
  type StorageConfig,
  type StorageDraft,
} from '../../storage/config';
import { runConnectionTest, type TestReport, type TestStep } from '../../storage/connectionTest';
import { ChoiceCard, CopyBlock, Field, MasterKeyPrompt, Muted, Section, StorageScreen, TestResults } from '../../storage/components';
import { useStorage } from '../../storage/StorageProvider';
import { safeReturn } from '../../storage/useStorageForSharing';
import { s3AccessKeyPolicy } from '../../storage/fixes';

const CHOICES: StorageChoice[] = ['nextcloud', 'webdav', 's3', 'sftp', 'https'];

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function SetupScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{ reason?: string; return?: string; mode?: string }>();
  const reason = one(params.reason);
  const returnTo = safeReturn(params.return);
  const mode = one(params.mode);
  const storage = useStorage();
  const current = storage.state.current;
  const editing = mode === 'edit' && current !== null;

  const [draft, setDraft] = useState<StorageDraft>(() => (editing && current ? draftFromConfig(current) : EMPTY_DRAFT));
  const [chosen, setChosen] = useState(editing);
  const [showProblems, setShowProblems] = useState(false);
  const [steps, setSteps] = useState<TestStep[] | null>(null);
  const [report, setReport] = useState<{ config: StorageConfig; report: TestReport } | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const built = useMemo(() => buildConfig(draft), [draft]);
  const problemsFor = (f: DraftField): DraftProblem[] => built.problems.filter((p) => p.field === f && (showProblems || p.level === 'warning'));
  const set = (patch: Partial<StorageDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setReport(null);
    setSteps(null);
  };

  const finish = () => {
    if (returnTo) router.replace(returnTo as Href);
    else if (router.canGoBack()) router.back();
    else router.dismissTo('/storage');
  };

  const test = async () => {
    setShowProblems(true);
    setError(null);
    if (!built.config) return;
    const config = built.config;
    setTesting(true);
    setSteps([]);
    try {
      const r = await runConnectionTest(config, {
        platform: Platform.OS === 'web' ? 'web' : 'native',
        origin: Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : null,
        onStep: setSteps,
      });
      setSteps(r.steps);
      const tested: StorageConfig = config.kind !== 'https' && r.conditionalWrites !== null ? { ...config, conditionalWrites: r.conditionalWrites } : config;
      setReport({ config: tested, report: r });
    } finally {
      setTesting(false);
    }
  };

  const use = async (master?: Parameters<typeof storage.switchTo>[1]) => {
    if (!report?.report.ok) return;
    const config = report.config;
    setError(null);
    if (current && config.readUrl === current.readUrl) {
      // Same read address: new credentials (or the same folder through another URL), nothing to certify.
      await storage.updateCurrent(config);
      return finish();
    }
    if (current) {
      // Another read address: the move screen copies (unless it is the same folder), verifies and certifies.
      storage.setDraft(config);
      router.push('/storage/move');
      return;
    }
    if (!master) return;
    setBusy(true);
    try {
      await storage.switchTo(config, master);
      setConnected(true);
    } catch (e) {
      setError(e instanceof Error && e.message === 'phrase-mismatch' ? 'phrase' : 'certify');
    } finally {
      setBusy(false);
    }
  };

  if (connected) {
    return (
      <StorageScreen title={t('storage.setup.title')} testID="storage-connected">
        <Banner testID="storage-connected-banner">{t('storage.setup.connected')}</Banner>
        <Muted>{t('storage.setup.connectedKit')}</Muted>
        <Muted>{t('storage.republishPending')}</Muted>
        <Button label={t('storage.setup.done')} onPress={finish} testID="storage-done" />
      </StorageScreen>
    );
  }

  const choice = draft.choice;
  const suggested = suggestedReadUrl(draft);
  const willMove = current !== null && report !== null && report.config.readUrl !== current.readUrl;

  return (
    <StorageScreen title={editing ? t('storage.setup.editTitle') : current ? t('storage.setup.moveTitle') : t('storage.setup.title')} testID="storage-setup">
      {reason ? <Banner testID="storage-reason">{t(`storage.reason.${reason}`)}</Banner> : null}
      {!editing && !chosen && (
        <Section title={t('storage.setup.choose')}>
          {!current && <ChoiceCard title={t('storage.choice.local')} help={t('storage.choice.localHelp')} onPress={finish} testID="choice-local" />}
          {CHOICES.map((ch) => (
            <ChoiceCard
              key={ch}
              title={t(`storage.choice.${ch}`)}
              help={t(`storage.choice.${ch}Help`)}
              selected={chosen && ch === choice}
              disabled={ch === 'sftp'}
              badge={ch === 'sftp' ? t('storage.desktopOnly') : undefined}
              onPress={() => {
                if (ch === 'sftp' || ch === 'local') return;
                set({ choice: ch });
                setChosen(true);
              }}
              testID={`choice-${ch}`}
            />
          ))}
        </Section>
      )}

      {chosen && (
        <Section title={t(`storage.choice.${choice}`)}>
          {!editing && (
            <View style={{ alignSelf: 'flex-start' }}>
              <Button kind="secondary" label={t('storage.setup.otherChoice')} onPress={() => setChosen(false)} testID="choice-other" />
            </View>
          )}
          {choice === 'nextcloud' && (
            <>
              <Field label={t('storage.field.ncServer')} value={draft.ncServer} onChange={(v) => set({ ncServer: v })} placeholder="https://cloud.example.org" keyboard="url" problems={problemsFor('ncServer')} testID="field-ncServer" />
              <Field label={t('storage.field.ncUser')} value={draft.ncUser} onChange={(v) => set({ ncUser: v })} help={t('storage.field.ncUserHelp')} problems={problemsFor('ncUser')} testID="field-ncUser" />
              <Field label={t('storage.field.ncPassword')} value={draft.ncPassword} onChange={(v) => set({ ncPassword: v })} help={t('storage.field.ncPasswordHelp')} secret problems={problemsFor('ncPassword')} testID="field-ncPassword" />
              {nextcloudDavUrl(draft.ncServer, draft.ncUser) && <Muted testID="nc-dav-url">{t('storage.field.ncFolder', { url: nextcloudDavUrl(draft.ncServer, draft.ncUser)! })}</Muted>}
              <Field label={t('storage.field.ncShareLink')} value={draft.ncShareLink} onChange={(v) => set({ ncShareLink: v })} placeholder="https://cloud.example.org/s/…" help={t('storage.field.ncShareLinkHelp')} keyboard="url" problems={problemsFor('ncShareLink')} testID="field-ncShareLink" />
              <Muted>{t('storage.field.ncLoginFlowLater')}</Muted>
            </>
          )}
          {choice === 'webdav' && (
            <>
              <Field label={t('storage.field.davUrl')} value={draft.davUrl} onChange={(v) => set({ davUrl: v })} placeholder="https://dav.example.org/TrianguLair/" keyboard="url" problems={problemsFor('davUrl')} testID="field-davUrl" />
              <Field label={t('storage.field.davUser')} value={draft.davUser} onChange={(v) => set({ davUser: v })} problems={problemsFor('davUser')} testID="field-davUser" />
              <Field label={t('storage.field.davPassword')} value={draft.davPassword} onChange={(v) => set({ davPassword: v })} secret problems={problemsFor('davPassword')} testID="field-davPassword" />
            </>
          )}
          {choice === 's3' && (
            <>
              <Field label={t('storage.field.s3Endpoint')} value={draft.s3Endpoint} onChange={(v) => set({ s3Endpoint: v })} placeholder="https://s3.fr-par.scw.cloud" keyboard="url" problems={problemsFor('s3Endpoint')} testID="field-s3Endpoint" />
              <Field label={t('storage.field.s3Bucket')} value={draft.s3Bucket} onChange={(v) => set({ s3Bucket: v })} problems={problemsFor('s3Bucket')} testID="field-s3Bucket" />
              <Field label={t('storage.field.s3Region')} value={draft.s3Region} onChange={(v) => set({ s3Region: v })} placeholder={DEFAULT_S3_REGION} problems={problemsFor('s3Region')} testID="field-s3Region" />
              <Field label={t('storage.field.s3AccessKey')} value={draft.s3AccessKey} onChange={(v) => set({ s3AccessKey: v })} problems={problemsFor('s3AccessKey')} testID="field-s3AccessKey" />
              <Field label={t('storage.field.s3SecretKey')} value={draft.s3SecretKey} onChange={(v) => set({ s3SecretKey: v })} secret problems={problemsFor('s3SecretKey')} testID="field-s3SecretKey" />
              <Field label={t('storage.field.s3Prefix')} value={draft.s3Prefix} onChange={(v) => set({ s3Prefix: v })} help={t('storage.field.s3PrefixHelp')} problems={problemsFor('s3Prefix')} testID="field-s3Prefix" />
              <Segmented
                options={[
                  { value: 'path' as const, label: t('storage.field.s3PathStyle') },
                  { value: 'host' as const, label: t('storage.field.s3HostStyle') },
                ]}
                value={draft.s3PathStyle ? 'path' : 'host'}
                onChange={(v) => set({ s3PathStyle: v === 'path' })}
                testID="field-s3Style"
              />
              <Muted>{t('storage.field.s3KeyHelp')}</Muted>
              {draft.s3Bucket.trim() !== '' && normalizePrefix(draft.s3Prefix) !== null && <CopyBlock text={s3AccessKeyPolicy(draft.s3Bucket.trim(), normalizePrefix(draft.s3Prefix)!)} testID="s3-key-policy" />}
            </>
          )}
          {choice === 'https' && <Muted>{t('storage.field.httpsHelp')}</Muted>}

          <Field
            label={choice === 'https' ? t('storage.field.httpsUrl') : t('storage.field.readUrl')}
            value={draft.readUrl}
            onChange={(v) => set({ readUrl: v })}
            placeholder={suggested ?? 'https://…'}
            help={choice === 'https' ? undefined : suggested && !draft.readUrl.trim() ? t('storage.field.readUrlSuggested', { url: suggested }) : t('storage.field.readUrlHelp')}
            keyboard="url"
            problems={problemsFor('readUrl')}
            testID="field-readUrl"
          />

          {showProblems && !built.config && <Banner tone="warning" testID="form-problems">{t('storage.setup.fixForm')}</Banner>}
          <View style={styles.row}>
            <Button label={testing ? t('storage.testing') : t('storage.test')} onPress={() => void test()} disabled={testing} testID="setup-test" />
          </View>
          {steps && <TestResults steps={steps} />}
          {report && !testing && (
            <>
              <Banner tone={report.report.ok ? 'info' : 'warning'} testID="test-summary">
                {report.report.ok ? t('storage.setup.testOk') : t('storage.setup.testFailed')}
              </Banner>
              {report.report.ok && (
                <>
                  {report.report.hasIndex && !current && <Banner tone="warning">{t('storage.setup.hasIndex')}</Banner>}
                  {!current ? (
                    <Section title={t('storage.setup.certifyTitle')}>
                      <Muted>{t('storage.setup.certifyHelp')}</Muted>
                      <MasterKeyPrompt actionLabel={t('storage.setup.use')} busy={busy} onReady={(m) => void use(m)} testID="setup-master" />
                    </Section>
                  ) : (
                    <Button label={willMove ? t('storage.setup.planMove') : t('storage.setup.save')} onPress={() => void use()} testID="setup-use" />
                  )}
                </>
              )}
              {error && <Banner tone="warning">{t(`storage.setup.error.${error}`)}</Banner>}
            </>
          )}
        </Section>
      )}
    </StorageScreen>
  );
}

export default function StorageSetupRoute() {
  return (
    <DataGate>
      <SetupScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
