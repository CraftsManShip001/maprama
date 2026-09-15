package dev.maprama.enginenative

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.module.annotations.ReactModule
import java.lang.ref.WeakReference

/**
 * TurboModule `MapramaEngineModule` (codegen spec `NativeMapramaEngineModule.ts`, DESIGN.md §4.1 M1):
 * `postMessage` / `postMessages` hand envelopes to the engine registered under `engineId` (C++
 * `EngineRegistry`, through JNI); engine events come back through the codegen EventEmitter `onEngineEvent`.
 */
@ReactModule(name = MapramaEngineModule.NAME)
class MapramaEngineModule(reactContext: ReactApplicationContext) : NativeMapramaEngineModuleSpec(reactContext) {
  init {
    attach(this)
  }

  override fun getName(): String = NAME

  override fun postMessage(engineId: String, envelope: String) {
    if (!MapramaJni.postMessage(engineId, envelope)) {
      Log.w(TAG, "postMessage: no native engine registered for $engineId (view not mounted yet?)")
    }
  }

  override fun postMessages(engineId: String, envelopes: ReadableArray) {
    val batch = Array(envelopes.size()) { i -> envelopes.getString(i) ?: "" }
    if (!MapramaJni.postMessages(engineId, batch)) {
      Log.w(TAG, "postMessages: no native engine registered for $engineId (view not mounted yet?)")
    }
  }

  override fun invalidate() {
    detach(this)
    super.invalidate()
  }

  /** The codegen emitter works once the module's JS object exists (it installs the callback). */
  private fun canEmit(): Boolean = mEventEmitterCallback != null

  private fun deliver(engineId: String, envelope: String) {
    val payload = Arguments.createMap()
    payload.putString("engineId", engineId)
    payload.putString("envelope", envelope)
    emitOnEngineEvent(payload)
  }

  companion object {
    const val NAME = "MapramaEngineModule"
    private const val TAG = "MapramaEngine"
    private const val MAX_PENDING = 512

    private val lock = Any()
    private var module: WeakReference<MapramaEngineModule>? = null
    private val pending = ArrayDeque<Pair<String, String>>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var retryScheduled = false

    private fun attach(instance: MapramaEngineModule) {
      synchronized(lock) { module = WeakReference(instance) }
      flushPending()
    }

    private fun detach(instance: MapramaEngineModule) {
      synchronized(lock) { if (module?.get() === instance) module = null }
    }

    /** Called from libmaprama_engine.so (any thread) for every event envelope. */
    @JvmStatic
    fun dispatchEvent(engineId: String, envelope: String) {
      val target: MapramaEngineModule?
      synchronized(lock) {
        val m = module?.get()
        if (m == null || !m.canEmit() || pending.isNotEmpty()) {
          if (pending.size >= MAX_PENDING) pending.removeFirst()
          pending.addLast(engineId to envelope)
          scheduleRetry()
          return
        }
        target = m
      }
      target?.deliver(engineId, envelope)
    }

    private fun scheduleRetry() {
      if (retryScheduled) return
      retryScheduled = true
      mainHandler.postDelayed({
        synchronized(lock) { retryScheduled = false }
        flushPending()
      }, 16)
    }

    private fun flushPending() {
      while (true) {
        val next: Pair<String, String>
        val target: MapramaEngineModule
        synchronized(lock) {
          val m = module?.get()
          if (pending.isEmpty()) return
          if (m == null || !m.canEmit()) {
            scheduleRetry()
            return
          }
          next = pending.removeFirst()
          target = m
        }
        target.deliver(next.first, next.second)
      }
    }
  }
}
