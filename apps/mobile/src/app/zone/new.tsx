import { useLocalSearchParams } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { ZoneEditor } from '../../zones/ZoneEditor';

/** New zone (T-110); `?purpose=list` draws an area for a list filter instead. */
export default function NewZoneRoute() {
  const { purpose } = useLocalSearchParams<{ purpose?: string }>();
  return (
    <DataGate>
      <ZoneEditor purpose={purpose === 'list' ? 'list' : 'save'} />
    </DataGate>
  );
}
