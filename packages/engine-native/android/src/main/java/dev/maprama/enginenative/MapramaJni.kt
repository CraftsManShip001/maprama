package dev.maprama.enginenative

/**
 * Platform side of the core's `MapAdapter` (cpp/include/maprama/MapAdapter.hpp). libmaprama_engine.so calls
 * these methods (JNI, by name) with the engine lock held, from the thread that entered the engine:
 * implementations must only post work to the main thread and reply later through [MapramaJni].
 */
interface MapramaMapHost {
  fun setStyleJson(json: String)

  /** Paint properties of existing style layers (`values` are style-spec JSON), applied once the style loaded. */
  fun setPaintProperties(layers: Array<String>, properties: Array<String>, values: Array<String>)

  /** The style light: spherical position (azimuth clockwise from north, polar 0 = overhead), color `#RRGGBB`. */
  fun setLight(radial: Double, azimuthal: Double, polar: Double, color: String, intensity: Double)

  /** Map UI ornaments computed by the core (`MapUiState`). */
  fun setUi(
    scaleBar: Boolean,
    scaleBarWidth: Double,
    scaleBarLabel: String,
    zoomButtons: Boolean,
    compass: Boolean,
    attribution: Boolean,
    attributionText: String,
    logo: Boolean,
  )

  fun setCameraLimits(minZoom: Double, maxZoom: Double, minPitch: Double, maxPitch: Double)

  fun moveCamera(lng: Double, lat: Double, zoom: Double, pitch: Double, bearing: Double, durationMs: Double)

  fun project(token: Long, lng: Double, lat: Double)

  /** `lngLats` = [lng0, lat0, lng1, lat1, …]; reply [MapramaJni.onPointsProjected] with [x0, y0, …] in dp. */
  fun projectPoints(token: Long, lngLats: DoubleArray)

  fun unproject(token: Long, x: Double, y: Double)

  /** Rendered-feature query on the `buildings` layer + ground coordinate; reply [MapramaJni.onBuildingQueried]. */
  fun queryBuilding(token: Long, x: Double, y: Double)

  fun fetchText(token: Long, url: String)

  fun scheduleFrame(delayMs: Double)

  /**
   * Measures label cards (M2b): 3 strings (title, subtitle, accessibility label) and 4 ints (visual, kind, flags,
   * icon) per item; reply [MapramaJni.onLabelsMeasured] with [w0, h0, …] in dp.
   */
  fun measureLabels(token: Long, strings: Array<String>, ints: IntArray)

  /**
   * Shows exactly these label cards and hides the others (M2b, [LabelFrameData.decode]). Called on the main thread
   * for camera changes (apply at once) or on the JS thread for commands (post).
   */
  fun setLabelFrame(
    visual: Int,
    tile: Int,
    night: Boolean,
    ids: Array<String>,
    keys: Array<String>,
    strings: Array<String>,
    ints: IntArray,
    numbers: DoubleArray,
  )
}

/** JNI entry points of libmaprama_engine.so (`android/src/main/cpp/maprama_jni.cpp`). */
internal object MapramaJni {
  init {
    System.loadLibrary("maprama_engine")
  }

  /** Creates an engine registered under [engineId] with [host] as its map adapter; returns the handle. */
  @JvmStatic external fun create(engineId: String, host: MapramaMapHost, validateEvents: Boolean): Long

  @JvmStatic external fun start(handle: Long)

  /** Unregisters, shuts down and frees the engine handle. */
  @JvmStatic external fun destroy(handle: Long)

  @JvmStatic external fun setViewport(handle: Long, width: Double, height: Double, pixelRatio: Double)

  @JvmStatic external fun onCameraChanged(handle: Long, lng: Double, lat: Double, zoom: Double, pitch: Double, bearing: Double)

  @JvmStatic external fun onProjected(handle: Long, token: Long, x: Double, y: Double)

  /** [xy] = [x0, y0, x1, y1, …] in dp, in request order. */
  @JvmStatic external fun onPointsProjected(handle: Long, token: Long, xy: DoubleArray)

  @JvmStatic external fun onUnprojected(handle: Long, token: Long, hit: Boolean, lng: Double, lat: Double)

  @JvmStatic external fun onBuildingQueried(handle: Long, token: Long, buildingId: String?, groundHit: Boolean, lng: Double, lat: Double)

  @JvmStatic external fun onTextFetched(handle: Long, token: Long, ok: Boolean, bodyOrError: String)

  /** Reply to [MapramaMapHost.measureLabels]: [w0, h0, w1, h1, …] in dp, in request order. */
  @JvmStatic external fun onLabelsMeasured(handle: Long, token: Long, sizes: DoubleArray)

  /** Vector data of a label icon ([IconDrawingData] layout); [glyph] = the POI badge glyph. Null when there is none. */
  @JvmStatic external fun labelIconData(glyph: Boolean, icon: Int): FloatArray?

  @JvmStatic external fun frame(handle: Long, timestampMs: Double)

  /** Single tap on the map, dp. */
  @JvmStatic external fun tap(handle: Long, x: Double, y: Double)

  @JvmStatic external fun zoomButton(handle: Long, zoomIn: Boolean)

  /** Returns false when no engine is registered under [engineId]. */
  @JvmStatic external fun postMessage(engineId: String, envelope: String): Boolean

  @JvmStatic external fun postMessages(engineId: String, envelopes: Array<String>): Boolean
}
