package dev.maprama.enginenative

import android.Manifest
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.PointF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.uimanager.ThemedReactContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import org.json.JSONTokener
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.gestures.MoveGestureDetector
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapLibreMapOptions
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.layers.CustomLayer
import org.maplibre.android.style.layers.PaintPropertyValue
import org.maplibre.android.style.light.Position
import org.maplibre.android.style.sources.GeoJsonSource

/**
 * Hosts a MapLibre `MapView` (official Android SDK, TextureView mode) and owns one native engine registered
 * under the `engineId` prop. Implements the core's map adapter ([MapramaMapHost]): every call is posted to
 * the main thread and applied once the map is ready; style patches wait for the style they belong to;
 * replies go back through [MapramaJni]. The map UI ornaments are drawn from values the core computes.
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

  /** Incremented by every `setStyleJson`: patches queued for an older style are dropped. */
  private var styleGeneration = 0

  /** Game source data (M3a) not applied yet: only the latest data per source is kept. */
  private val pendingSources = HashMap<String, String>()
  private var sourceStatsStart = 0L
  private var sourceUpdates = 0
  private var sourceTotalMs = 0.0
  private var sourceMaxMs = 0.0

  /** M3b: one main-thread redraw per batch of model frames (the core sends one per game tick). */
  private val modelRepaintQueued = AtomicBoolean(false)

  /** Device location feed (`setLocationSource {kind: "device"}`); the permission is the app's job. */
  private var locationListener: LocationListener? = null

  // Map UI (MapUiState).
  private val scaleBar = ScaleBarView(reactContext, density)
  private val zoomButtons = LinearLayout(reactContext)
  private val attributionLabel = TextView(reactContext)
  private var logoShown = false

  init {
    MapLibre.getInstance(reactContext)
    val options = MapLibreMapOptions.createFromAttributes(reactContext).textureMode(true)
    mapView = MapView(reactContext, options)
    addView(mapView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    createOrnaments()
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
    stopLocation()
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
    layoutOrnaments(w, h)
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

  private fun dp(value: Int): Int = (value * density).toInt()

  // ---- Map ---------------------------------------------------------------------------------------

  private fun onMapReady(m: MapLibreMap) {
    if (destroyed) return
    map = m
    m.uiSettings.isRotateGesturesEnabled = true
    m.uiSettings.isTiltGesturesEnabled = true
    // Ornaments follow MapUiState (the core sends one on attach); hidden until then.
    m.uiSettings.isLogoEnabled = false
    m.uiSettings.isAttributionEnabled = false
    m.uiSettings.isCompassEnabled = false
    m.setMinPitchPreference(0.0)
    m.setMaxPitchPreference(60.0)
    m.addOnCameraMoveListener { reportCamera() }
    m.addOnCameraIdleListener { reportCamera() }
    // M4 (DESIGN.md §8): MapLibre's own cost per frame and the process memory, logged every 240 rendered frames.
    mapView.addOnDidFinishRenderingFrameListener(
      MapView.OnDidFinishRenderingFrameListener { _, encodingMs, renderingMs -> recordMapFrame(encodingMs, renderingMs) },
    )
    // A user pan stops `setCamera.follow` (engine-web cancels following on pans, not on zoom / rotate).
    m.addOnMoveListener(
      object : MapLibreMap.OnMoveListener {
        override fun onMoveBegin(detector: MoveGestureDetector) {
          if (handle != 0L) MapramaJni.onUserPan(handle)
        }

        override fun onMove(detector: MoveGestureDetector) {}

        override fun onMoveEnd(detector: MoveGestureDetector) {}
      },
    )
    m.addOnMapClickListener { point ->
      val screen = m.projection.toScreenLocation(point)
      if (handle != 0L) MapramaJni.tap(handle, screen.x / density.toDouble(), screen.y / density.toDouble())
      false
    }
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

  /** Runs [block] once the style of the current `setStyleJson` generation has loaded. */
  private fun onStyle(block: (Style) -> Unit) = onMap { m ->
    val generation = styleGeneration
    m.getStyle { style -> if (!destroyed && generation == styleGeneration) block(style) }
  }

  // ---- MapramaMapHost (called from libmaprama_engine.so) -----------------------------------------

  override fun setStyleJson(json: String) = onMap { m ->
    val generation = ++styleGeneration
    // Game source data (M3a) queued for the previous style is dropped: the core re-sends every source.
    pendingSources.clear()
    m.setStyle(Style.Builder().fromJson(json)) { style -> if (!destroyed && generation == styleGeneration) installBuildingLayer(style) }
  }

  override fun buildingLayerChanged() = onStyle { style ->
    installBuildingLayer(style)
    map?.triggerRepaint()
  }

  override fun modelLayerChanged() {
    if (!modelRepaintQueued.compareAndSet(false, true)) return
    mainHandler.post {
      modelRepaintQueued.set(false)
      if (destroyed) return@post
      val m = map ?: return@post
      val style = m.style
      if (style != null && style.isFullyLoaded && style.getLayer(BUILDING_LAYER) == null) installBuildingLayer(style)
      m.triggerRepaint()
    }
  }

  /**
   * M2c: puts the custom building layer (a native `CustomLayerHost` sharing the engine's latest building layer
   * data) directly below the `buildings` fill-extrusion of [style], once per style, and reports how many layers
   * are drawn above it (the GL backend's depth-range probe needs it, BuildingMesh.hpp).
   */
  private fun installBuildingLayer(style: Style) {
    if (handle == 0L || style.getLayer(BUILDINGS_LAYER) == null) return
    if (style.getLayer(BUILDING_LAYER) == null) {
      val host = MapramaJni.createBuildingLayerHost(handle)
      if (host == 0L) return
      style.addLayerBelow(CustomLayer(BUILDING_LAYER, host), BUILDINGS_LAYER)
    }
    val ids = style.layers.map { it.id }
    val index = ids.indexOf(BUILDING_LAYER)
    if (index >= 0) MapramaJni.setBuildingLayersAbove(handle, ids.size - 1 - index)
  }

  override fun setPaintProperties(layers: Array<String>, properties: Array<String>, values: Array<String>) = onStyle { style ->
    for (i in layers.indices) {
      val layer = style.getLayer(layers[i]) ?: continue
      val value = paintValue(values[i]) ?: continue
      try {
        layer.setProperties(PaintPropertyValue(properties[i], value))
      } catch (e: Exception) {
        Log.w(TAG, "cannot set ${properties[i]} on layer ${layers[i]}: ${e.message}")
      }
    }
  }

  override fun setLight(radial: Double, azimuthal: Double, polar: Double, color: String, intensity: Double) = onStyle { style ->
    val light = style.light ?: return@onStyle
    light.anchor = "map"
    light.position = Position(radial.toFloat(), azimuthal.toFloat(), polar.toFloat())
    light.setColor(color)
    light.intensity = intensity.toFloat()
  }

  override fun setUi(
    scaleBar: Boolean,
    scaleBarWidth: Double,
    scaleBarLabel: String,
    zoomButtons: Boolean,
    compass: Boolean,
    attribution: Boolean,
    attributionText: String,
    logo: Boolean,
  ) = onMap { m ->
    m.uiSettings.isLogoEnabled = logo
    m.uiSettings.isAttributionEnabled = attribution
    m.uiSettings.isCompassEnabled = compass
    logoShown = logo
    this.scaleBar.visibility = if (scaleBar) View.VISIBLE else View.GONE
    this.scaleBar.update((scaleBarWidth * density).toInt(), scaleBarLabel)
    this.zoomButtons.visibility = if (zoomButtons) View.VISIBLE else View.GONE
    attributionLabel.visibility = if (attribution) View.VISIBLE else View.GONE
    attributionLabel.text = attributionText
    requestLayout()
  }

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

  override fun projectPoints(token: Long, lngLats: DoubleArray) = onMap { m ->
    val xy = DoubleArray(lngLats.size)
    var i = 0
    while (i + 1 < lngLats.size) {
      val point = m.projection.toScreenLocation(LatLng(lngLats[i + 1], lngLats[i]))
      xy[i] = point.x / density.toDouble()
      xy[i + 1] = point.y / density.toDouble()
      i += 2
    }
    if (handle != 0L) MapramaJni.onPointsProjected(handle, token, xy)
  }

  override fun unproject(token: Long, x: Double, y: Double) = onMap { m ->
    val coordinate = m.projection.fromScreenLocation(PointF((x * density).toFloat(), (y * density).toFloat()))
    if (handle != 0L) {
      val valid = !coordinate.latitude.isNaN() && !coordinate.longitude.isNaN()
      MapramaJni.onUnprojected(handle, token, valid, coordinate.longitude, coordinate.latitude)
    }
  }

  override fun queryBuilding(token: Long, x: Double, y: Double) = onMap { m ->
    val point = PointF((x * density).toFloat(), (y * density).toFloat())
    var buildingId: String? = null
    val style = m.style
    if (style != null && style.isFullyLoaded) {
      for (feature in m.queryRenderedFeatures(point, BUILDINGS_LAYER)) {
        val id = try {
          if (feature.hasProperty("id")) feature.getStringProperty("id") else null
        } catch (e: Exception) {
          null
        }
        if (id != null) {
          buildingId = id
          break
        }
      }
    }
    val ground = m.projection.fromScreenLocation(point)
    val hit = !ground.latitude.isNaN() && !ground.longitude.isNaN()
    if (handle != 0L) MapramaJni.onBuildingQueried(handle, token, buildingId, hit, ground.longitude, ground.latitude)
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

  override fun fetchBinary(token: Long, url: String) {
    thread(name = "maprama-fetch", isDaemon = true) {
      var bytes: ByteArray? = null
      var message = ""
      try {
        if (url.startsWith("file:")) {
          bytes = File(URI(url)).readBytes()
        } else {
          val connection = URL(url).openConnection() as HttpURLConnection
          connection.connectTimeout = 15000
          connection.readTimeout = 30000
          try {
            val status = connection.responseCode
            if (status in 200..299) {
              bytes = connection.inputStream.use { it.readBytes() }
            } else {
              message = "HTTP $status while loading $url"
            }
          } finally {
            connection.disconnect()
          }
        }
      } catch (e: Exception) {
        message = "failed to load $url: ${e.message ?: e.javaClass.simpleName}"
      }
      val data = bytes
      mainHandler.post { if (handle != 0L) MapramaJni.onBinaryFetched(handle, token, data != null, data, message) }
    }
  }

  override fun scheduleFrame(delayMs: Double) {
    mainHandler.postDelayed({
      if (handle != 0L) MapramaJni.frame(handle, SystemClock.uptimeMillis().toDouble())
    }, delayMs.toLong().coerceAtLeast(0L))
  }

  override fun setSourceData(sourceId: String, geojson: String) = onMap { m ->
    val generation = styleGeneration
    // One style callback per source and generation applies the latest data queued for it.
    if (pendingSources.put(sourceId, geojson) != null) return@onMap
    m.getStyle { style ->
      if (destroyed || generation != styleGeneration) return@getStyle
      val data = pendingSources.remove(sourceId) ?: return@getStyle
      val started = SystemClock.elapsedRealtimeNanos()
      style.getSourceAs<GeoJsonSource>(sourceId)?.setGeoJson(data)
      recordSourceUpdate((SystemClock.elapsedRealtimeNanos() - started) / 1e6)
    }
  }

  private val mapFrameLock = Any()
  private val mapEncodeMs = ArrayList<Double>()
  private val mapRenderMs = ArrayList<Double>()

  /** M4: MapLibre's frame encoding / rendering time (the SDK's own measurement) and the process memory. */
  private fun recordMapFrame(encodingMs: Double, renderingMs: Double) {
    val encode: List<Double>
    val render: List<Double>
    synchronized(mapFrameLock) {
      mapEncodeMs.add(encodingMs)
      mapRenderMs.add(renderingMs)
      if (mapEncodeMs.size < MAP_STATS_FRAMES) return
      encode = ArrayList(mapEncodeMs)
      render = ArrayList(mapRenderMs)
      mapEncodeMs.clear()
      mapRenderMs.clear()
    }
    fun avg(v: List<Double>) = v.sum() / v.size
    fun p95(v: List<Double>) = v.sorted()[minOf(v.size - 1, (v.size * 0.95).toInt())]
    val memory = android.os.Debug.MemoryInfo()
    android.os.Debug.getMemoryInfo(memory)
    fun mb(key: String) = (memory.getMemoryStat(key)?.toDoubleOrNull() ?: 0.0) / 1024.0
    Log.i(
      TAG,
      "maprama-map-frame-stats frames=${encode.size} map_encode_avg=${"%.3f".format(avg(encode))} " +
        "map_encode_p95=${"%.3f".format(p95(encode))} map_render_avg=${"%.3f".format(avg(render))} " +
        "map_render_p95=${"%.3f".format(p95(render))} pss_mb=${"%.1f".format(mb("summary.total-pss"))} " +
        "native_heap_mb=${"%.1f".format(mb("summary.native-heap"))} graphics_mb=${"%.1f".format(mb("summary.graphics"))} " +
        "java_heap_mb=${"%.1f".format(mb("summary.java-heap"))}",
    )
  }

  private fun recordSourceUpdate(ms: Double) {
    val now = SystemClock.elapsedRealtime()
    if (sourceStatsStart == 0L) sourceStatsStart = now
    sourceUpdates++
    sourceTotalMs += ms
    sourceMaxMs = maxOf(sourceMaxMs, ms)
    if (now - sourceStatsStart < 5000) return
    Log.i(
      TAG,
      "engine-native: Android game source updates $sourceUpdates in ${"%.1f".format((now - sourceStatsStart) / 1000.0)} s: " +
        "avg ${"%.3f".format(sourceTotalMs / sourceUpdates)} ms, max ${"%.3f".format(sourceMaxMs)} ms (main thread)",
    )
    sourceStatsStart = now
    sourceUpdates = 0
    sourceTotalMs = 0.0
    sourceMaxMs = 0.0
  }

  override fun startLocationUpdates() {
    mainHandler.post { startLocation() }
  }

  override fun stopLocationUpdates() {
    mainHandler.post { stopLocation() }
  }

  private fun startLocation() {
    if (destroyed || handle == 0L) return
    stopLocation()
    val fine = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val coarse = context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    if (!fine && !coarse) {
      // Requesting the permission is the app's job; the source fails like engine-web's denied geolocation.
      MapramaJni.onDeviceLocationError(handle, "location permission not granted")
      return
    }
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    if (manager == null) {
      MapramaJni.onDeviceLocationError(handle, "location service unavailable")
      return
    }
    val providers = ArrayList<String>()
    if (fine && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) providers.add(LocationManager.GPS_PROVIDER)
    if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) providers.add(LocationManager.NETWORK_PROVIDER)
    if (providers.isEmpty()) {
      MapramaJni.onDeviceLocationError(handle, "no location provider is enabled")
      return
    }
    val listener =
      object : LocationListener {
        override fun onLocationChanged(location: Location) = reportLocation(location)

        @Deprecated("Deprecated in the Android SDK; implemented for API < 30")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

        override fun onProviderEnabled(provider: String) {}

        override fun onProviderDisabled(provider: String) {}
      }
    try {
      for (provider in providers) manager.requestLocationUpdates(provider, 1000L, 0f, listener, Looper.getMainLooper())
      locationListener = listener
      providers.mapNotNull { manager.getLastKnownLocation(it) }.maxByOrNull { it.time }?.let { reportLocation(it) }
    } catch (e: SecurityException) {
      manager.removeUpdates(listener)
      MapramaJni.onDeviceLocationError(handle, "location permission not granted")
    }
  }

  private fun stopLocation() {
    val listener = locationListener ?: return
    locationListener = null
    (context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager)?.removeUpdates(listener)
  }

  private fun reportLocation(location: Location) {
    if (handle == 0L || locationListener == null) return
    MapramaJni.onDeviceLocation(
      handle,
      location.longitude,
      location.latitude,
      if (location.hasAccuracy()) location.accuracy.toDouble() else Double.NaN,
      if (location.hasBearing()) location.bearing.toDouble() else Double.NaN,
      if (location.hasSpeed()) location.speed.toDouble() else Double.NaN,
      location.time.toDouble(),
    )
  }

  // ---- Map UI --------------------------------------------------------------------------------------

  private fun createOrnaments() {
    scaleBar.visibility = View.GONE
    addView(scaleBar, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))

    zoomButtons.orientation = LinearLayout.VERTICAL
    zoomButtons.visibility = View.GONE
    zoomButtons.addView(zoomButton("+", "Zoom in") { if (handle != 0L) MapramaJni.zoomButton(handle, true) })
    val spacer = View(context)
    zoomButtons.addView(spacer, LinearLayout.LayoutParams(dp(1), dp(8)))
    zoomButtons.addView(zoomButton("−", "Zoom out") { if (handle != 0L) MapramaJni.zoomButton(handle, false) })
    addView(zoomButtons, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))

    attributionLabel.visibility = View.GONE
    attributionLabel.textSize = 10f
    attributionLabel.setTextColor(Color.rgb(51, 51, 51))
    attributionLabel.setPadding(dp(5), dp(2), dp(5), dp(2))
    attributionLabel.background = GradientDrawable().apply {
      cornerRadius = 4 * density
      setColor(Color.argb(191, 255, 255, 255))
    }
    attributionLabel.contentDescription = "maprama-attribution"
    addView(attributionLabel, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
  }

  private fun zoomButton(text: String, description: String, onPress: () -> Unit): TextView =
    TextView(context).apply {
      this.text = text
      textSize = 22f
      gravity = Gravity.CENTER
      setTextColor(Color.rgb(38, 38, 38))
      contentDescription = description
      background = GradientDrawable().apply {
        cornerRadius = 8 * density
        setColor(Color.argb(240, 255, 255, 255))
      }
      layoutParams = LinearLayout.LayoutParams(dp(44), dp(44))
      isClickable = true
      setOnClickListener { onPress() }
    }

  private fun layoutOrnaments(w: Int, h: Int) {
    val unspecified = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
    // Scale bar: bottom-left, above the MapLibre logo when it is shown.
    scaleBar.measure(unspecified, unspecified)
    val scaleBottom = h - dp(if (logoShown) 40 else 12)
    scaleBar.layout(dp(12), scaleBottom - scaleBar.measuredHeight, dp(12) + scaleBar.measuredWidth, scaleBottom)
    // Zoom buttons: right edge, vertically centred.
    zoomButtons.measure(unspecified, unspecified)
    val zx = w - dp(12) - zoomButtons.measuredWidth
    val zy = (h - zoomButtons.measuredHeight) / 2
    zoomButtons.layout(zx, zy, zx + zoomButtons.measuredWidth, zy + zoomButtons.measuredHeight)
    // Attribution text: bottom-right (MapLibre's logo and attribution button sit bottom-left on Android).
    attributionLabel.measure(MeasureSpec.makeMeasureSpec((w - dp(120)).coerceAtLeast(dp(40)), MeasureSpec.AT_MOST), unspecified)
    val ax = w - dp(8) - attributionLabel.measuredWidth
    val ay = h - dp(8) - attributionLabel.measuredHeight
    attributionLabel.layout(ax, ay, ax + attributionLabel.measuredWidth, ay + attributionLabel.measuredHeight)
  }

  /** Label over a bar of a given pixel width (the core computes both, engine-web `scaleBarFor`). */
  private class ScaleBarView(context: Context, private val density: Float) : LinearLayout(context) {
    private val label = TextView(context)
    private val line = View(context)

    init {
      orientation = VERTICAL
      isClickable = false
      contentDescription = "maprama-scale-bar"
      label.textSize = 11f
      label.setTypeface(Typeface.DEFAULT, Typeface.BOLD)
      label.setTextColor(Color.rgb(38, 38, 38))
      line.setBackgroundColor(Color.rgb(38, 38, 38))
      addView(label, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
      addView(line, LayoutParams(1, (4 * density).toInt()))
    }

    fun update(widthPx: Int, text: String) {
      label.text = text
      line.layoutParams = LayoutParams(widthPx.coerceAtLeast(1), (4 * density).toInt()).apply { topMargin = (2 * density).toInt() }
    }
  }

  companion object {
    private const val TAG = "MapramaEngine"
    /** MapLibre frame statistics are logged every this many rendered frames (like the custom layer's). */
    private const val MAP_STATS_FRAMES = 240
    private const val BUILDINGS_LAYER = "buildings"
    /** The M2c custom building layer (same id as on iOS). */
    private const val BUILDING_LAYER = "maprama-buildings-3d"
    private const val EMPTY_STYLE =
      """{"version":8,"sources":{},"layers":[{"id":"background","type":"background","paint":{"background-color":"#E4DFD6"}}]}"""

    /** A style-spec value as JSON -> the value `Layer.setProperties` takes (String / Float / Boolean / Expression). */
    private fun paintValue(json: String): Any? {
      val trimmed = json.trim()
      if (trimmed.startsWith("[")) {
        return try {
          Expression.Converter.convert(trimmed)
        } catch (e: Exception) {
          Log.w(TAG, "invalid paint expression: ${e.message}")
          null
        }
      }
      return when (val value = try { JSONTokener(trimmed).nextValue() } catch (e: Exception) { null }) {
        is String -> value
        is Boolean -> value
        is Number -> value.toFloat()
        else -> null
      }
    }

    init {
      Log.i(TAG, "MapramaNativeView (M3b, MapLibre Android SDK)")
    }
  }
}
