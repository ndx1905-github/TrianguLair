/**
 * Sharing one of my lists (T-211, T-212; spec "Creating a sharing list", "Viewing without the
 * app", "Encrypted sharing"):
 *
 * - **Link only**: "Create the link" makes the list's key and publishes (the link works the moment
 *   it is handed out), then the link `https://example.org/l#…` (the key is after the `#`,
 *   never sent to a server), its QR code, share / copy; "New link" cuts everyone who has the old
 *   one; "Stop sharing by link".
 * - **Public**: a warning first (anyone can read it, the author is responsible, places that look
 *   like a home; confirming publishes those of a filter list as explicit "include"s), the places
 *   a public filter list holds back because they look like a home (publish them or leave them out,
 *   review M-02), then the address of the GeoJSON file on my storage, "View on uMap" (a uMap map
 *   that imports the file) and the in-app link to follow it.
 * - **Details**: whether link-only and public lists show my tag names (off by default; dates are
 *   always rounded to the day: review L-03). One setting for all my lists, kept in my vault.
 * - **Friends**: pick who sees this list (its name and places) among my contacts.
 *
 * Everything here needs a storage: the "storage needed" card goes through
 * `useStorageForSharing().ensure()` and comes back here.
 */
import { useMemo, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { umapUrl } from '@triangulair/sync';

import { DataGate } from '../../components/DataGate';
import { Banner, Button, Segmented } from '../../components/ui';
import { shareMessage } from '../../contacts/links';
import { Card, LinkActions, QrCode, Strong } from '../../contacts/ui';
import { useData } from '../../data/DataProvider';
import { ToggleRow } from '../../firstLaunch/ToggleRow';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { HomeConfirm, PublicWarning } from '../../lists/PublicWarning';
import { buildListLink, confirmInFilter, homeLikePlaces } from '../../lists/sharing';
import { useListPlaceIds } from '../../lists/useListData';
import { Muted, Section, StorageScreen } from '../../storage/components';
import { StorageNeeded, useStorageForSharing } from '../../storage/useStorageForSharing';
import { useSync } from '../../sync/SyncProvider';

type Busy = null | 'link' | 'new' | 'remove' | 'public' | 'private';

function ShareListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const listId = String(id);
  const c = useUiColors();
  const { t, locale } = useI18n();
  const router = useRouter();
  const { repo, version, mutate } = useData();
  const sync = useSync();
  const ctl = sync.controller();
  const storage = useStorageForSharing();
  const list = useMemo(() => repo.getList(listId), [repo, listId, version]);
  const placeIds = useListPlaceIds(list ? list.id : null);
  const places = useMemo(() => placeIds.map((p) => repo.getPlace(p)).filter((p): p is NonNullable<typeof p> => !!p), [placeIds, repo, version]);
  const [busy, setBusy] = useState<Busy>(null);
  const [failed, setFailed] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [confirmPublic, setConfirmPublic] = useState(false);
  const here = `/lists/share?id=${encodeURIComponent(listId)}`;

  if (!list) {
    return (
      <StorageScreen title={t('sharing.titleShort')} testID="share-list-screen">
        <Muted>{t('lists.notFound')}</Muted>
      </StorageScreen>
    );
  }
  const engineReady = !!sync.snapshot?.ready && !!ctl;
  const fragment = engineReady ? ctl!.listLink(list.id) : null;
  const link = fragment ? buildListLink(fragment) : null;
  const pub = engineReady && list.visibility === 'public' ? ctl!.publicList(list.id) : null;
  const friends = (sync.snapshot?.friends ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const viewers = new Set(engineReady ? ctl!.listViewers(list.id) : []);
  const held = engineReady && list.visibility === 'public' && list.kind === 'filter' ? ctl!.heldPublic(list.id) : [];

  const run = async (what: Busy, fn: () => Promise<unknown>) => {
    setBusy(what);
    setFailed(false);
    try {
      await fn();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  const reason = list.visibility === 'public' ? 'public-list' : 'link-list';
  const connected = storage.loaded && storage.connected;

  return (
    <StorageScreen title={t('sharing.title', { name: list.name })} testID="share-list-screen">
      {storage.loaded && !storage.connected && <StorageNeeded reason={reason} returnTo={here} />}

      <Section title={t('sharing.how')}>
        <Segmented
          options={[
            { value: 'link' as const, label: t('lists.visibility.link') },
            { value: 'public' as const, label: t('lists.visibility.public') },
          ]}
          value={confirmPublic ? 'public' : list.visibility}
          onChange={(v) => {
            if (!storage.ensure(v === 'public' ? 'public-list' : 'link-list', here)) return;
            if (v === 'public' && list.visibility !== 'public') setConfirmPublic(true);
            else if (v === 'link' && list.visibility !== 'link') {
              setConfirmPublic(false);
              void run('private', () => ctl!.setListVisibility(list.id, 'link'));
            } else setConfirmPublic(false);
          }}
          testID="share-visibility"
        />
        <Muted>{list.visibility === 'public' ? t('sharing.public.lead') : t('sharing.link.lead')}</Muted>
        {confirmPublic && (
          <PublicWarning
            places={places}
            busy={busy !== null}
            onCancel={() => setConfirmPublic(false)}
            onConfirm={() =>
              void run('public', async () => {
                // Confirmed here, with the places listed: a filter list publishes them (M-02).
                const homes = homeLikePlaces(places).map((p) => p.id);
                if (list.kind === 'filter' && homes.length) mutate((s) => s.setListFilter(list.id, confirmInFilter(list.filter, homes, true)));
                await ctl!.setListVisibility(list.id, 'public');
                setConfirmPublic(false);
              })
            }
            testID="share-public-warning"
          />
        )}
      </Section>

      {busy !== null && <Banner testID="share-busy">{t('sharing.publishing')}</Banner>}
      {failed && (
        <Banner tone="warning" testID="share-failed">
          {t('sharing.failed')}
        </Banner>
      )}

      {list.visibility === 'link' && !confirmPublic && (
        <Section title={t('sharing.link.title')}>
          {!link ? (
            <>
              <Muted>{t('sharing.link.none')}</Muted>
              <Button
                label={t('sharing.link.create')}
                disabled={busy !== null || (connected && !engineReady)}
                onPress={() => {
                  if (!storage.ensure('link-list', here)) return;
                  void run('link', () => ctl!.newListLink(list.id));
                }}
                testID="share-create-link"
              />
            </>
          ) : (
            <Card testID="share-link-ready">
              <Strong>{t('sharing.link.ready')}</Strong>
              <QrCode value={link} testID="share-qr" label={t('sharing.link.qrLabel')} />
              <LinkActions link={link} message={shareMessage(t('sharing.link.sentence', { name: list.name }), link)} testID="share-link" />
              <Muted>{t('sharing.link.help')}</Muted>
              {confirmNew ? (
                <View style={{ gap: 8 }} testID="share-new-confirm">
                  <Banner tone="warning">{t('sharing.link.newWarning')}</Banner>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    <Button
                      label={t('sharing.link.newConfirm')}
                      disabled={busy !== null}
                      onPress={() =>
                        void run('new', async () => {
                          await ctl!.newListLink(list.id);
                          setConfirmNew(false);
                        })
                      }
                      testID="share-new-link-confirm"
                    />
                    <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirmNew(false)} testID="share-new-link-cancel" />
                  </View>
                </View>
              ) : (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Button kind="secondary" label={t('sharing.link.new')} disabled={busy !== null} onPress={() => setConfirmNew(true)} testID="share-new-link" />
                  <Button kind="secondary" label={t('sharing.link.remove')} disabled={busy !== null} onPress={() => void run('remove', () => ctl!.removeListLink(list.id))} testID="share-remove-link" />
                </View>
              )}
            </Card>
          )}
        </Section>
      )}

      {held.length > 0 && busy !== 'public' && (
        <Section title={t('sharing.public.heldTitle')}>
          <Muted>{t('sharing.public.heldLead')}</Muted>
          <HomeConfirm
            places={held}
            busy={busy !== null}
            confirmLabel={t('sharing.public.heldPublish')}
            cancelLabel={t('sharing.public.heldLeaveOut')}
            onConfirm={() => void run('public', () => ctl!.decideHeld(list.id, held.map((p) => p.id), true))}
            onCancel={() => void run('public', () => ctl!.decideHeld(list.id, held.map((p) => p.id), false))}
            testID="share-held"
          />
        </Section>
      )}

      {list.visibility === 'public' && pub && busy !== 'public' && (
        <Section title={t('sharing.public.title')}>
          <Card testID="share-public-ready">
            <Strong>{t('sharing.public.file')}</Strong>
            <LinkActions link={pub.file} message={shareMessage(t('sharing.public.sentence', { name: list.name }), pub.file)} testID="share-public-file" />
            <Button label={t('sharing.public.umap')} onPress={() => void Linking.openURL(umapUrl(pub.file, { lang: locale }))} testID="share-umap" />
            <Text selectable style={{ color: c.textMuted, fontSize: 12 }} maxFontSizeMultiplier={1.6} testID="share-umap-url" numberOfLines={2}>
              {umapUrl(pub.file, { lang: locale })}
            </Text>
            <Muted>{t('sharing.public.umapHelp')}</Muted>
          </Card>
          <Card testID="share-public-follow">
            <Strong>{t('sharing.public.appLink')}</Strong>
            <LinkActions link={buildListLink(pub.fragment)} message={shareMessage(t('sharing.public.sentence', { name: list.name }), buildListLink(pub.fragment))} testID="share-public-link" />
          </Card>
        </Section>
      )}

      {(link || (list.visibility === 'public' && pub)) && (
        <Section title={t('sharing.details.title')}>
          <ToggleRow
            label={t('sharing.details.tagNames')}
            help={t('sharing.details.tagNamesHelp')}
            value={ctl!.publicTagNames()}
            disabled={!connected || busy !== null}
            onChange={(on) => void run('public', () => ctl!.setPublicTagNames(on))}
            testID="share-tag-names"
          />
        </Section>
      )}

      <Section title={t('sharing.friends.title')}>
        <Muted>{t('sharing.friends.lead')}</Muted>
        {friends.length === 0 ? (
          <>
            <Muted testID="share-no-friends">{t('sharing.friends.none')}</Muted>
            <Button kind="secondary" label={t('sharing.friends.invite')} onPress={() => router.push('/invite')} testID="share-invite" />
          </>
        ) : (
          friends.map((f) => (
            <ToggleRow
              key={f.owner}
              label={f.name || t('card.aFriend')}
              help={f.share === true ? t('sharing.friends.seesAll') : undefined}
              value={viewers.has(f.owner)}
              disabled={!connected}
              onChange={(on) => void ctl?.setListAccess(list.id, f.owner, on)}
              testID={`share-friend-${f.owner}`}
            />
          ))
        )}
      </Section>
    </StorageScreen>
  );
}

export default function ShareListRoute() {
  return (
    <DataGate>
      <ShareListScreen />
    </DataGate>
  );
}
