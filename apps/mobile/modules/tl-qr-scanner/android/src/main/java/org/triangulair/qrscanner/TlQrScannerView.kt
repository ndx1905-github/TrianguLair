package org.triangulair.qrscanner

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Size
import android.view.ViewGroup
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@SuppressLint("ViewConstructor")
class TlQrScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onCodeScanned by EventDispatcher()
  private val onMountError by EventDispatcher()

  // The preview's own surface view is added and sized by Android, not by React Native.
  override val shouldUseAndroidLayout = true

  private val previewView = PreviewView(context).apply {
    scaleType = PreviewView.ScaleType.FILL_CENTER
    // A TextureView: clipped by the rounded parent like any other view.
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
  }
  private val mainHandler = Handler(Looper.getMainLooper())
  private val mainExecutor = Executor { mainHandler.post(it) }
  private var provider: ProcessCameraProvider? = null
  private var preview: Preview? = null
  private var analysis: ImageAnalysis? = null
  private var analyzerExecutor: ExecutorService? = null
  private var started = false
  private val reported = AtomicBoolean(false)

  init {
    addView(previewView, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    start()
  }

  override fun onDetachedFromWindow() {
    stop()
    super.onDetachedFromWindow()
  }

  private fun start() {
    if (started) return
    started = true
    val owner = appContext.currentActivity as? LifecycleOwner
    if (owner == null) {
      fail("No activity to attach the camera to")
      return
    }
    val future = try {
      ProcessCameraProvider.getInstance(context)
    } catch (e: Exception) {
      fail(e.message ?: e.javaClass.simpleName)
      return
    }
    future.addListener({
      if (!started) return@addListener
      try {
        bind(future.get(), owner)
      } catch (e: Exception) {
        fail("The camera could not be started: ${e.message ?: e.javaClass.simpleName}")
      }
    }, mainExecutor)
  }

  private fun bind(cameraProvider: ProcessCameraProvider, owner: LifecycleOwner) {
    // The back camera; a tablet or laptop may have only a front one.
    val selector = listOf(CameraSelector.DEFAULT_BACK_CAMERA, CameraSelector.DEFAULT_FRONT_CAMERA).firstOrNull {
      try {
        cameraProvider.hasCamera(it)
      } catch (_: Exception) {
        false
      }
    }
    if (selector == null) {
      fail("No camera on this device")
      return
    }
    val newPreview = Preview.Builder().build()
    newPreview.setSurfaceProvider(previewView.surfaceProvider)
    // About 720p is plenty for a QR code on a screen or on paper, and fast to decode.
    val resolution = ResolutionSelector.Builder()
      .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
      .build()
    val newAnalysis = ImageAnalysis.Builder()
      .setResolutionSelector(resolution)
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
      .build()
    val executor = Executors.newSingleThreadExecutor()
    newAnalysis.setAnalyzer(executor, QrAnalyzer { text -> mainHandler.post { found(text) } })
    cameraProvider.bindToLifecycle(owner, selector, newPreview, newAnalysis)
    provider = cameraProvider
    preview = newPreview
    analysis = newAnalysis
    analyzerExecutor = executor
  }

  private fun found(text: String) {
    if (!started || !reported.compareAndSet(false, true)) return
    onCodeScanned(mapOf("data" to text))
  }

  private fun fail(message: String) {
    mainHandler.post {
      if (started) onMountError(mapOf("message" to message))
    }
  }

  fun stop() {
    if (!started) return
    started = false
    analysis?.clearAnalyzer()
    try {
      val useCases = listOfNotNull(preview, analysis)
      if (useCases.isNotEmpty()) provider?.unbind(*useCases.toTypedArray())
    } catch (_: Exception) {
    }
    analyzerExecutor?.shutdown()
    provider = null
    preview = null
    analysis = null
    analyzerExecutor = null
  }
}
