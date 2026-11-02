import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DataGate } from '../../components/DataGate';
import { ScreenHeader } from '../../components/ScreenHeader';
import { Banner, Button } from '../../components/ui';
import { useData } from '../../data/DataProvider';
import { useLayout } from '../../hooks/useLayout';
import { useUiColors } from '../../hooks/useUiColors';
import { useI18n } from '../../i18n';
import { useLists } from '../../lists/useListData';

/** My lists (T-112): name, kind, number of places, visibility. */
function ListsScreen() {
  const c = useUiColors();
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { gutter, wide } = useLayout();
  const { repo } = useData();
  const lists = useLists();

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <ScreenHeader
        title={t('lists.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        right={<Button label={`+ ${t('lists.new')}`} onPress={() => router.push('/lists/edit')} testID="new-list" />}
      />
      <FlatList
        data={lists}
        keyExtractor={(l) => l.id}
        style={{ alignSelf: 'center', width: '100%', maxWidth: wide ? 720 : undefined }}
        contentContainerStyle={{ padding: gutter, paddingBottom: insets.bottom + 24, gap: 8 }}
        ListHeaderComponent={
          <View style={{ marginBottom: 8 }}>
            <Banner>{t('lists.intro')}</Banner>
          </View>
        }
        renderItem={({ item }) => {
          const count = repo.listItems(item.id).length;
          return (
            <Pressable
              onPress={() => router.push({ pathname: '/lists/[id]', params: { id: item.id } })}
              style={({ pressed }) => [styles.row, { borderColor: c.border, backgroundColor: pressed ? c.surfaceAlt : c.surface }]}
              accessibilityRole="button"
              testID={`list-${item.name}`}
            >
              <Text style={[styles.icon, { color: c.accent }]} maxFontSizeMultiplier={1.5}>
                {item.kind === 'filter' ? '⚲' : '☑'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: c.text }]} maxFontSizeMultiplier={2}>
                  {item.name}
                </Text>
                <Text style={[styles.meta, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                  {[t(`lists.kind.${item.kind}`), t(`lists.visibility.${item.visibility}`)].join(' · ')}
                </Text>
              </View>
              <Text style={[styles.count, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
                {t('filters.places', { count })}
              </Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.textMuted }]} maxFontSizeMultiplier={2}>
            {t('lists.empty')}
          </Text>
        }
        testID="lists"
      />
    </View>
  );
}

export default function ListsRoute() {
  return (
    <DataGate>
      <ListsScreen />
    </DataGate>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  icon: { fontSize: 22, width: 28, textAlign: 'center' },
  name: { fontSize: 16, fontWeight: '700' },
  meta: { fontSize: 13, marginTop: 2 },
  count: { fontSize: 14, fontWeight: '600' },
  empty: { textAlign: 'center', marginTop: 32, fontSize: 15 },
});
