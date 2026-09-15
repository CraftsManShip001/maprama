// JNI glue between the Kotlin wrapper (dev.maprama.enginenative) and the shared C++ core.
//
//   Kotlin -> core : MapramaJni.* (create/start/destroy, viewport, adapter replies, frames, postMessage)
//   core -> Kotlin : MapramaMapHost (the MapAdapter implemented by MapramaNativeView) and
//                    MapramaEngineModule.dispatchEvent (engine events -> TurboModule EventEmitter)
//
// Strings cross as UTF-16 (GetStringChars / NewString) with an explicit UTF-8 conversion, so supplementary
// characters survive (JNI's "modified UTF-8" would turn them into CESU-8).
#include <android/log.h>
#include <jni.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/Engine.hpp"
#include "maprama/EngineRegistry.hpp"
#include "maprama/MapAdapter.hpp"
#include "maprama_building_layer.hpp"

namespace {

constexpr const char* kTag = "MapramaEngine";

JavaVM* gVm = nullptr;
jclass gModuleClass = nullptr;
jmethodID gDispatchEvent = nullptr;

JNIEnv* currentEnv() {
  JNIEnv* env = nullptr;
  if (gVm == nullptr) return nullptr;
  const jint status = gVm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
  if (status == JNI_EDETACHED) {
    if (gVm->AttachCurrentThread(&env, nullptr) != JNI_OK) return nullptr;
  }
  return env;
}

void clearException(JNIEnv* env, const char* where) {
  if (env->ExceptionCheck()) {
    __android_log_print(ANDROID_LOG_ERROR, kTag, "Java exception in %s", where);
    env->ExceptionDescribe();
    env->ExceptionClear();
  }
}

void appendUtf8(std::string& out, std::uint32_t c) {
  if (c < 0x80) {
    out += static_cast<char>(c);
  } else if (c < 0x800) {
    out += static_cast<char>(0xC0 | (c >> 6));
    out += static_cast<char>(0x80 | (c & 0x3F));
  } else if (c < 0x10000) {
    out += static_cast<char>(0xE0 | (c >> 12));
    out += static_cast<char>(0x80 | ((c >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (c & 0x3F));
  } else {
    out += static_cast<char>(0xF0 | (c >> 18));
    out += static_cast<char>(0x80 | ((c >> 12) & 0x3F));
    out += static_cast<char>(0x80 | ((c >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (c & 0x3F));
  }
}

std::string toUtf8(JNIEnv* env, jstring value) {
  if (value == nullptr) return {};
  const jsize length = env->GetStringLength(value);
  const jchar* chars = env->GetStringChars(value, nullptr);
  std::string out;
  out.reserve(static_cast<std::size_t>(length));
  for (jsize i = 0; i < length; ++i) {
    std::uint32_t c = chars[i];
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < length && chars[i + 1] >= 0xDC00 && chars[i + 1] <= 0xDFFF) {
      c = 0x10000 + ((c - 0xD800) << 10) + (chars[i + 1] - 0xDC00);
      ++i;
    }
    appendUtf8(out, c);  // lone surrogates are kept (WTF-8), like the core's JSON codec
  }
  env->ReleaseStringChars(value, chars);
  return out;
}

jstring toJString(JNIEnv* env, std::string_view utf8) {
  std::vector<jchar> units;
  units.reserve(utf8.size());
  std::size_t i = 0;
  while (i < utf8.size()) {
    const auto b0 = static_cast<unsigned char>(utf8[i]);
    std::uint32_t c = 0xFFFD;
    std::size_t n = 1;
    if (b0 < 0x80) {
      c = b0;
    } else if ((b0 >> 5) == 0x6 && i + 1 < utf8.size()) {
      c = ((b0 & 0x1F) << 6) | (static_cast<unsigned char>(utf8[i + 1]) & 0x3F);
      n = 2;
    } else if ((b0 >> 4) == 0xE && i + 2 < utf8.size()) {
      c = ((b0 & 0x0F) << 12) | ((static_cast<unsigned char>(utf8[i + 1]) & 0x3F) << 6) |
          (static_cast<unsigned char>(utf8[i + 2]) & 0x3F);
      n = 3;
    } else if ((b0 >> 3) == 0x1E && i + 3 < utf8.size()) {
      c = ((b0 & 0x07) << 18) | ((static_cast<unsigned char>(utf8[i + 1]) & 0x3F) << 12) |
          ((static_cast<unsigned char>(utf8[i + 2]) & 0x3F) << 6) | (static_cast<unsigned char>(utf8[i + 3]) & 0x3F);
      n = 4;
    }
    i += n;
    if (c >= 0x10000) {
      c -= 0x10000;
      units.push_back(static_cast<jchar>(0xD800 + (c >> 10)));
      units.push_back(static_cast<jchar>(0xDC00 + (c & 0x3FF)));
    } else {
      units.push_back(static_cast<jchar>(c));
    }
  }
  return env->NewString(units.data(), static_cast<jsize>(units.size()));
}

/// Engine output -> MapramaEngineModule.dispatchEvent (TurboModule EventEmitter) and logcat.
class JniMessageSink final : public maprama::MessageSink {
 public:
  explicit JniMessageSink(std::string engineId) : engineId_(std::move(engineId)) {}

  void onEvent(std::string envelopeJson) override {
    JNIEnv* env = currentEnv();
    if (env == nullptr || gModuleClass == nullptr) return;
    jstring id = toJString(env, engineId_);
    jstring envelope = toJString(env, envelopeJson);
    env->CallStaticVoidMethod(gModuleClass, gDispatchEvent, id, envelope);
    clearException(env, "MapramaEngineModule.dispatchEvent");
    env->DeleteLocalRef(id);
    env->DeleteLocalRef(envelope);
  }

  void onLog(maprama::LogLevel level, std::string_view message) override {
    int priority = ANDROID_LOG_INFO;
    switch (level) {
      case maprama::LogLevel::Debug:
        priority = ANDROID_LOG_DEBUG;
        break;
      case maprama::LogLevel::Info:
        priority = ANDROID_LOG_INFO;
        break;
      case maprama::LogLevel::Warn:
        priority = ANDROID_LOG_WARN;
        break;
      case maprama::LogLevel::Error:
        priority = ANDROID_LOG_ERROR;
        break;
    }
    const std::string text(message);
    __android_log_print(priority, kTag, "%s", text.c_str());
  }

 private:
  std::string engineId_;
};

/// `maprama::MapAdapter` forwarding to the Kotlin `MapramaMapHost` (MapramaNativeView).
class JniMapAdapter final : public maprama::MapAdapter {
 public:
  JniMapAdapter(JNIEnv* env, jobject host) : host_(env->NewGlobalRef(host)) {
    jclass cls = env->GetObjectClass(host);
    setStyleJson_ = env->GetMethodID(cls, "setStyleJson", "(Ljava/lang/String;)V");
    setPaintProperties_ =
        env->GetMethodID(cls, "setPaintProperties", "([Ljava/lang/String;[Ljava/lang/String;[Ljava/lang/String;)V");
    setLight_ = env->GetMethodID(cls, "setLight", "(DDDLjava/lang/String;D)V");
    setUi_ = env->GetMethodID(cls, "setUi", "(ZDLjava/lang/String;ZZZLjava/lang/String;Z)V");
    setCameraLimits_ = env->GetMethodID(cls, "setCameraLimits", "(DDDD)V");
    moveCamera_ = env->GetMethodID(cls, "moveCamera", "(DDDDDD)V");
    project_ = env->GetMethodID(cls, "project", "(JDD)V");
    projectPoints_ = env->GetMethodID(cls, "projectPoints", "(J[D)V");
    unproject_ = env->GetMethodID(cls, "unproject", "(JDD)V");
    queryBuilding_ = env->GetMethodID(cls, "queryBuilding", "(JDD)V");
    fetchText_ = env->GetMethodID(cls, "fetchText", "(JLjava/lang/String;)V");
    scheduleFrame_ = env->GetMethodID(cls, "scheduleFrame", "(D)V");
    buildingLayerChanged_ = env->GetMethodID(cls, "buildingLayerChanged", "()V");
    setSourceData_ = env->GetMethodID(cls, "setSourceData", "(Ljava/lang/String;Ljava/lang/String;)V");
    startLocationUpdates_ = env->GetMethodID(cls, "startLocationUpdates", "()V");
    stopLocationUpdates_ = env->GetMethodID(cls, "stopLocationUpdates", "()V");
    env->DeleteLocalRef(cls);
    jclass stringClass = env->FindClass("java/lang/String");
    stringClass_ = static_cast<jclass>(env->NewGlobalRef(stringClass));
    env->DeleteLocalRef(stringClass);
    clearException(env, "JniMapAdapter method lookup");
  }

  ~JniMapAdapter() override {
    if (JNIEnv* env = currentEnv()) {
      env->DeleteGlobalRef(host_);
      env->DeleteGlobalRef(stringClass_);
    }
  }

  void setStyleJson(std::string styleJson) override {
    withEnv("setStyleJson", [&](JNIEnv* env) {
      jstring json = toJString(env, styleJson);
      env->CallVoidMethod(host_, setStyleJson_, json);
      env->DeleteLocalRef(json);
    });
  }

  void setPaintProperties(const std::vector<maprama::PaintPropertyChange>& changes) override {
    withEnv("setPaintProperties", [&](JNIEnv* env) {
      const auto n = static_cast<jsize>(changes.size());
      jobjectArray layers = env->NewObjectArray(n, stringClass_, nullptr);
      jobjectArray properties = env->NewObjectArray(n, stringClass_, nullptr);
      jobjectArray values = env->NewObjectArray(n, stringClass_, nullptr);
      for (jsize i = 0; i < n; ++i) {
        const maprama::PaintPropertyChange& c = changes[static_cast<std::size_t>(i)];
        setString(env, layers, i, c.layerId);
        setString(env, properties, i, c.property);
        setString(env, values, i, c.valueJson);
      }
      env->CallVoidMethod(host_, setPaintProperties_, layers, properties, values);
      env->DeleteLocalRef(layers);
      env->DeleteLocalRef(properties);
      env->DeleteLocalRef(values);
    });
  }

  void setLight(const maprama::MapLight& light) override {
    withEnv("setLight", [&](JNIEnv* env) {
      char color[8];
      std::snprintf(color, sizeof color, "#%06X", static_cast<unsigned>(light.color & 0xFFFFFF));
      jstring c = toJString(env, color);
      env->CallVoidMethod(host_, setLight_, light.radial, light.azimuthal, light.polar, c, light.intensity);
      env->DeleteLocalRef(c);
    });
  }

  void setUi(const maprama::MapUiState& ui) override {
    withEnv("setUi", [&](JNIEnv* env) {
      jstring label = toJString(env, ui.scaleBarLabel);
      jstring text = toJString(env, ui.attributionText);
      env->CallVoidMethod(host_, setUi_, static_cast<jboolean>(ui.scaleBar), ui.scaleBarWidth, label,
                          static_cast<jboolean>(ui.zoomButtons), static_cast<jboolean>(ui.compass),
                          static_cast<jboolean>(ui.attribution), text, static_cast<jboolean>(ui.logo));
      env->DeleteLocalRef(label);
      env->DeleteLocalRef(text);
    });
  }

  void projectPoints(std::uint64_t token, const std::vector<maprama::LngLat>& coordinates) override {
    withEnv("projectPoints", [&](JNIEnv* env) {
      std::vector<jdouble> flat;
      flat.reserve(coordinates.size() * 2);
      for (const maprama::LngLat& c : coordinates) {
        flat.push_back(c.lng);
        flat.push_back(c.lat);
      }
      jdoubleArray array = env->NewDoubleArray(static_cast<jsize>(flat.size()));
      env->SetDoubleArrayRegion(array, 0, static_cast<jsize>(flat.size()), flat.data());
      env->CallVoidMethod(host_, projectPoints_, static_cast<jlong>(token), array);
      env->DeleteLocalRef(array);
    });
  }

  void queryBuilding(std::uint64_t token, double x, double y) override {
    withEnv("queryBuilding", [&](JNIEnv* env) { env->CallVoidMethod(host_, queryBuilding_, static_cast<jlong>(token), x, y); });
  }

  void setCameraLimits(const maprama::MapCameraLimits& l) override {
    withEnv("setCameraLimits",
            [&](JNIEnv* env) { env->CallVoidMethod(host_, setCameraLimits_, l.minZoom, l.maxZoom, l.minPitch, l.maxPitch); });
  }

  void moveCamera(const maprama::MapCameraPose& p, double durationMs) override {
    withEnv("moveCamera", [&](JNIEnv* env) {
      env->CallVoidMethod(host_, moveCamera_, p.center.lng, p.center.lat, p.zoom, p.pitch, p.bearing, durationMs);
    });
  }

  void project(std::uint64_t token, const maprama::LngLat& c) override {
    withEnv("project",
            [&](JNIEnv* env) { env->CallVoidMethod(host_, project_, static_cast<jlong>(token), c.lng, c.lat); });
  }

  void unproject(std::uint64_t token, double x, double y) override {
    withEnv("unproject", [&](JNIEnv* env) { env->CallVoidMethod(host_, unproject_, static_cast<jlong>(token), x, y); });
  }

  void fetchText(std::uint64_t token, const std::string& url) override {
    withEnv("fetchText", [&](JNIEnv* env) {
      jstring u = toJString(env, url);
      env->CallVoidMethod(host_, fetchText_, static_cast<jlong>(token), u);
      env->DeleteLocalRef(u);
    });
  }

  void scheduleFrame(double delayMs) override {
    withEnv("scheduleFrame", [&](JNIEnv* env) { env->CallVoidMethod(host_, scheduleFrame_, delayMs); });
  }

  void setBuildingLayer(std::shared_ptr<const maprama::BuildingLayerData> data) override {
    // The render thread reads the data through the shared state; Kotlin only (re)installs the layer.
    buildingState_->setData(std::move(data));
    withEnv("buildingLayerChanged", [&](JNIEnv* env) { env->CallVoidMethod(host_, buildingLayerChanged_); });
  }

  const std::shared_ptr<maprama::android::BuildingLayerState>& buildingState() const { return buildingState_; }

  void setSourceData(const std::string& sourceId, std::string geojson) override {
    withEnv("setSourceData", [&](JNIEnv* env) {
      jstring id = toJString(env, sourceId);
      jstring data = toJString(env, geojson);
      env->CallVoidMethod(host_, setSourceData_, id, data);
      env->DeleteLocalRef(id);
      env->DeleteLocalRef(data);
    });
  }

  void startLocationUpdates() override {
    withEnv("startLocationUpdates", [&](JNIEnv* env) { env->CallVoidMethod(host_, startLocationUpdates_); });
  }

  void stopLocationUpdates() override {
    withEnv("stopLocationUpdates", [&](JNIEnv* env) { env->CallVoidMethod(host_, stopLocationUpdates_); });
  }

 private:
  template <class F>
  void withEnv(const char* where, F&& call) {
    JNIEnv* env = currentEnv();
    if (env == nullptr) return;
    call(env);
    clearException(env, where);
  }

  static void setString(JNIEnv* env, jobjectArray array, jsize index, std::string_view utf8) {
    jstring s = toJString(env, utf8);
    env->SetObjectArrayElement(array, index, s);
    env->DeleteLocalRef(s);
  }

  jobject host_;
  jclass stringClass_ = nullptr;
  jmethodID setStyleJson_ = nullptr;
  jmethodID setPaintProperties_ = nullptr;
  jmethodID setLight_ = nullptr;
  jmethodID setUi_ = nullptr;
  jmethodID setCameraLimits_ = nullptr;
  jmethodID moveCamera_ = nullptr;
  jmethodID project_ = nullptr;
  jmethodID projectPoints_ = nullptr;
  jmethodID unproject_ = nullptr;
  jmethodID queryBuilding_ = nullptr;
  jmethodID fetchText_ = nullptr;
  jmethodID scheduleFrame_ = nullptr;
  jmethodID buildingLayerChanged_ = nullptr;
  std::shared_ptr<maprama::android::BuildingLayerState> buildingState_ = std::make_shared<maprama::android::BuildingLayerState>();
  jmethodID setSourceData_ = nullptr;
  jmethodID startLocationUpdates_ = nullptr;
  jmethodID stopLocationUpdates_ = nullptr;
};

/// What the Kotlin view holds as a `long` handle.
struct EngineHandle {
  std::string engineId;
  std::shared_ptr<maprama::Engine> engine;
  std::shared_ptr<JniMapAdapter> adapter;
};

EngineHandle* fromHandle(jlong handle) { return reinterpret_cast<EngineHandle*>(handle); }

}  // namespace

extern "C" {

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*reserved*/) {
  gVm = vm;
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
  jclass local = env->FindClass("dev/maprama/enginenative/MapramaEngineModule");
  if (local == nullptr) {
    clearException(env, "FindClass MapramaEngineModule");
    return JNI_VERSION_1_6;
  }
  gModuleClass = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  gDispatchEvent = env->GetStaticMethodID(gModuleClass, "dispatchEvent", "(Ljava/lang/String;Ljava/lang/String;)V");
  clearException(env, "GetStaticMethodID dispatchEvent");
  return JNI_VERSION_1_6;
}

JNIEXPORT jlong JNICALL Java_dev_maprama_enginenative_MapramaJni_create(JNIEnv* env, jclass, jstring engineId, jobject host,
                                                                        jboolean validateEvents) {
  auto* handle = new EngineHandle();
  handle->engineId = toUtf8(env, engineId);
  maprama::EngineConfig config;
  config.validateOutgoingEvents = validateEvents == JNI_TRUE;
  handle->engine = maprama::createEngine(std::make_shared<JniMessageSink>(handle->engineId), config);
  handle->adapter = std::make_shared<JniMapAdapter>(env, host);
  maprama::EngineRegistry::shared().add(handle->engineId, handle->engine);
  handle->engine->attachMapAdapter(handle->adapter);
  return reinterpret_cast<jlong>(handle);
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_start(JNIEnv*, jclass, jlong handle) {
  if (handle != 0) fromHandle(handle)->engine->start();
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_destroy(JNIEnv*, jclass, jlong handle) {
  if (handle == 0) return;
  EngineHandle* h = fromHandle(handle);
  maprama::EngineRegistry::shared().remove(h->engineId, h->engine.get());
  h->engine->shutdown();  // detaches the adapter under the engine lock; no core call reaches it afterwards
  delete h;
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_setViewport(JNIEnv*, jclass, jlong handle, jdouble width,
                                                                             jdouble height, jdouble pixelRatio) {
  if (handle != 0) fromHandle(handle)->engine->setViewport(maprama::Viewport{width, height, pixelRatio});
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onCameraChanged(JNIEnv*, jclass, jlong handle, jdouble lng,
                                                                                 jdouble lat, jdouble zoom, jdouble pitch,
                                                                                 jdouble bearing) {
  if (handle == 0) return;
  maprama::MapCameraPose pose;
  pose.center = maprama::LngLat{lng, lat};
  pose.zoom = zoom;
  pose.pitch = pitch;
  pose.bearing = bearing;
  fromHandle(handle)->engine->onCameraChanged(pose);
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onProjected(JNIEnv*, jclass, jlong handle, jlong token,
                                                                             jdouble x, jdouble y) {
  if (handle != 0) fromHandle(handle)->engine->onProjected(static_cast<std::uint64_t>(token), x, y);
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onUnprojected(JNIEnv*, jclass, jlong handle, jlong token,
                                                                               jboolean hit, jdouble lng, jdouble lat) {
  if (handle == 0) return;
  std::optional<maprama::LngLat> coordinate;
  if (hit == JNI_TRUE) coordinate = maprama::LngLat{lng, lat};
  fromHandle(handle)->engine->onUnprojected(static_cast<std::uint64_t>(token), coordinate);
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onPointsProjected(JNIEnv* env, jclass, jlong handle,
                                                                                   jlong token, jdoubleArray xy) {
  if (handle == 0) return;
  const jsize n = xy != nullptr ? env->GetArrayLength(xy) : 0;
  std::vector<jdouble> flat(static_cast<std::size_t>(n));
  if (n > 0) env->GetDoubleArrayRegion(xy, 0, n, flat.data());
  std::vector<maprama::ScreenPoint> points;
  points.reserve(flat.size() / 2);
  for (std::size_t i = 0; i + 1 < flat.size(); i += 2) points.push_back(maprama::ScreenPoint{flat[i], flat[i + 1], false});
  fromHandle(handle)->engine->onPointsProjected(static_cast<std::uint64_t>(token), std::move(points));
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onBuildingQueried(JNIEnv* env, jclass, jlong handle,
                                                                                   jlong token, jstring buildingId,
                                                                                   jboolean groundHit, jdouble lng, jdouble lat) {
  if (handle == 0) return;
  std::optional<std::string> id;
  if (buildingId != nullptr) id = toUtf8(env, buildingId);
  std::optional<maprama::LngLat> ground;
  if (groundHit == JNI_TRUE) ground = maprama::LngLat{lng, lat};
  fromHandle(handle)->engine->onBuildingQueried(static_cast<std::uint64_t>(token), std::move(id), ground);
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_tap(JNIEnv*, jclass, jlong handle, jdouble x, jdouble y) {
  if (handle != 0) fromHandle(handle)->engine->tap(x, y);
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_zoomButton(JNIEnv*, jclass, jlong handle, jboolean zoomIn) {
  if (handle != 0) fromHandle(handle)->engine->zoomButton(zoomIn == JNI_TRUE);
}

JNIEXPORT jlong JNICALL Java_dev_maprama_enginenative_MapramaJni_createBuildingLayerHost(JNIEnv*, jclass, jlong handle) {
  if (handle == 0) return 0;
  // Ownership passes to MapLibre (`CustomLayer` wraps it in a unique_ptr<CustomLayerHost>); the host shares
  // only the data state, so it may outlive the engine handle on the render thread.
  auto* host = new maprama::android::BuildingLayerHost(fromHandle(handle)->adapter->buildingState());
  return reinterpret_cast<jlong>(static_cast<mln::style::CustomLayerHost*>(host));
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_setBuildingLayersAbove(JNIEnv*, jclass, jlong handle, jint count) {
  if (handle != 0) fromHandle(handle)->adapter->buildingState()->setLayersAbove(static_cast<int>(count));
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onDeviceLocation(JNIEnv*, jclass, jlong handle, jdouble lng,
                                                                                  jdouble lat, jdouble accuracyMeters,
                                                                                  jdouble headingDeg, jdouble speedMps,
                                                                                  jdouble timestampMs) {
  if (handle == 0) return;
  maprama::LocationFix fix;
  fix.lng = lng;
  fix.lat = lat;
  if (!std::isnan(accuracyMeters)) fix.accuracyMeters = accuracyMeters;
  if (!std::isnan(headingDeg)) fix.headingDeg = headingDeg;
  if (!std::isnan(speedMps)) fix.speedMps = speedMps;
  fix.timestamp = timestampMs;
  fromHandle(handle)->engine->onDeviceLocation(fix);
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onDeviceLocationError(JNIEnv* env, jclass, jlong handle,
                                                                                       jstring message) {
  if (handle != 0) fromHandle(handle)->engine->onDeviceLocationError(toUtf8(env, message));
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onUserPan(JNIEnv*, jclass, jlong handle) {
  if (handle != 0) fromHandle(handle)->engine->onUserPan();
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onTextFetched(JNIEnv* env, jclass, jlong handle, jlong token,
                                                                               jboolean ok, jstring body) {
  if (handle != 0) fromHandle(handle)->engine->onTextFetched(static_cast<std::uint64_t>(token), ok == JNI_TRUE, toUtf8(env, body));
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_frame(JNIEnv*, jclass, jlong handle, jdouble timestampMs) {
  if (handle != 0) fromHandle(handle)->engine->frame(timestampMs);
}

JNIEXPORT jboolean JNICALL Java_dev_maprama_enginenative_MapramaJni_postMessage(JNIEnv* env, jclass, jstring engineId,
                                                                                 jstring envelope) {
  std::shared_ptr<maprama::Engine> engine = maprama::EngineRegistry::shared().find(toUtf8(env, engineId));
  if (!engine) return JNI_FALSE;
  engine->postMessage(toUtf8(env, envelope));
  return JNI_TRUE;
}

JNIEXPORT jboolean JNICALL Java_dev_maprama_enginenative_MapramaJni_postMessages(JNIEnv* env, jclass, jstring engineId,
                                                                                  jobjectArray envelopes) {
  std::shared_ptr<maprama::Engine> engine = maprama::EngineRegistry::shared().find(toUtf8(env, engineId));
  if (!engine) return JNI_FALSE;
  const jsize count = env->GetArrayLength(envelopes);
  std::vector<std::string> batch;
  batch.reserve(static_cast<std::size_t>(count));
  for (jsize i = 0; i < count; ++i) {
    auto item = static_cast<jstring>(env->GetObjectArrayElement(envelopes, i));
    batch.push_back(toUtf8(env, item));
    env->DeleteLocalRef(item);
  }
  engine->postMessages(batch);
  return JNI_TRUE;
}

}  // extern "C"
