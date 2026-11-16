/**
 * "Follow a list by link" (T-212, spec "Following a list without following the person"): paste a
 * list link (or open it: the `/l#…` deep link hands it over in memory), see the preview (map and
 * places, the author's name, the update date), then "Follow this list". No account, no request,
 * no key exchange: the link is enough. A link that no longer works or a deleted list says so, with
 * the suggestion to ask for a new link. The list is followed only once its first read worked; if
 * that read fails, nothing is kept and "Follow this list" stays there to try again (review L-05).
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { ListGoneError, ListLinkError, TooManyFollowedListsError, type ListPreview } from '@triangulair/sync';

import { DataGate } from '../../components/DataGate';
import { Banner, Button } from '../../components/ui';
import { takePendingLink } from '../../contacts/pending';
import { Card, PasteField, Strong } from '../../contacts/ui';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { categoryIdOf } from '../../lists/listLogic';
import { PreviewMap } from '../../lists/PreviewMap';
import { authorLabel, goneKey, listFragmentOf } from '../../lists/sharing';
import { useContacts } from '../../contacts/ContactsProvider';
import { categoryLabel } from '../../places/card';
import { Muted, Section, StorageScreen } from '../../storage/components';
import { useSync } from '../../sync/SyncProvider';

type Problem = 'deleted' | 'link-dead' | 'not-a-list' | 'mine' | 'unreachable' | 'too-many' | 'not-followed';

function FollowScreen() {
  const tr = useI18n();
  const { t, locale } = tr;
  const c = useUiColors();
  const router = useRouter();
  const sync = useSync();
  const ctl = sync.controller();
  const svc = useContacts();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ListPreview | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const engineReady = !!sync.snapshot?.ready && !!ctl;

  const open = async (value: string) => {
    const fragment = listFragmentOf(value);
    setPreview(null);
    setProblem(null);
    if (!fragment) {
      setProblem('not-a-list');
      return;
    }
    if (!ctl) return;
    setBusy(true);
    try {
      const p = await ctl.previewList(fragment);
      if (p.owner === ctl.owner()) setProblem('mine');
      else setPreview(p);
      setText(value);
    } catch (e) {
      setProblem(e instanceof ListGoneError ? e.gone : e instanceof ListLinkError ? 'not-a-list' : 'unreachable');
    } finally {
      setBusy(false);
    }
  };

  // A link opened from outside (deep link, QR code): in memory, never in the URL.
  const [pending] = useState(() => takePendingLink());
  useEffect(() => {
    if (!pending || !engineReady) return;
    setText(pending.text);
    void open(pending.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineReady]);

  const already = useMemo(() => (preview && ctl ? ctl.followedLists().some((l) => l.id === preview.id) : false), [preview, ctl, sync.snapshot]);

  const follow = async () => {
    if (!preview || !ctl) return;
    const fragment = listFragmentOf(text);
    if (!fragment) return;
    setFollowing(true);
    try {
      // Followed only once this first read worked (L-05): otherwise nothing is kept, try again.
      const r = await ctl.followList(fragment);
      if (r.status === 'gone') {
        setPreview(null);
        setProblem(r.gone ?? 'link-dead');
        return;
      }
      if (r.status === 'error') throw new Error('read failed');
      router.replace(`/lists/followed/${encodeURIComponent(preview.id)}` as Href);
    } catch (e) {
      setProblem(e instanceof TooManyFollowedListsError ? 'too-many' : 'not-followed');
    } finally {
      setFollowing(false);
    }
  };

  const date = (iso: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
  const sel = preview?.features.find((f) => f.id === selected) ?? null;

  return (
    <StorageScreen title={t('follow.title')} testID="follow-list-screen">
      <Section title={t('follow.link')}>
        <Muted>{t('follow.lead')}</Muted>
        <PasteField label={t('follow.link')} value={text} onChange={setText} onSubmit={() => void open(text)} action={t('follow.open')} busy={busy} disabled={!engineReady} testID="follow" />
        {problem && (
          <Banner tone="warning" testID={`follow-problem-${problem}`}>
            {problem === 'deleted' || problem === 'link-dead' ? `${t(goneKey(problem))}\n${t('sharing.gone.askNew')}` : t(`follow.problem.${problem}`)}
          </Banner>
        )}
      </Section>

      {preview && (
        <Section title={t('follow.preview')}>
          <Card testID="follow-preview">
            <Strong testID="follow-preview-name">{preview.name}</Strong>
            <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} testID="follow-preview-meta">
              {[
                authorLabel(t, { owner: preview.owner, declared: preview.author, contactName: svc?.contact(preview.owner)?.name || undefined }),
                t('filters.places', { count: preview.count }),
                preview.updated ? t('follow.updated', { date: date(preview.updated) }) : null,
                t(`follow.kind.${preview.kind}`),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {preview.description ? (
              <Text style={{ color: c.text, fontSize: 15 }} maxFontSizeMultiplier={2}>
                {preview.description}
              </Text>
            ) : null}
            <PreviewMap features={preview.features} selectedId={selected} onSelect={setSelected} />
            {sel && (
              <View style={[styles.sel, { borderColor: c.accent, backgroundColor: c.selectedBg }]} testID="follow-selected">
                <Text style={{ color: c.text, fontWeight: '700', fontSize: 15 }} maxFontSizeMultiplier={2}>
                  {sel.properties.name}
                </Text>
                {sel.properties.comment ? (
                  <Text style={{ color: c.text, fontSize: 14 }} maxFontSizeMultiplier={2}>
                    {sel.properties.comment}
                  </Text>
                ) : null}
              </View>
            )}
            <View style={{ gap: 6 }} testID="follow-places">
              {preview.features.map((f) => (
                <Pressable
                  key={f.id}
                  onPress={() => setSelected(f.id)}
                  style={[styles.row, { borderColor: selected === f.id ? c.accent : c.border, backgroundColor: c.surface }]}
                  accessibilityRole="button"
                  testID={`follow-place-${f.properties.name}`}
                >
                  <View style={styles.pills}>
                    {(f.properties.tags?.length ? f.properties.tags : [{ name: '', color: c.border }]).slice(0, 4).map((tag, i) => (
                      <View key={i} style={[styles.pill, { backgroundColor: tag.color ?? c.border }]} />
                    ))}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }} maxFontSizeMultiplier={2}>
                      {f.properties.kind === 'zone' ? `◱ ${f.properties.name}` : f.properties.name}
                    </Text>
                    <Text style={{ color: c.textMuted, fontSize: 13 }} maxFontSizeMultiplier={2} numberOfLines={2}>
                      {[(f.properties.tags ?? []).map((x) => x.name).join(', ') || categoryLabel(categoryIdOf(f.properties.category ?? null), tr), f.properties.status ? t(`status.${f.properties.status}`) : null, f.properties.comment || null]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
            {already ? (
              <>
                <Banner testID="follow-already">{t('follow.already')}</Banner>
                <Button label={t('follow.see')} onPress={() => router.replace(`/lists/followed/${encodeURIComponent(preview.id)}` as Href)} testID="follow-see" />
              </>
            ) : (
              <Button label={t('follow.follow')} onPress={() => void follow()} disabled={following} testID="follow-confirm" />
            )}
            <Muted>{t('follow.privacy')}</Muted>
          </Card>
        </Section>
      )}

      <Section title={t('followed.title')}>
        <Button kind="secondary" label={t('followed.open')} onPress={() => router.push('/lists/followed')} testID="follow-open-followed" />
      </Section>
    </StorageScreen>
  );
}

export default function FollowListRoute() {
  return (
    <DataGate>
      <FollowScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1 },
  pills: { flexDirection: 'row', gap: 3 },
  pill: { width: 8, height: 26, borderRadius: 4 },
  sel: { borderWidth: 1, borderRadius: 12, padding: 10, gap: 4 },
});
