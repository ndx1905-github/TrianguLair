/**
 * QR scanning on Android with the local module `modules/tl-qr-scanner`: a CameraX preview whose
 * frames are decoded by ZXing (Apache-2.0). expo-camera is not linked on Android
 * (package.json `expo.autolinking.android.exclude`): its scanner is ML Kit, a proprietary Google
 * library that F-Droid does not accept. See ScannerFrame for the shared frame.
 */
import type { ComponentType } from 'react';
import { PermissionsAndroid, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeView } from 'expo';

import { ScannerFrame } from './ScannerFrame';

interface QrScannerViewProps {
  style?: StyleProp<ViewStyle>;
  onCodeScanned?: (e: { nativeEvent: { data: string } }) => void;
  onMountError?: (e: { nativeEvent: { message: string } }) => void;
}

let view: ComponentType<QrScannerViewProps> | null | undefined;

function qrScannerView(): ComponentType<QrScannerViewProps> | null {
  if (view === undefined) {
    try {
      view = requireNativeView<QrScannerViewProps>('TlQrScanner');
    } catch {
      view = null;
    }
  }
  return view;
}

async function requestCamera(): Promise<boolean> {
  if (!qrScannerView()) return false;
  const camera = PermissionsAndroid.PERMISSIONS.CAMERA;
  if (await PermissionsAndroid.check(camera)) return true;
  return (await PermissionsAndroid.request(camera)) === PermissionsAndroid.RESULTS.GRANTED;
}

export function Scanner({ onScanned, testID }: { onScanned: (text: string) => void; testID: string }) {
  return (
    <ScannerFrame
      onScanned={onScanned}
      testID={testID}
      requestPermission={requestCamera}
      renderCamera={({ onCode, onError }) => {
        const QrScannerView = qrScannerView();
        if (!QrScannerView) return null;
        return (
          <QrScannerView
            style={{ flex: 1 }}
            onCodeScanned={(e) => onCode(e.nativeEvent.data)}
            onMountError={(e) => {
              console.warn('QR scanner:', e.nativeEvent.message);
              onError();
            }}
          />
        );
      }}
    />
  );
}
