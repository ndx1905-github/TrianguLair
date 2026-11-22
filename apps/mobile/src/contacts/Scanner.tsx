/**
 * QR scanning on iOS and web with expo-camera (`CameraView` with QR barcodes): the native camera
 * on iOS (AVFoundation, no ML Kit); on web the browser camera and its BarcodeDetector (or
 * expo-camera's polyfill) when available. Android uses `Scanner.android.tsx`. See ScannerFrame.
 */
import { CameraView, useCameraPermissions } from 'expo-camera';

import { ScannerFrame } from './ScannerFrame';

export function Scanner({ onScanned, testID }: { onScanned: (text: string) => void; testID: string }) {
  const [permission, requestPermission] = useCameraPermissions();
  return (
    <ScannerFrame
      onScanned={onScanned}
      testID={testID}
      requestPermission={async () => (permission?.granted ? true : (await requestPermission()).granted)}
      renderCamera={({ onCode, onError }) => (
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(r) => onCode(r.data)}
          onMountError={onError}
        />
      )}
    />
  );
}
