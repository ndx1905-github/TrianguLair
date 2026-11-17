/**
 * A friend's list shared with me (T-211: they gave me access to this list, "some lists" or picked
 * in its share sheet): its places, as of their last read.
 */
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { useContacts } from '../../contacts/ContactsProvider';
import { useData } from '../../data/DataProvider';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { ListPlacesView } from '../../lists/ListPlacesView';
import { useSync } from '../../sync/SyncProvider';

function FriendListScreen() {
  const { owner, list } = useLocalSearchParams<{ owner: string; list: string }>();
  const { t, locale } = useI18n();
  const c = useUiColors();
  const router = useRouter();
  const sync = useSync();
  const svc = useContacts();
  const { repo } = useData();
  const ctl = sync.controller();
  const def = (ctl ? ctl.friendLists() : []).find((f) => f.owner === owner)?.lists.find((l) => l.id === list) ?? null;
  const name = svc?.contact(String(owner))?.name || repo.getPerson(String(owner))?.displayName || '';
  const back = () => (router.canGoBack() ? router.back() : router.replace('/lists/followed'));
  const date = (iso: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
  const header = (
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} testID="friend-list-meta">
        {[name ? t('follow.by', { name }) : null, def ? t('filters.places', { count: def.items.length }) : null, def ? t('follow.updated', { date: date(def.updated) }) : null].filter(Boolean).join(' · ')}
      </Text>
      {def?.description ? (
        <Text style={{ color: c.text, fontSize: 15 }} maxFontSizeMultiplier={2}>
          {def.description}
        </Text>
      ) : null}
      {!def && <Text style={{ color: c.textMuted, fontSize: 15 }}>{t('followed.friendGone')}</Text>}
    </View>
  );
  return <ListPlacesView title={def?.name || t('followed.title')} owner={String(owner)} placeIds={def?.items ?? []} header={header} onBack={back} testID="friend-list" />;
}

export default function FriendListRoute() {
  return (
    <DataGate>
      <FriendListScreen />
    </DataGate>
  );
}
