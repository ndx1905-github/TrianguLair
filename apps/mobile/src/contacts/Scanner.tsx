/**
 * QR scanning with expo-camera (`CameraView` with QR barcodes): native cameras on iOS and
 * Android; on web the browser camera and its BarcodeDetector (or expo-camera's polyfill) when
 * available. The camera opens only when asked; a paste field is always offered next to it by the
 * screens, since the web build often has no camera.
 */
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { Button } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

export function Scanner({ onScanned, testID }: { onScanned: (text: string) => void; testID: string }) {
  const c = useUiColors();
  const { t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const done = useRef(false);

  const start = async () => {
    done.current = false;
    setFailed(false);
    try {
      const p = permission?.granted ? permission : await requestPermission();
      if (p.granted) setOpen(true);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
  };

  return (
    <View style={{ gap: 8 }} testID={testID}>
      {open ? (
        <>
          <View style={{ width: '100%', maxWidth: 420, aspectRatio: 1, alignSelf: 'center', borderRadius: 14, overflow: 'hidden', backgroundColor: '#000' }}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={(r) => {
                if (done.current || !r.data) return;
                done.current = true;
                setOpen(false);
                onScanned(r.data);
              }}
              onMountError={() => {
                setOpen(false);
                setFailed(true);
              }}
            />
          </View>
          <Button kind="secondary" label={t('contacts.scan.stop')} onPress={() => setOpen(false)} testID={`${testID}-stop`} />
        </>
      ) : (
        <Button kind="secondary" label={t('contacts.scan.start')} onPress={() => void start()} testID={`${testID}-start`} />
      )}
      {failed && (
        <Text style={{ color: c.textMuted, fontSize: 14 }} maxFontSizeMultiplier={2} testID={`${testID}-unavailable`}>
          {t('contacts.scan.unavailable')}
        </Text>
      )}
    </View>
  );
}
