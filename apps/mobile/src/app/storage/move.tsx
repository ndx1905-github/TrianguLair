/**
 * Moving to another storage (T-203): plan, copy with progress and cancel, verify every file,
 * certify the new read address with the master key (this cancels open invitations), switch,
 * and keep the old storage as a signed redirect. Logic in src/storage/migration.ts.
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { StorageAdapter } from '@triangulair/storage';

import { DataGate } from '../../components/DataGate';
import { Banner, Button } from '../../components/ui';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { readAdapter, writeAdapter } from '../../storage/adapters';
import type { MasterKeySource } from '../../storage/certify';
import { protocolOf, sameStorage } from '../../storage/config';
import { MasterKeyPrompt, Muted, ProgressBar, Section, StorageScreen, formatBytes } from '../../storage/components';
import {
  MigrationCancelled,
  MigrationConflict,
  REDIRECT_KEEP_MS,
  SourceChanged,
  copyAll,
  planMigration,
  verifyCopy,
  verifyPublished,
  type MigrationPlan,
  type Progress,
  type VerifyResult,
} from '../../storage/migration';
import { useStorage, type SwitchResult } from '../../storage/StorageProvider';

type Phase =
  | { kind: 'planning' }
  | { kind: 'plan'; plan: MigrationPlan }
  | { kind: 'copying'; plan: MigrationPlan; progress: Progress | null }
  | { kind: 'verified'; plan: MigrationPlan; result: VerifyResult; copied: number; skipped: number }
  | { kind: 'switching'; plan: MigrationPlan }
  | { kind: 'done'; plan: MigrationPlan; result: SwitchResult }
  | { kind: 'error'; plan: MigrationPlan | null; error: 'conflict' | 'cancelled' | 'changed' | 'verify' | 'network' | 'phrase' | 'certify'; paths?: string[] };

function MoveScreen() {
  const c = useUiColors();
  const { t, locale } = useI18n();
  const router = useRouter();
  const storage = useStorage();
  // What the move started with (the provider's current storage changes at the switch).
  const initial = useRef({ from: storage.state.current, to: storage.draft });
  const { from, to } = initial.current;
  const [phase, setPhase] = useState<Phase>({ kind: 'planning' });
  const abort = useRef<AbortController | null>(null);
  const adapters = useRef<{ from: StorageAdapter | null; to: StorageAdapter } | null>(null);
  const date = (ms: number) => new Date(ms).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });

  const plan = async () => {
    if (!to) return;
    setPhase({ kind: 'planning' });
    const same = from !== null && sameStorage(from, to);
    const a = {
      from: from && !same ? writeAdapter(from) : null,
      to: to.kind === 'https' ? readAdapter(to) : writeAdapter(to),
    };
    adapters.current = a;
    try {
      const p = await planMigration(a.from, a.to);
      setPhase({ kind: 'plan', plan: p });
    } catch {
      setPhase({ kind: 'error', plan: null, error: 'network' });
    }
  };

  useEffect(() => {
    void plan();
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to]);

  const copy = async (p: MigrationPlan) => {
    const a = adapters.current;
    if (!a) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setPhase({ kind: 'copying', plan: p, progress: null });
    const onProgress = (progress: Progress) => setPhase((ph) => (ph.kind === 'copying' ? { ...ph, progress } : ph));
    try {
      if (p.kind === 'copy' && a.from) {
        // Plan again: a resumed copy skips what is already there.
        const fresh = await planMigration(a.from, a.to);
        const res = await copyAll(fresh, a.from, a.to, { signal: ctl.signal, onProgress });
        const result = await verifyCopy(res.hashes, a.to, { signal: ctl.signal, onProgress });
        setPhase(result.ok ? { kind: 'verified', plan: fresh, result, copied: res.copied, skipped: res.skipped } : { kind: 'error', plan: fresh, error: 'verify', paths: [...result.missing, ...result.mismatched] });
      } else if (p.kind === 'target-read-only' && a.from) {
        const result = await verifyPublished(p, a.from, a.to, { signal: ctl.signal, onProgress });
        setPhase(result.ok ? { kind: 'verified', plan: p, result, copied: 0, skipped: 0 } : { kind: 'error', plan: p, error: 'verify', paths: [...result.missing, ...result.mismatched] });
      } else {
        setPhase({ kind: 'verified', plan: p, result: { ok: true, checked: 0, missing: [], mismatched: [] }, copied: 0, skipped: 0 });
      }
    } catch (e) {
      if (e instanceof MigrationCancelled) setPhase({ kind: 'error', plan: p, error: 'cancelled' });
      else if (e instanceof MigrationConflict) setPhase({ kind: 'error', plan: p, error: 'conflict', paths: e.paths });
      else if (e instanceof SourceChanged) setPhase({ kind: 'error', plan: p, error: 'changed' });
      else setPhase({ kind: 'error', plan: p, error: 'network' });
    } finally {
      abort.current = null;
    }
  };

  const doSwitch = async (p: MigrationPlan, master: MasterKeySource) => {
    if (!to) return;
    setPhase({ kind: 'switching', plan: p });
    try {
      const result = await storage.switchTo(to, master);
      storage.setDraft(null);
      setPhase({ kind: 'done', plan: p, result });
    } catch (e) {
      setPhase({ kind: 'error', plan: p, error: e instanceof Error && e.message === 'phrase-mismatch' ? 'phrase' : 'certify' });
    }
  };

  if (!to || !from) {
    return (
      <StorageScreen title={t('storage.move.title')} testID="move-screen">
        <Muted>{t('storage.move.nothing')}</Muted>
        <Button label={t('storage.title')} onPress={() => router.dismissTo('/storage')} />
      </StorageScreen>
    );
  }

  const fromLabel = `${t(`storage.protocol.${protocolOf(from)}`)} · ${from.readUrl}`;
  const toLabel = `${t(`storage.protocol.${protocolOf(to)}`)} · ${to.readUrl}`;
  const p = 'plan' in phase ? phase.plan : null;

  return (
    <StorageScreen title={t('storage.move.title')} testID="move-screen">
      <Section title={t('storage.move.route')}>
        <Muted testID="move-from">{t('storage.move.from', { storage: fromLabel })}</Muted>
        <Muted testID="move-to">{t('storage.move.to', { storage: toLabel })}</Muted>
      </Section>

      {phase.kind === 'planning' && <Muted>{t('storage.move.planning')}</Muted>}

      {p && phase.kind !== 'done' && (
        <Section title={t('storage.move.planTitle')}>
          <Text style={{ color: c.text, fontSize: 15 }} maxFontSizeMultiplier={2} testID="move-plan">
            {p.kind === 'copy'
              ? t('storage.move.planCopy', { count: p.files.length, size: formatBytes(p.totalBytes, locale) })
              : p.kind === 'target-read-only'
                ? t('storage.move.planPublish', { count: p.files.length, size: formatBytes(p.totalBytes, locale) })
                : t('storage.move.planNoCopy')}
          </Text>
          <View style={{ gap: 4 }}>
            {(['copy', 'verify', 'certify', 'redirect'] as const).map((s, i) => (
              <Muted key={s}>{`${i + 1}. ${t(`storage.move.step.${s}`, { date: date(Date.now() + REDIRECT_KEEP_MS) })}`}</Muted>
            ))}
          </View>
          {p.extraAtDestination > 0 && <Muted>{t('storage.move.extra', { count: p.extraAtDestination })}</Muted>}
          {p.conflicts.length > 0 && <Banner tone="warning" testID="move-conflict">{t('storage.move.conflict', { paths: p.conflicts.slice(0, 3).join(', ') })}</Banner>}
          <Banner tone="warning" testID="move-invitations">{t('storage.move.invitationsWarning')}</Banner>
          {phase.kind === 'plan' && p.conflicts.length === 0 && (
            <Button label={p.kind === 'copy' ? t('storage.move.start') : p.kind === 'target-read-only' ? t('storage.move.verifyPublished') : t('storage.move.continue')} onPress={() => void copy(p)} testID="move-start" />
          )}
        </Section>
      )}

      {phase.kind === 'copying' && (
        <Section title={phase.progress?.phase === 'verify' ? t('storage.move.verifying') : t('storage.move.copying')}>
          <ProgressBar
            value={phase.progress ? (phase.progress.total ? phase.progress.done / phase.progress.total : 1) : 0}
            label={
              phase.progress
                ? t(phase.progress.phase === 'verify' ? 'storage.move.progressVerify' : 'storage.move.progressCopy', {
                    done: phase.progress.done,
                    total: phase.progress.total,
                    size: formatBytes(phase.progress.bytesDone, locale),
                    totalSize: formatBytes(phase.progress.bytesTotal, locale),
                  })
                : t('storage.move.planning')
            }
            testID="move-progress"
          />
          <Muted>{t('storage.move.cancelHelp')}</Muted>
          <View style={{ alignSelf: 'flex-start' }}>
            <Button kind="secondary" label={t('common.cancel')} onPress={() => abort.current?.abort()} testID="move-cancel" />
          </View>
        </Section>
      )}

      {phase.kind === 'verified' && (
        <Section title={t('storage.move.certifyTitle')}>
          <Banner testID="move-verified">
            {phase.result.checked ? t('storage.move.verified', { count: phase.result.checked, copied: phase.copied, skipped: phase.skipped }) : t('storage.move.nothingToVerify')}
          </Banner>
          <Muted>{t('storage.move.certifyHelp')}</Muted>
          <MasterKeyPrompt actionLabel={t('storage.move.switch')} onReady={(m) => void doSwitch(phase.plan, m)} testID="move-master" />
        </Section>
      )}

      {phase.kind === 'switching' && <Muted>{t('storage.move.switching')}</Muted>}

      {phase.kind === 'done' && (
        <Section title={t('storage.move.doneTitle')}>
          <Banner testID="move-done">{t('storage.move.done', { date: date(Date.now() + REDIRECT_KEEP_MS) })}</Banner>
          {phase.result.cancelled.length > 0 ? (
            <View style={{ gap: 4 }} testID="move-cancelled">
              <Muted>{t('storage.move.cancelledList')}</Muted>
              {phase.result.cancelled.map((i) => (
                <Muted key={`${i.name}-${i.createdAt}`}>{`• ${i.name}`}</Muted>
              ))}
            </View>
          ) : (
            <Muted>{t('storage.move.noInvitations')}</Muted>
          )}
          {!phase.result.published && <Muted testID="move-republish">{t('storage.republishPending')}</Muted>}
          <Muted>{t('storage.move.kitHint')}</Muted>
          <Muted>{t('storage.move.revokeHint')}</Muted>
          <Button label={t('storage.setup.done')} onPress={() => router.dismissTo('/storage')} testID="move-finish" />
        </Section>
      )}

      {phase.kind === 'error' && (
        <Section title={t('storage.move.problem')}>
          <Banner tone="warning" testID={`move-error-${phase.error}`}>
            {t(`storage.move.error.${phase.error}`)}
          </Banner>
          {phase.paths && phase.paths.length > 0 && <Muted>{phase.paths.slice(0, 5).join(', ')}</Muted>}
          <View style={styles.row}>
            {phase.plan && phase.error !== 'conflict' && phase.error !== 'phrase' && phase.error !== 'certify' && (
              <Button label={phase.error === 'cancelled' ? t('storage.move.resume') : t('storage.move.retry')} onPress={() => void copy(phase.plan!)} testID="move-resume" />
            )}
            {(phase.error === 'phrase' || phase.error === 'certify') && phase.plan && (
              <Button label={t('storage.move.retry')} onPress={() => setPhase({ kind: 'verified', plan: phase.plan!, result: { ok: true, checked: 0, missing: [], mismatched: [] }, copied: 0, skipped: 0 })} testID="move-retry-certify" />
            )}
            <Button kind="secondary" label={t('storage.move.keepCurrent')} onPress={() => router.dismissTo('/storage')} testID="move-abandon" />
          </View>
          <Muted>{t('storage.move.currentSafe')}</Muted>
        </Section>
      )}
    </StorageScreen>
  );
}

export default function StorageMoveRoute() {
  return (
    <DataGate>
      <MoveScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
