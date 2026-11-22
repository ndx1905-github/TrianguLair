package org.triangulair.qrscanner

import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/**
 * Decodes QR codes in camera frames with ZXing. Only the luminance (Y) plane of the
 * YUV_420_888 frame is used; QR codes read in any orientation, so the frame is not rotated.
 * Each frame is tried as is, then inverted (light code on a dark screen).
 */
class QrAnalyzer(private val onFound: (String) -> Unit) : ImageAnalysis.Analyzer {
  private val reader = QRCodeReader()
  private val hints = mapOf(
    DecodeHintType.TRY_HARDER to true,
    DecodeHintType.CHARACTER_SET to "UTF-8"
  )
  private var bytes = ByteArray(0)

  override fun analyze(image: ImageProxy) {
    try {
      val text = decodeFrame(image)
      if (text != null) onFound(text)
    } catch (_: Exception) {
      // A frame that cannot be read (e.g. an unexpected format): try the next one.
    } finally {
      image.close()
    }
  }

  private fun decodeFrame(image: ImageProxy): String? {
    val plane = image.planes.firstOrNull() ?: return null
    val width = image.width
    val height = image.height
    val rowStride = plane.rowStride
    if (plane.pixelStride != 1 || rowStride < width) return null
    val buffer = plane.buffer
    buffer.rewind()
    val needed = rowStride * height
    if (bytes.size < needed) bytes = ByteArray(needed)
    // The last row may be shorter than rowStride.
    buffer.get(bytes, 0, minOf(buffer.remaining(), needed))
    val source = PlanarYUVLuminanceSource(bytes, rowStride, height, 0, 0, width, height, false)
    return decode(source) ?: decode(source.invert())
  }

  private fun decode(source: LuminanceSource): String? = try {
    reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text
  } catch (_: ReaderException) {
    null
  } finally {
    reader.reset()
  }
}
