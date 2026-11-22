/**
 * Import and export (T-114, T-115): pick a file, map its columns if it is a
 * generic CSV, match the places to OpenStreetMap, review the preview (found /
 * to check / manual points / no position, and what each source tag becomes),
 * write in batches with progress and cancel, undo for a few days; export
 * everything as GeoJSON, in a ZIP archive with my photos (decrypted) when I
 * have some; friends' photos are never exported. All the logic is in
 * @triangulair/import; the photos come from and go to the photo store
 * (`Photos`, sync package).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  applyImport,
  buildPlan,
  exportArchive,
  mappingProblems,
  matchPlaces,
  osmLookupFromClient,
  readCsvWithMapping,
  readImportFile,
  resolveItem,
  setTagAction,
  applyTagSuggestions,
  pendingTagSuggestions,
  summarizePlan,
  undoImport,
  type ColumnMapping,
  type CsvTable,
  type ImportFile,
  type ImportPlan,
  type ImportReport,
  type ItemGroup,
  type ParseResult,
} from '@triangulair/import';

import { DataGate } from '../components/DataGate';
import { ScreenHeader } from '../components/ScreenHeader';
import { Banner, Button, SectionTitle, Segmented } from '../components/ui';
import { APP_VERSION } from '../config';
import { useData } from '../data/DataProvider';
import { getSetting, setSetting } from '../data/deviceSettings';
import { useTags } from '../data/usePlaces';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { ColumnMappingEditor, PreviewRow, ProgressBar, TagMappingRow } from '../importExport/components';
import { pickImportFile, saveExportFile } from '../importExport/files';
import { firstGroup, GROUP_ORDER, itemsByGroup, LAST_IMPORT_KEY, serializeReport, toWrite, undoableReport, UNDO_DAYS } from '../importExport/logic';
import { osmClient } from '../osm/client';
import { usePhotosService } from '../photos/usePhotos';

type Step =
  | { kind: 'home' }
  | { kind: 'reading' }
  | { kind: 'mapping'; table: CsvTable; mapping: ColumnMapping; fileName: string }
  | { kind: 'matching'; done: number; total: number }
  | { kind: 'preview'; plan: ImportPlan; group: ItemGroup; fileName: string; offline: boolean }
  | { kind: 'writing'; done: number; total: number }
  | { kind: 'done'; report: ImportReport };

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

function ImportScreen() {
  const c = useUiColors();
  const { t, locale } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { gutter } = useLayout();
  const { store, repo, mutate } = useData();
  const { tags: myTags } = useTags();
  const [step, setStep] = useState<Step>({ kind: 'home' });
  const [message, setMessage] = useState<{ tone: 'info' | 'warning'; text: string } | null>(null);
  const [lastImport, setLastImport] = useState<ImportReport | null>(() => undoableReport(getSetting(LAST_IMPORT_KEY), Date.now()));
  const abort = useRef<AbortController | null>(null);
  const photos = usePhotosService();

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const startMatching = useCallback(
    async (result: ParseResult, fileName: string) => {
      const ac = new AbortController();
      abort.current = ac;
      setStep({ kind: 'matching', done: 0, total: 1 });
      try {
        const matches = await matchPlaces(result.places, osmLookupFromClient(osmClient()), {
          signal: ac.signal,
          onProgress: (done, total) => setStep({ kind: 'matching', done, total }),
        });
        const plan = buildPlan(result, matches, repo);
        const offline = [...matches.values()].some((m) => (m.kind === 'manual' || m.kind === 'unlocated') && m.lookupFailed);
        setStep({ kind: 'preview', plan, group: firstGroup(plan), fileName, offline });
      } catch (e) {
        if (!isAbort(e)) setMessage({ tone: 'warning', text: t('import.error.unreadable') });
        setStep({ kind: 'home' });
      } finally {
        abort.current = null;
      }
    },
    [repo, t],
  );

  const openFile = useCallback(
    async (file: ImportFile) => {
      setMessage(null);
      setStep({ kind: 'reading' });
      // Let the spinner render before a large file is parsed synchronously.
      await new Promise((r) => setTimeout(r, 0));
      const o = readImportFile(file);
      if (o.kind === 'error') {
        setMessage({ tone: 'warning', text: t(`import.error.${o.code}`) });
        setStep({ kind: 'home' });
      } else if (o.kind === 'needsMapping') {
        setStep({ kind: 'mapping', table: o.table, mapping: o.mapping, fileName: o.fileName });
      } else {
        await startMatching(o.result, file.name);
      }
    },
    [startMatching, t],
  );

  const pick = async () => {
    try {
      const f = await pickImportFile();
      if (f) await openFile(f);
    } catch {
      setMessage({ tone: 'warning', text: t('import.error.unreadable') });
      setStep({ kind: 'home' });
    }
  };

  const doExport = async () => {
    setMessage(null);
    try {
      // My photos, decrypted (a full photo not on this device is fetched from my storage).
      const out = await exportArchive(store, {
        app: `TrianguLair ${APP_VERSION}`,
        image: async (id, which) => (photos ? (which === 'full' ? photos.full(id) : photos.thumbnail(id)) : null),
      });
      await saveExportFile(out.name, out.bytes, out.mime, t('import.exportTitle'));
      setMessage({
        tone: out.missing > 0 ? 'warning' : 'info',
        text: out.missing > 0 ? t('import.exportedMissing', { file: out.name, count: out.missing }) : t('import.exported', { file: out.name }),
      });
    } catch {
      setMessage({ tone: 'warning', text: t('import.exportFailed') });
    }
  };

  const confirm = async (plan: ImportPlan) => {
    const ac = new AbortController();
    abort.current = ac;
    setStep({ kind: 'writing', done: 0, total: toWrite(plan) });
    try {
      const report = await applyImport(store, plan, {
        signal: ac.signal,
        onProgress: (done, total) => setStep({ kind: 'writing', done, total }),
        // My photos from a TrianguLair archive: checked, stored on this device, uploaded at the next sync.
        ...(photos && {
          addPhoto: (placeId: string, p: { images: { full: Uint8Array; thumb: Uint8Array }; width?: number | null; height?: number | null; createdAt?: number }) =>
            photos.add(placeId, { full: p.images.full, thumb: p.images.thumb, width: p.width ?? 0, height: p.height ?? 0 }, p.createdAt !== undefined ? { createdAt: p.createdAt } : {}),
        }),
      });
      setSetting(LAST_IMPORT_KEY, serializeReport(report));
      setLastImport(undoableReport(serializeReport(report), Date.now()));
      setStep({ kind: 'done', report });
    } finally {
      abort.current = null;
      mutate(() => undefined);
    }
  };

  const undo = async (report: ImportReport) => {
    setStep({ kind: 'writing', done: 0, total: report.createdPlaceIds.length + report.merged.length });
    try {
      await undoImport(store, report, { onProgress: (done, total) => setStep({ kind: 'writing', done, total }) });
      setSetting(LAST_IMPORT_KEY, '');
      setLastImport(null);
      setMessage({ tone: 'info', text: t('import.undone') });
    } finally {
      mutate(() => undefined);
      setStep({ kind: 'home' });
    }
  };

  const body = (() => {
    switch (step.kind) {
      case 'home':
        return (
          <>
            <SectionTitle>{t('import.importSection')}</SectionTitle>
            <Text style={[styles.p, { color: c.text }]} maxFontSizeMultiplier={2}>
              {t('import.intro')}
            </Text>
            <Text style={[styles.small, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
              {t('import.formats')}
            </Text>
            <Button label={t('import.pick')} onPress={() => void pick()} testID="import-pick" />
            {lastImport ? (
              <>
                <SectionTitle>{t('import.undoSection')}</SectionTitle>
                <Text style={[styles.p, { color: c.text }]} maxFontSizeMultiplier={2}>
                  {t('import.undoInfo', {
                    count: lastImport.counts.imported,
                    date: new Date(lastImport.at).toLocaleDateString(locale),
                  })}
                </Text>
                <Button label={t('import.undo')} kind="secondary" onPress={() => void undo(lastImport)} testID="import-undo" />
              </>
            ) : null}
            <SectionTitle>{t('import.exportSection')}</SectionTitle>
            <Text style={[styles.p, { color: c.text }]} maxFontSizeMultiplier={2}>
              {t('import.exportIntro')}
            </Text>
            <Button label={t('import.export')} kind="secondary" onPress={() => void doExport()} testID="export-all" />
          </>
        );
      case 'reading':
        return <Busy text={t('import.reading')} />;
      case 'mapping': {
        const problems = mappingProblems(step.mapping);
        return (
          <>
            <SectionTitle>{t('import.mapping.title')}</SectionTitle>
            <Text style={[styles.p, { color: c.text }]} maxFontSizeMultiplier={2}>
              {t('import.mapping.intro')}
            </Text>
            <ColumnMappingEditor table={step.table} mapping={step.mapping} onChange={(mapping) => setStep({ ...step, mapping })} />
            {problems.map((p) => (
              <Banner key={p} tone="warning">
                {t(p === 'name' ? 'import.mapping.needName' : 'import.mapping.needPosition')}
              </Banner>
            ))}
            <Button
              label={t('import.mapping.continue')}
              disabled={problems.length > 0}
              onPress={() => void startMatching(readCsvWithMapping(step.table, step.mapping, step.fileName), `${step.fileName}.csv`)}
              testID="mapping-continue"
            />
          </>
        );
      }
      case 'matching':
        return (
          <Busy text={t('import.matching')}>
            <ProgressBar done={step.done} total={step.total} testID="matching-progress" />
            <Text style={[styles.small, { color: c.textMuted, textAlign: 'center' }]}>{t('import.matchingProgress', { done: step.done, total: step.total })}</Text>
            <Button label={t('import.cancel')} kind="secondary" onPress={() => abort.current?.abort()} testID="matching-cancel" />
          </Busy>
        );
      case 'preview':
        return <Preview step={step} setStep={setStep} onConfirm={(p) => void confirm(p)} myTags={myTags} />;
      case 'writing':
        return (
          <Busy text={t('import.writing')}>
            <ProgressBar done={step.done} total={step.total} testID="writing-progress" />
            <Text style={[styles.small, { color: c.textMuted, textAlign: 'center' }]}>{t('import.writingProgress', { done: step.done, total: step.total })}</Text>
            <Button label={t('import.cancel')} kind="secondary" onPress={() => abort.current?.abort()} testID="writing-cancel" />
          </Busy>
        );
      case 'done': {
        const n = step.report.counts;
        return (
          <View testID="import-done" style={{ gap: 10 }}>
            <SectionTitle>{t('import.done.title')}</SectionTitle>
            {step.report.cancelled ? <Banner tone="warning">{t('import.done.cancelled')}</Banner> : null}
            {(
              [
                ['imported', n.imported],
                ['linked', n.linkedToOsm],
                ['toCheck', n.toCheck],
                ['manual', n.manual],
                ['merged', n.merged],
                ['photos', n.photos ?? 0],
                ['photosSkipped', n.photosSkipped ?? 0],
                ['skipped', n.skipped + n.duplicates],
              ] as const
            )
              .filter(([k, count]) => count > 0 || !k.startsWith('photos'))
              .map(([k, count]) => (
              <Text key={k} style={[k === 'imported' ? styles.big : styles.p, { color: c.text }]} maxFontSizeMultiplier={2}>
                {t(`import.done.${k}`, { count })}
              </Text>
            ))}
            <Text style={[styles.small, { color: c.textMuted }]}>{t('import.done.undoHint', { days: UNDO_DAYS })}</Text>
            <Button label={t('import.done.map')} onPress={back} testID="import-to-map" />
            <Button label={t('import.undo')} kind="secondary" onPress={() => void undo(step.report)} testID="import-undo-now" />
            <Button label={t('import.again')} kind="secondary" onPress={() => setStep({ kind: 'home' })} />
          </View>
        );
      }
    }
  })();

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScreenHeader title={step.kind === 'preview' ? t('import.preview.title') : t('import.title')} onBack={step.kind === 'home' ? back : () => setStep({ kind: 'home' })} />
      <ScrollView contentContainerStyle={{ padding: gutter, paddingBottom: insets.bottom + 32, gap: 12, maxWidth: 760, width: '100%', alignSelf: 'center' }} testID="import-screen">
        {message ? (
          <Banner tone={message.tone} testID="import-message">
            {message.text}
          </Banner>
        ) : null}
        {body}
      </ScrollView>
    </View>
  );
}

function Busy({ text, children }: { text: string; children?: React.ReactNode }) {
  const c = useUiColors();
  return (
    <View style={styles.busy} testID="import-busy">
      <ActivityIndicator color={c.accent} />
      <Text style={[styles.p, { color: c.text, textAlign: 'center' }]} maxFontSizeMultiplier={2}>
        {text}
      </Text>
      {children}
    </View>
  );
}

function Preview({
  step,
  setStep,
  onConfirm,
  myTags,
}: {
  step: Extract<Step, { kind: 'preview' }>;
  setStep: (s: Step) => void;
  onConfirm: (plan: ImportPlan) => void;
  myTags: ReturnType<typeof useTags>['tags'];
}) {
  const c = useUiColors();
  const { t } = useI18n();
  const { repo } = useData();
  const { plan } = step;
  const groups = useMemo(() => itemsByGroup(plan), [plan]);
  const summary = useMemo(() => summarizePlan(plan), [plan]);
  const tagNames = useMemo(() => new Map(plan.tags.map((e) => [e.source.key, e.source.name])), [plan]);
  const count = toWrite(plan);
  const shown = groups[step.group];
  return (
    <View style={{ gap: 12 }} testID="import-preview">
      <Text style={[styles.p, { color: c.text }]} maxFontSizeMultiplier={2}>
        {t(`import.format.${plan.format}`)} · {t('import.preview.summary', { total: summary.total, file: step.fileName })}
      </Text>
      {!plan.verified ? (
        <Banner tone="warning" testID="unverified-banner">
          {t('import.unverified', { format: t(`import.format.${plan.format}`) })}
        </Banner>
      ) : null}
      {step.offline ? <Banner tone="warning">{t('import.offline')}</Banner> : null}
      <Segmented
        options={GROUP_ORDER.map((g) => ({ value: g, label: `${t(`import.group.${g}`)} ${groups[g].length}` }))}
        value={step.group}
        onChange={(group) => setStep({ ...step, group })}
        testID="preview-groups"
      />
      <Text style={[styles.small, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
        {t(`import.groupHint.${step.group}`)}
      </Text>
      {shown.map((item, i) => (
        <PreviewRow
          key={item.key}
          item={item}
          sourceTagNames={tagNames}
          initiallyOpen={step.group === 'ambiguous' && i === 0}
          onResolve={(r) => setStep({ ...step, plan: resolveItem(plan, item.key, r, repo) })}
        />
      ))}
      {plan.tags.length > 0 ? (
        <>
          <SectionTitle>{t('import.tags.title')}</SectionTitle>
          <Text style={[styles.small, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {t('import.tags.intro')}
          </Text>
          {pendingTagSuggestions(plan) > 0 ? (
            <Button
              kind="secondary"
              label={t('import.tags.sameAsMine', { count: pendingTagSuggestions(plan) })}
              onPress={() => setStep({ ...step, plan: applyTagSuggestions(plan) })}
              testID="import-tags-same"
            />
          ) : null}
          {plan.tags.map((entry) => (
            <TagMappingRow key={entry.source.key} entry={entry} myTags={myTags} onChange={(a) => setStep({ ...step, plan: setTagAction(plan, entry.source.key, a) })} />
          ))}
        </>
      ) : null}
      <Button label={t('import.confirm', { count })} disabled={count === 0} onPress={() => onConfirm(plan)} testID="import-confirm" />
    </View>
  );
}

export default function ImportRoute() {
  return (
    <DataGate>
      <ImportScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  p: { fontSize: 15 },
  big: { fontSize: 20, fontWeight: '700' },
  small: { fontSize: 13 },
  busy: { alignItems: 'stretch', gap: 14, paddingVertical: 40 },
});
