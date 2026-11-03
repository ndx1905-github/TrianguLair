import { useLocalSearchParams } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { ListEditor } from '../../lists/ListEditor';

/** New list, or `?id=` to edit one (T-112). */
export default function ListEditRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return (
    <DataGate>
      <ListEditor key={id ?? 'new'} listId={id ? String(id) : null} />
    </DataGate>
  );
}
