/**
 * A list I follow by link (T-212): its places (map and rows), its author, its date, "This list no
 * longer exists" / "This link no longer works" when it is gone, and "Unfollow" (its places leave
 * my cache now; my other devices follow through the vault).
 */
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { DataGate } from '../../../components/DataGate';
import { Banner, Button } from '../../../components/ui';
import { useContacts } from '../../../contacts/ContactsProvider';
import { useData } from '../../../data/DataProvider';
import { useUiColors } from '../../../hooks/useUiColors';
import { useI18n } from '../../../i18n';
import { ListPlacesView } from '../../../lists/ListPlacesView';
import { authorLabel, goneKey } from '../../../lists/sharing';
import { useSync } from '../../../sync/SyncProvider';

function FollowedListScreen() {
  const { id: raw } = useLocalSearchParams<{ id: string }>();
  const id = decodeURIComponent(String(raw));
  const { t, locale } = useI18n();
  const c = useUiColors();
  const router = useRouter();
  const sync = useSync();
  const svc = useContacts();
  const { repo, version } = useData();
  const ctl = sync.controller();
  const info = (ctl ? ctl.followedLists() : []).find((l) => l.id === id) ?? null;
  const placeIds = useMemo(
    () => repo.db.all<{ place_id: string }>(`SELECT place_id FROM saves WHERE owner_id = ? AND deleted_at IS NULL`, [id]).map((r) => r.place_id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, id, version],
  );
  const [confirm, setConfirm] = useState(false);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/lists/followed'));
  const author = info ? authorLabel(t, { owner: info.owner, declared: info.author, contactName: svc?.contact(info.owner)?.name || undefined }) : '';
  const date = (iso: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));

  const header = (
    <View style={{ gap: 8 }}>
      {!info && <Text style={{ color: c.textMuted, fontSize: 15 }}>{t('followed.notFollowed')}</Text>}
      {info && (
        <>
          <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} testID="followed-list-meta">
            {[author, t('filters.places', { count: info.count }), info.updated ? t('follow.updated', { date: date(info.updated) }) : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {info.description ? (
            <Text style={{ color: c.text, fontSize: 15 }} maxFontSizeMultiplier={2}>
              {info.description}
            </Text>
          ) : null}
          {info.gone && (
            <Banner tone="warning" testID={`followed-gone-${info.gone}`}>
              {`${t(goneKey(info.gone))}\n${t('sharing.gone.askNew')}`}
            </Banner>
          )}
          {confirm ? (
            <View style={{ gap: 8 }}>
              <Banner>{t('followed.unfollowHelp')}</Banner>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Button label={t('followed.unfollow')} onPress={() => void ctl?.unfollowList(id).then(back)} testID="followed-unfollow-confirm" />
                <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirm(false)} />
              </View>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button kind="secondary" label={t('followed.refresh')} onPress={() => void sync.refresh()} testID="followed-refresh" />
              <Button kind="secondary" label={t('followed.unfollow')} onPress={() => setConfirm(true)} testID="followed-unfollow" />
            </View>
          )}
        </>
      )}
    </View>
  );

  return <ListPlacesView title={info?.name || t('followed.title')} owner={id} placeIds={placeIds} header={header} onBack={back} testID="followed-list" />;
}

export default function FollowedListRoute() {
  return (
    <DataGate>
      <FollowedListScreen />
    </DataGate>
  );
}
