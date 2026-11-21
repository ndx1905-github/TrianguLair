/**
 * "Delete all my content" in progress, then its summary (or the error, with "Try again"); shown instead of the
 * whole app, since the database closes underneath. "Start again" reloads the app on a blank device.
 */
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { reloadAppAsync } from 'expo';

import { Banner, Button } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import type { DeleteAllSummary, DeleteStep } from './deleteAll';

export type ErasePhase = { kind: 'running'; step: DeleteStep } | { kind: 'done'; summary: DeleteAllSummary } | { kind: 'failed'; message: string };

function restart() {
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.assign(window.location.pathname.replace(/[^/]*$/, ''));
  else void reloadAppAsync('content deleted').catch(() => {});
}

export function ContentDeleted({ phase, onRetry, onBack }: { phase: ErasePhase; onRetry: () => void; onBack: () => void }) {
  const c = useUiColors();
  const { t } = useI18n();
  const line = (text: string, testID?: string) => (
    <Text style={[styles.body, { color: c.text }]} maxFontSizeMultiplier={2} testID={testID}>
      {text}
    </Text>
  );
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.root} testID="content-deleted">
      <View style={styles.column}>
        {phase.kind === 'running' && (
          <>
            <ActivityIndicator color={c.accent} size="large" />
            <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
              {t('deleteAll.running')}
            </Text>
            {line(t(`deleteAll.step.${phase.step}`), 'delete-all-step')}
          </>
        )}
        {phase.kind === 'failed' && (
          <>
            <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
              {t('deleteAll.failedTitle')}
            </Text>
            <Banner tone="warning" testID="delete-all-failed">
              {t('deleteAll.failed')}
            </Banner>
            <Button label={t('deleteAll.retry')} onPress={onRetry} testID="delete-all-retry" />
            <Button kind="secondary" label={t('common.back')} onPress={onBack} testID="delete-all-back" />
          </>
        )}
        {phase.kind === 'done' && (
          <>
            <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" maxFontSizeMultiplier={2}>
              {t('deleteAll.doneTitle')}
            </Text>
            <View style={styles.list} testID="delete-all-summary">
              {line(t('deleteAll.sum.places', { count: phase.summary.places }))}
              {phase.summary.zones > 0 && line(t('deleteAll.sum.zones', { count: phase.summary.zones }))}
              {line(t('deleteAll.sum.tagsLists', { tags: phase.summary.tags, lists: phase.summary.lists }))}
              {line(t('deleteAll.sum.contacts', { count: phase.summary.contacts }))}
              {phase.summary.invitations > 0 && line(t('deleteAll.sum.invitations', { count: phase.summary.invitations }))}
              {phase.summary.followedLists > 0 && line(t('deleteAll.sum.followed', { count: phase.summary.followedLists }))}
              {phase.summary.storage
                ? line(t('deleteAll.sum.files', { count: phase.summary.filesDeleted }), 'delete-all-files')
                : line(t('deleteAll.sum.localOnly'))}
              {phase.summary.storage && line(t('deleteAll.sum.marker', { count: phase.summary.filesKept }))}
              {phase.summary.listingUnsupported && line(t('deleteAll.sum.noListing'))}
              {line(t('deleteAll.sum.device'))}
            </View>
            {phase.summary.filesFailed.length > 0 && (
              <Banner tone="warning" testID="delete-all-leftovers">
                {t('deleteAll.sum.failed', { count: phase.summary.filesFailed.length, files: phase.summary.filesFailed.slice(0, 5).join(', ') })}
              </Banner>
            )}
            <Banner testID="delete-all-kit">{t('deleteAll.sum.kit')}</Banner>
            <Button label={t('deleteAll.startAgain')} onPress={restart} testID="delete-all-restart" />
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  column: { width: '100%', maxWidth: 560, gap: 16 },
  title: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 16 },
  list: { gap: 6 },
});
