package dev.maprama.enginenative

/**
 * Platform side of the core's `MapAdapter` (cpp/include/maprama/MapAdapter.hpp). libmaprama_engine.so calls
 * these methods (JNI, by name) with the engine lock held, from the thread that entered the engine:
 * implementations must only post work to the main thread and reply later through [MapramaJni].
 */
interface MapramaMapHost {
  fun setStyleJson(json: String)

  fun setCameraLimits(minZoom: Double, maxZoom: Double, minPitch: Double, maxPitch: Double)

  fun moveCamera(lng: Double, lat: Double, zoom: Double, pitch: Double, bearing: Double, durationMs: Double)

  fun project(token: Long, lng: Double, lat: Double)

  fun unproject(token: Long, x: Double, y: Double)

  fun fetchText(token: Long, url: String)

  fun scheduleFrame(delayMs: Double)
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

  @JvmStatic external fun onUnprojected(handle: Long, token: Long, hit: Boolean, lng: Double, lat: Double)

  @JvmStatic external fun onTextFetched(handle: Long, token: Long, ok: Boolean, bodyOrError: String)

  @JvmStatic external fun frame(handle: Long, timestampMs: Double)

  /** Returns false when no engine is registered under [engineId]. */
  @JvmStatic external fun postMessage(engineId: String, envelope: String): Boolean

  @JvmStatic external fun postMessages(engineId: String, envelopes: Array<String>): Boolean
}
