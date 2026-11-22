/**
 * The scanner's frame, shared by the platforms: a "Scan with the camera" button, the square
 * preview once the permission is granted, "Stop", and a note when no camera can be used. Each
 * platform gives the permission request and the camera view:
 * - `Scanner.tsx` (iOS, web): expo-camera;
 * - `Scanner.android.tsx`: the local module `modules/tl-qr-scanner` (CameraX + ZXing, no ML Kit).
 * The camera opens only when asked; the screens always offer a paste field next to it.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import { Button } from '../components/ui';
import { useUiColors } from '../hooks/useUiColors';
import { useI18n } from '../i18n';

export interface CameraSlot {
  /** The first code read (later ones are ignored). */
  onCode: (text: string) => void;
  /** The camera could not be opened. */
  onError: () => void;
}

export function ScannerFrame({
  onScanned,
  testID,
  requestPermission,
  renderCamera,
}: {
  onScanned: (text: string) => void;
  testID: string;
  /** Resolves to true when the camera may be used (asks if needed). */
  requestPermission: () => Promise<boolean>;
  renderCamera: (slot: CameraSlot) => ReactNode;
}) {
  const c = useUiColors();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const done = useRef(false);

  const start = async () => {
    done.current = false;
    setFailed(false);
    try {
      if (await requestPermission()) setOpen(true);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
  };

  const slot: CameraSlot = {
    onCode: (text) => {
      if (done.current || !text) return;
      done.current = true;
      setOpen(false);
      onScanned(text);
    },
    onError: () => {
      setOpen(false);
      setFailed(true);
    },
  };

  return (
    <View style={{ gap: 8 }} testID={testID}>
      {open ? (
        <>
          <View
            style={{ width: '100%', maxWidth: 420, aspectRatio: 1, alignSelf: 'center', borderRadius: 14, overflow: 'hidden', backgroundColor: '#000' }}
            testID={`${testID}-preview`}
          >
            {renderCamera(slot)}
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
