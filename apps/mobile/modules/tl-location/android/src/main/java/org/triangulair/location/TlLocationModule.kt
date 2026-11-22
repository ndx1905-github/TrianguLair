package org.triangulair.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

class LocationPermissionException :
  CodedException("E_LOCATION_PERMISSION", "The location permission is not granted", null)

/**
 * One position, on Android's own LocationManager (GPS, network, passive and, from Android 12,
 * the platform's fused provider), so that it works on phones without Google Play services
 * (F-Droid). No continuous tracking: a last known position, or one fresh fix with a timeout.
 * The permission is asked from JavaScript (PermissionsAndroid). See src/location/.
 */
class TlLocationModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val manager: LocationManager?
    get() = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager

  private val mainHandler = Handler(Looper.getMainLooper())
  private val mainExecutor = Executor { mainHandler.post(it) }

  override fun definition() = ModuleDefinition {
    Name("TlLocation")

    Function("hasPermission") { hasPermission() }

    /** Location turned on in the system settings, with at least one usable provider. */
    Function("isEnabled") {
      val m = manager ?: return@Function false
      val on = if (Build.VERSION.SDK_INT >= 28) m.isLocationEnabled else true
      on && activeProviders(m, includePassive = false).isNotEmpty()
    }

    Function("providers") {
      val m = manager ?: return@Function emptyList<String>()
      activeProviders(m, includePassive = true)
    }

    /** The newest last known position of all providers, if not older than maxAgeMs; else null. */
    Function("lastKnown") { maxAgeMs: Double ->
      if (!hasPermission()) throw LocationPermissionException()
      val m = manager ?: return@Function null
      bestLastKnown(m, maxAgeMs.toLong())?.toRecord()
    }

    /** One fresh position from the first provider that answers; null after timeoutMs. */
    AsyncFunction("current") { timeoutMs: Double, promise: Promise ->
      if (!hasPermission()) {
        promise.reject(LocationPermissionException())
        return@AsyncFunction
      }
      val m = manager
      if (m == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val providers = activeProviders(m, includePassive = true)
      mainHandler.post { SingleFix(m, providers, timeoutMs.toLong(), promise).start() }
    }
  }

  private fun hasPermission(): Boolean {
    val c = context
    return c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
      c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
  }

  /** The providers this device has and that are turned on, best first. */
  private fun activeProviders(m: LocationManager, includePassive: Boolean): List<String> {
    val wanted = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= 31) wanted.add(LocationManager.FUSED_PROVIDER)
    wanted.add(LocationManager.GPS_PROVIDER)
    wanted.add(LocationManager.NETWORK_PROVIDER)
    if (includePassive) wanted.add(LocationManager.PASSIVE_PROVIDER)
    val all = try {
      m.allProviders
    } catch (_: Exception) {
      emptyList<String>()
    }
    return wanted.filter { p ->
      p in all && try {
        m.isProviderEnabled(p)
      } catch (_: Exception) {
        false
      }
    }
  }

  private fun bestLastKnown(m: LocationManager, maxAgeMs: Long): Location? {
    val fixes = activeProviders(m, includePassive = true).mapNotNull { p ->
      try {
        m.getLastKnownLocation(p)
      } catch (_: SecurityException) {
        null // e.g. GPS with the approximate permission only
      } catch (_: IllegalArgumentException) {
        null
      }
    }.filter { ageMs(it) <= maxAgeMs }
    val newest = fixes.minByOrNull { ageMs(it) } ?: return null
    // Among the fixes of about the same time, the most precise.
    return fixes
      .filter { ageMs(it) - ageMs(newest) <= 60_000L && it.hasAccuracy() }
      .minByOrNull { it.accuracy } ?: newest
  }

  /** Asks every provider at once; the first fix wins, the others are cancelled. */
  private inner class SingleFix(
    private val m: LocationManager,
    private val providers: List<String>,
    private val timeoutMs: Long,
    private val promise: Promise
  ) {
    private val done = AtomicBoolean(false)
    private val signals = mutableListOf<CancellationSignal>()
    private val listeners = mutableListOf<LocationListener>()
    private var pending = 0
    private val timeout = Runnable { finish(null) }

    fun start() {
      for (p in providers) {
        try {
          if (Build.VERSION.SDK_INT >= 30) {
            val signal = CancellationSignal()
            m.getCurrentLocation(p, signal, mainExecutor) { location -> onFix(location) }
            signals.add(signal)
          } else {
            val listener = OneShotListener { location -> onFix(location) }
            @Suppress("DEPRECATION")
            m.requestLocationUpdates(p, 0L, 0f, listener, Looper.getMainLooper())
            listeners.add(listener)
          }
          pending++
        } catch (_: SecurityException) {
          // This provider needs the precise permission; the others may answer.
        } catch (_: IllegalArgumentException) {
          // The provider went away.
        }
      }
      if (pending == 0) {
        finish(null)
        return
      }
      mainHandler.postDelayed(timeout, timeoutMs)
    }

    /** getCurrentLocation gives null when a provider cannot get a fix in time. */
    private fun onFix(location: Location?) {
      if (location != null) {
        finish(location)
        return
      }
      pending--
      if (pending <= 0) finish(null)
    }

    private fun finish(location: Location?) {
      if (!done.compareAndSet(false, true)) return
      mainHandler.removeCallbacks(timeout)
      signals.forEach { it.cancel() }
      listeners.forEach {
        try {
          m.removeUpdates(it)
        } catch (_: Exception) {
        }
      }
      promise.resolve(location?.toRecord())
    }
  }

  /**
   * Before Android 11, LocationListener has no default methods: all four must be implemented,
   * or the system calls a missing method.
   */
  private class OneShotListener(private val onLocation: (Location) -> Unit) : LocationListener {
    override fun onLocationChanged(location: Location) = onLocation(location)
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
  }
}

private fun ageMs(location: Location): Long =
  (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000L

private fun Location.toRecord(): Map<String, Any?> = mapOf(
  "latitude" to latitude,
  "longitude" to longitude,
  "accuracy" to if (hasAccuracy()) accuracy.toDouble() else null,
  "ageMs" to ageMs(this).toDouble(),
  "provider" to provider
)
