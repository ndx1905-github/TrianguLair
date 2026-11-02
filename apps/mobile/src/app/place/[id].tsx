import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DataGate } from '../../components/DataGate';
import { PlaceOrZoneCard as PlaceCard } from '../../zones/ZoneCard';
import { ScreenHeader } from '../../components/ScreenHeader';
import { Button } from '../../components/ui';
import { useLayout } from '../../hooks/useLayout';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useAppState } from '../../state/AppState';

/** Full-screen place card (from the list on phones, and after adding a place). */
function PlaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useUiColors();
  const { t } = useI18n();
  const { gutter } = useLayout();
  const insets = useSafeAreaInsets();
  const { focusPlace } = useAppState();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  return (
    <View style={{ flex: 1, backgroundColor: c.surface }}>
      <ScreenHeader title={t('card.title')} onBack={back} />
      <ScrollView
        contentContainerStyle={{ paddingTop: gutter + 4, paddingLeft: gutter + 4 + insets.left, paddingRight: gutter + 4 + insets.right, paddingBottom: insets.bottom + 32, alignItems: 'center' }}
        keyboardShouldPersistTaps="handled"
      >
        {/* A readable column on tablets and unfolded foldables, not a stretched phone layout. */}
        <View style={{ width: '100%', maxWidth: 680 }}>
        <PlaceCard placeId={String(id)} onDeleted={back} />
        <View style={{ marginTop: 12 }}>
          <Button kind="secondary" label={t('card.showOnMap')} onPress={() => {
              focusPlace(String(id));
              if (router.canDismiss()) router.dismissAll();
              else router.replace('/');
            }} />
        </View>
        </View>
      </ScrollView>
    </View>
  );
}

export default function PlaceRoute() {
  return (
    <DataGate>
      <PlaceScreen />
    </DataGate>
  );
}
