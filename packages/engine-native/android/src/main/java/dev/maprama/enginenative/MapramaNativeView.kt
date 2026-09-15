package dev.maprama.enginenative

import android.content.pm.ApplicationInfo
import android.graphics.PointF
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.widget.FrameLayout
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.uimanager.ThemedReactContext
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapLibreMapOptions
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style

/**
 * Hosts a MapLibre `MapView` (official Android SDK, M1, TextureView mode) and owns one native engine
 * registered under the `engineId` prop. Implements the core's map adapter ([MapramaMapHost]): every call
 * is posted to the main thread and applied once the map is ready; replies go back through [MapramaJni].
 */
class MapramaNativeView(private val reactContext: ThemedReactContext) :
  FrameLayout(reactContext),
  MapramaMapHost,
  LifecycleEventListener {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val density = resources.displayMetrics.density
  private val mapView: MapView
  private var map: MapLibreMap? = null
  private val pendingOnMap = ArrayList<(MapLibreMap) -> Unit>()
  private var handle = 0L
  private var engineId: String? = null
  private var viewportWidth = 0
  private var viewportHeight = 0
  private var destroyed = false

  init {
    MapLibre.getInstance(reactContext)
    val options = MapLibreMapOptions.createFromAttributes(reactContext).textureMode(true)
    mapView = MapView(reactContext, options)
    addView(mapView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    mapView.onCreate(null)
    mapView.onStart()
    mapView.onResume()
    reactContext.addLifecycleEventListener(this)
    mapView.getMapAsync { m -> onMapReady(m) }
  }

  // ---- React Native props / lifecycle --------------------------------------------------------------

  fun setEngineId(id: String?) {
    if (id.isNullOrEmpty() || id == engineId || destroyed) return
    stopEngine()
    engineId = id
    val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    handle = MapramaJni.create(id, this, debuggable)
    pushViewport()
    MapramaJni.start(handle)
  }

  fun destroy() {
    if (destroyed) return
    destroyed = true
    stopEngine()
    reactContext.removeLifecycleEventListener(this)
    mainHandler.removeCallbacksAndMessages(null)
    pendingOnMap.clear()
    map = null
    mapView.onPause()
    mapView.onStop()
    mapView.onDestroy()
  }

  private fun stopEngine() {
    if (handle == 0L) return
    MapramaJni.destroy(handle)
    handle = 0L
  }

  override fun onHostResume() {
    if (!destroyed) mapView.onResume()
  }

  override fun onHostPause() {
    if (!destroyed) mapView.onPause()
  }

  override fun onHostDestroy() {
    destroy()
  }

  // ---- Layout: Fabric positions this view but never measures its native children -----------------

  private val measureAndLayout = Runnable {
    measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    layout(left, top, right, bottom)
  }

  override fun requestLayout() {
    super.requestLayout()
    post(measureAndLayout)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    mapView.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    mapView.layout(0, 0, w, h)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    pushViewport()
  }

  private fun pushViewport() {
    if (handle == 0L || width <= 0 || height <= 0) return
    if (width == viewportWidth && height == viewportHeight) return
    viewportWidth = width
    viewportHeight = height
    MapramaJni.setViewport(handle, width / density.toDouble(), height / density.toDouble(), density.toDouble())
  }

  // ---- Map ---------------------------------------------------------------------------------------

  private fun onMapReady(m: MapLibreMap) {
    if (destroyed) return
    map = m
    m.uiSettings.isRotateGesturesEnabled = true
    m.uiSettings.isTiltGesturesEnabled = true
    m.setMinPitchPreference(0.0)
    m.setMaxPitchPreference(60.0)
    m.addOnCameraMoveListener { reportCamera() }
    m.addOnCameraIdleListener { reportCamera() }
    if (m.style == null && pendingOnMap.isEmpty()) m.setStyle(Style.Builder().fromJson(EMPTY_STYLE))
    val queued = ArrayList(pendingOnMap)
    pendingOnMap.clear()
    for (block in queued) block(m)
    reportCamera()
  }

  private fun reportCamera() {
    val m = map ?: return
    if (handle == 0L) return
    val position = m.cameraPosition
    val target = position.target ?: return
    MapramaJni.onCameraChanged(handle, target.longitude, target.latitude, position.zoom, position.tilt, position.bearing)
  }

  private fun onMap(block: (MapLibreMap) -> Unit) {
    mainHandler.post {
      if (destroyed) return@post
      val m = map
      if (m != null) block(m) else pendingOnMap.add(block)
    }
  }

  // ---- MapramaMapHost (called from libmaprama_engine.so) -----------------------------------------

  override fun setStyleJson(json: String) = onMap { m -> m.setStyle(Style.Builder().fromJson(json)) }

  override fun setCameraLimits(minZoom: Double, maxZoom: Double, minPitch: Double, maxPitch: Double) = onMap { m ->
    m.setMinZoomPreference(minZoom)
    m.setMaxZoomPreference(maxZoom)
    m.setMinPitchPreference(minPitch)
    m.setMaxPitchPreference(maxPitch)
  }

  override fun moveCamera(lng: Double, lat: Double, zoom: Double, pitch: Double, bearing: Double, durationMs: Double) =
    onMap { m ->
      val position = CameraPosition.Builder().target(LatLng(lat, lng)).zoom(zoom).tilt(pitch).bearing(bearing).build()
      val update = CameraUpdateFactory.newCameraPosition(position)
      if (durationMs > 0) m.easeCamera(update, durationMs.toInt()) else m.moveCamera(update)
    }

  override fun project(token: Long, lng: Double, lat: Double) = onMap { m ->
    val point = m.projection.toScreenLocation(LatLng(lat, lng))
    if (handle != 0L) MapramaJni.onProjected(handle, token, point.x / density.toDouble(), point.y / density.toDouble())
  }

  override fun unproject(token: Long, x: Double, y: Double) = onMap { m ->
    val coordinate = m.projection.fromScreenLocation(PointF((x * density).toFloat(), (y * density).toFloat()))
    if (handle != 0L) {
      val valid = !coordinate.latitude.isNaN() && !coordinate.longitude.isNaN()
      MapramaJni.onUnprojected(handle, token, valid, coordinate.longitude, coordinate.latitude)
    }
  }

  override fun fetchText(token: Long, url: String) {
    thread(name = "maprama-fetch", isDaemon = true) {
      var ok = false
      val body: String =
        try {
          val connection = URL(url).openConnection() as HttpURLConnection
          connection.connectTimeout = 15000
          connection.readTimeout = 30000
          try {
            val status = connection.responseCode
            if (status in 200..299) {
              ok = true
              connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            } else {
              "HTTP $status while loading $url"
            }
          } finally {
            connection.disconnect()
          }
        } catch (e: Exception) {
          "failed to load $url: ${e.message ?: e.javaClass.simpleName}"
        }
      mainHandler.post { if (handle != 0L) MapramaJni.onTextFetched(handle, token, ok, body) }
    }
  }

  override fun scheduleFrame(delayMs: Double) {
    mainHandler.postDelayed({
      if (handle != 0L) MapramaJni.frame(handle, SystemClock.uptimeMillis().toDouble())
    }, delayMs.toLong().coerceAtLeast(0L))
  }

  companion object {
    private const val EMPTY_STYLE =
      """{"version":8,"sources":{},"layers":[{"id":"background","type":"background","paint":{"background-color":"#E4DFD6"}}]}"""

    init {
      Log.i("MapramaEngine", "MapramaNativeView (M1, MapLibre Android SDK)")
    }
  }
}
