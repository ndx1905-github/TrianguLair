package org.triangulair.qrscanner

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * A camera preview that reports the first QR code it reads (`onCodeScanned` { data }), or
 * `onMountError` { message } when no camera can be opened. CameraX for the camera, ZXing for
 * decoding: no ML Kit, no Google Play services (F-Droid). The camera permission is asked from
 * JavaScript (PermissionsAndroid) before the view is shown. See src/contacts/Scanner.android.tsx.
 */
class TlQrScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TlQrScanner")

    View(TlQrScannerView::class) {
      Events("onCodeScanned", "onMountError")

      OnViewDestroys { view ->
        view.stop()
      }
    }
  }
}
