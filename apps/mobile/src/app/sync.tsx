/**
 * Settings › Sync status (spec "Error cases"): last successful sync of my storage and of each person
 * I follow ("Updated 12 days ago"; after 3 months without an answer, keep or remove their places),
 * pending changes, the space used by content type (with suggestions when the storage is full), the
 * current problem in plain words with its action, "Sync now", and the local technical log (no
 * content, no keys).
 */
import { useEffect, useState } from 'react';
import type { SpaceUsed } from '@triangulair/sync';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DataGate } from '../components/DataGate';
import { ScreenHeader } from '../components/ScreenHeader';
import { Banner, Button, SectionTitle } from '../components/ui';
import { useLayout } from '../hooks/useLayout';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';
import { useStorage } from '../storage/StorageProvider';
import { Avatar } from '../sync/FriendsPicker';
import { agoText, friendNoteText, noteHelpKey, noteText } from '../sync/noteText';
import { formatBytes, friendNote, noteHref, ownNote, quotaTips, spaceRows } from '../sync/problems';
import { usePullToRefresh } from '../sync/usePullToRefresh';
import { useSync } from '../sync/SyncProvider';

function SyncScreen() {
  const c = useUiColors();
  const { t, locale } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { gutter } = useLayout();
  const sync = useSync();
  const storage = useStorage();
  const pull = usePullToRefresh();
  const [showLog, setShowLog] = useState(false);
  const [space, setSpace] = useState<SpaceUsed | null>(null);
  // "Sync now" waits for its pass (and the one queued after it, if any) before it can be pressed again.
  const [running, setRunning] = useState(false);
  const syncNow = () => {
    setRunning(true);
    void (status?.state === 'blocked' ? sync.resume() : sync.refresh()).finally(() => setRunning(false));
  };
  const snap = sync.snapshot;
  const now = Date.now();
  const status = snap?.status;
  const note = status && snap ? ownNote(status, snap.publishes) : null;
  const help = note ? noteHelpKey(note) : null;
  const cfg = storage.state.current;
  const lastOk = Math.max(status?.lastSuccess ?? 0, snap?.lastOwnSuccess ?? 0) || null;
  const ctl = sync.controller();
  // Space used: listed once the engine is ready, again after each successful pass of my storage.
  const spaceKey = `${snap?.publishes ? 1 : 0}:${lastOk ?? 0}:${note?.id ?? ''}`;
  useEffect(() => {
    let alive = true;
    if (!ctl || !snap?.publishes) return;
    void ctl.spaceUsed().then((s) => alive && setSpace(s));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl, spaceKey]);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScreenHeader title={t('sync.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <ScrollView
        contentContainerStyle={{ padding: gutter, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={c.accent} />}
        testID="sync-status"
      >
        <View style={styles.column}>
          <SectionTitle>{t('sync.mine')}</SectionTitle>
          {!cfg ? (
            <Text style={[styles.muted, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
              {t('sync.localOnly')}
            </Text>
          ) : (
            <View style={[styles.card, { borderColor: c.border, backgroundColor: c.surface }]}>
              {cfg.kind === 'https' && (
                <Text style={[styles.muted, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                  {t('sync.httpsOnly')}
                </Text>
              )}
              <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }} maxFontSizeMultiplier={2} testID="sync-state">
                {status ? t(`sync.state.${status.state === 'idle' && note ? 'idle' : status.state}`) : t('sync.state.syncing')}
              </Text>
              <Text style={[styles.muted, { color: c.textMuted }]} maxFontSizeMultiplier={2} testID="sync-last">
                {lastOk ? t('sync.lastSuccess', { when: agoText(now - lastOk, t) }) : t('sync.never')}
              </Text>
              {status && status.pending > 0 && (
                <Text style={[styles.muted, { color: c.textMuted }]} maxFontSizeMultiplier={2} testID="sync-pending">
                  {t('sync.pending', { count: status.pending })}
                </Text>
              )}
              {note && status && (
                <View style={{ gap: 8 }} testID={`sync-problem-${note.id}`}>
                  <Banner tone={note.tone === 'info' ? 'info' : 'warning'}>{noteText(note, status, t, locale, now)}</Banner>
                  {help && (
                    <Text style={[styles.muted, { color: c.text }]} maxFontSizeMultiplier={2}>
                      {t(help)}
                    </Text>
                  )}
                  {note.id === 'quota' &&
                    quotaTips(space).map((k) => (
                      <Text key={k} style={[styles.muted, { color: c.text }]} maxFontSizeMultiplier={2} testID="sync-quota-tip">
                        {`• ${t(k, space ? { size: formatBytes(k === 'sync.space.tipPhotos' ? space.photos : space.other, locale) } : {})}`}
                      </Text>
                    ))}
                </View>
              )}
              {space && space.total > 0 && (
                <View style={{ gap: 2 }} testID="sync-space">
                  <Text style={{ color: c.text, fontSize: 14, fontWeight: '600' }} maxFontSizeMultiplier={2}>
                    {t('sync.space.title', { size: formatBytes(space.total, locale) })}
                  </Text>
                  {spaceRows(space).map((r) => (
                    <Text key={r.kind} style={[styles.muted, { color: c.textMuted }]} maxFontSizeMultiplier={2} testID={`sync-space-${r.kind}`}>
                      {t('sync.space.row', { what: t(`sync.space.${r.kind}`), size: formatBytes(r.bytes, locale) })}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}
          <View style={styles.actions}>
            <Button label={running ? t('sync.state.syncing') : t('sync.now')} onPress={syncNow} disabled={running} testID="sync-now" />
            <Button
              kind={note?.action === 'storage' ? 'primary' : 'secondary'}
              label={note?.id === 'reconnect' ? t('sync.note.fix') : t('sync.openStorage')}
              onPress={() => router.push(note?.id === 'reconnect' ? noteHref(note) : '/storage')}
              testID="sync-storage"
            />
          </View>

          <SectionTitle>{t('sync.people')}</SectionTitle>
          {(snap?.friends.length ?? 0) === 0 ? (
            <Text style={[styles.muted, { color: c.textMuted }]} maxFontSizeMultiplier={2} testID="sync-no-people">
              {t('sync.noPeople')}
            </Text>
          ) : (
            snap!.friends.map((f) => {
              const n = friendNote(f.problem, f.lastSuccess, now, f.keptAt);
              const name = f.name || t('card.aFriend');
              return (
                <View key={f.owner} style={[styles.person, { borderColor: c.border, backgroundColor: c.surface }]} testID={`sync-person-${name}`}>
                  <Avatar name={name} uri={null} size={36} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: c.text, fontSize: 15, fontWeight: '700' }} maxFontSizeMultiplier={2}>
                      {name}
                    </Text>
                    <Text style={{ color: f.follow && n.tone === 'error' ? c.danger : f.follow && n.tone === 'warning' ? c.warning : c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2} testID="sync-person-note">
                      {f.follow ? friendNoteText(n, name, t) : t('sync.friend.notFollowed')}
                    </Text>
                    <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2}>
                      {[f.follow ? t('friends.picker.places', { count: f.places }) : null, f.share ? t('sync.friend.shares') : t('sync.friend.noShare')].filter(Boolean).join(' · ')}
                    </Text>
                    {f.follow && n.action === 'keep-or-remove' && ctl && (
                      <View style={styles.actions} testID="sync-person-stale">
                        <Button kind="secondary" label={t('sync.friend.keep')} onPress={() => ctl.keepFriend(f.owner)} testID="sync-person-keep" />
                        <Button kind="secondary" label={t('sync.friend.remove')} onPress={() => void ctl.setPolicy(f.owner, { follow: false })} testID="sync-person-remove" />
                      </View>
                    )}
                  </View>
                </View>
              );
            })
          )}

          <SectionTitle>{t('sync.log')}</SectionTitle>
          <Text style={[styles.muted, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {t('sync.logHint')}
          </Text>
          <Button kind="secondary" label={showLog ? t('friends.hide') : t('sync.log')} onPress={() => setShowLog(!showLog)} testID="sync-log-toggle" />
          {showLog && (
            <Text style={[styles.log, { color: c.textMuted, borderColor: c.border }]} selectable maxFontSizeMultiplier={1.6} testID="sync-log">
              {sync.log().join('\n') || t('sync.logEmpty')}
            </Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

export default function SyncRoute() {
  return (
    <DataGate>
      <SyncScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  column: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: 12 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 6 },
  muted: { fontSize: 14 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  log: { fontFamily: 'monospace', fontSize: 11, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8 },
});
