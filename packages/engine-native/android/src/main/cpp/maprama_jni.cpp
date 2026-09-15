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
#include <pthread.h>

#include <climits>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/Engine.hpp"
#include "maprama/EngineRegistry.hpp"
#include "maprama/LabelIcons.hpp"
#include "maprama/MapAdapter.hpp"
#include "maprama_building_layer.hpp"

namespace {

constexpr const char* kTag = "MapramaEngine";

JavaVM* gVm = nullptr;
jclass gModuleClass = nullptr;
jmethodID gDispatchEvent = nullptr;
/// `MapramaJni.decodeImage` (M3b glTF textures), cached at load time: worker threads cannot FindClass app classes.
jclass gJniClass = nullptr;
jmethodID gDecodeImage = nullptr;

/// Native threads that attach to the VM (the M3b model workers deliver results, emit events and call the adapter)
/// are detached when they exit (ART aborts when an attached thread ends).
pthread_key_t gDetachKey;
std::once_flag gDetachKeyOnce;

JNIEnv* currentEnv() {
  JNIEnv* env = nullptr;
  if (gVm == nullptr) return nullptr;
  const jint status = gVm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
  if (status == JNI_EDETACHED) {
    if (gVm->AttachCurrentThread(&env, nullptr) != JNI_OK) return nullptr;
    std::call_once(gDetachKeyOnce, [] {
      pthread_key_create(&gDetachKey, [](void*) {
        if (gVm != nullptr) gVm->DetachCurrentThread();
      });
    });
    pthread_setspecific(gDetachKey, env);
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

/// M3b glTF base colour textures: PNG / JPEG -> RGBA8 through `MapramaJni.decodeImage` (BitmapFactory, straight
/// alpha). Called on the model worker threads.
bool decodeImageAndroid(const std::uint8_t* data, std::size_t size, maprama::ModelTexture& out) {
  if (gJniClass == nullptr || gDecodeImage == nullptr || size == 0 || size > static_cast<std::size_t>(INT_MAX)) return false;
  JNIEnv* env = currentEnv();
  if (env == nullptr) return false;
  bool ok = false;
  jbyteArray input = env->NewByteArray(static_cast<jsize>(size));
  if (input == nullptr) {
    clearException(env, "decodeImage NewByteArray");
    return false;
  }
  env->SetByteArrayRegion(input, 0, static_cast<jsize>(size), reinterpret_cast<const jbyte*>(data));
  auto result = static_cast<jintArray>(env->CallStaticObjectMethod(gJniClass, gDecodeImage, input));
  clearException(env, "MapramaJni.decodeImage");
  if (result != nullptr) {
    const jsize n = env->GetArrayLength(result);
    jint* px = n >= 2 ? env->GetIntArrayElements(result, nullptr) : nullptr;
    if (px != nullptr) {
      const jint w = px[0], h = px[1];
      if (w > 0 && h > 0 && static_cast<jlong>(w) * h + 2 == n) {
        out.width = w;
        out.height = h;
        out.rgba.resize(static_cast<std::size_t>(w) * static_cast<std::size_t>(h) * 4);
        for (std::size_t i = 0; i < static_cast<std::size_t>(w) * static_cast<std::size_t>(h); ++i) {
          const auto argb = static_cast<std::uint32_t>(px[2 + i]);
          out.rgba[i * 4] = static_cast<std::uint8_t>((argb >> 16) & 0xFF);
          out.rgba[i * 4 + 1] = static_cast<std::uint8_t>((argb >> 8) & 0xFF);
          out.rgba[i * 4 + 2] = static_cast<std::uint8_t>(argb & 0xFF);
          out.rgba[i * 4 + 3] = static_cast<std::uint8_t>(argb >> 24);
        }
        ok = true;
      }
      env->ReleaseIntArrayElements(result, px, JNI_ABORT);
    }
    env->DeleteLocalRef(result);
  }
  env->DeleteLocalRef(input);
  return ok;
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
    modelLayerChanged_ = env->GetMethodID(cls, "modelLayerChanged", "()V");
    fetchBinary_ = env->GetMethodID(cls, "fetchBinary", "(JLjava/lang/String;)V");
    measureLabels_ = env->GetMethodID(cls, "measureLabels", "(J[Ljava/lang/String;[I)V");
    setLabelFrame_ = env->GetMethodID(
        cls, "setLabelFrame", "(JIIZ[Ljava/lang/String;[Ljava/lang/String;[Ljava/lang/String;[I[D)V");
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

  void setModelLayer(std::shared_ptr<const maprama::ModelLayerFrame> frame) override {
    // The render thread reads the frame through the shared state; Kotlin coalesces the redraws.
    buildingState_->setModelFrame(std::move(frame));
    withEnv("modelLayerChanged", [&](JNIEnv* env) { env->CallVoidMethod(host_, modelLayerChanged_); });
  }

  void fetchBinary(std::uint64_t token, const std::string& url) override {
    withEnv("fetchBinary", [&](JNIEnv* env) {
      jstring u = toJString(env, url);
      env->CallVoidMethod(host_, fetchBinary_, static_cast<jlong>(token), u);
      env->DeleteLocalRef(u);
    });
  }

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

  void measureLabels(std::uint64_t token, const std::vector<maprama::LabelCardContent>& items) override {
    withEnv("measureLabels", [&](JNIEnv* env) {
      const auto n = static_cast<jsize>(items.size());
      jobjectArray strings = env->NewObjectArray(n * 3, stringClass_, nullptr);
      std::vector<jint> ints;
      ints.reserve(items.size() * 5);
      for (jsize i = 0; i < n; ++i) packContent(env, strings, i, ints, items[static_cast<std::size_t>(i)]);
      jintArray intArray = env->NewIntArray(static_cast<jsize>(ints.size()));
      env->SetIntArrayRegion(intArray, 0, static_cast<jsize>(ints.size()), ints.data());
      env->CallVoidMethod(host_, measureLabels_, static_cast<jlong>(token), strings, intArray);
      env->DeleteLocalRef(strings);
      env->DeleteLocalRef(intArray);
    });
  }

  void setLabelFrame(const maprama::LabelFrame& frame) override {
    withEnv("setLabelFrame", [&](JNIEnv* env) {
      const auto n = static_cast<jsize>(frame.cards.size());
      jobjectArray ids = env->NewObjectArray(n, stringClass_, nullptr);
      jobjectArray keys = env->NewObjectArray(n, stringClass_, nullptr);
      jobjectArray strings = env->NewObjectArray(n * 3, stringClass_, nullptr);
      std::vector<jint> ints;
      ints.reserve(frame.cards.size() * 5);
      std::vector<jdouble> numbers;
      numbers.reserve(frame.cards.size() * 10);
      for (jsize i = 0; i < n; ++i) {
        const maprama::LabelCard& c = frame.cards[static_cast<std::size_t>(i)];
        setString(env, ids, i, c.id);
        setString(env, keys, i, c.content.key);
        packContent(env, strings, i, ints, c.content);
        for (double v : {c.x, c.y, c.width, c.height, c.angle, c.opacity, c.dotX, c.dotY, c.lineX, c.lineY}) numbers.push_back(v);
      }
      jintArray intArray = env->NewIntArray(static_cast<jsize>(ints.size()));
      env->SetIntArrayRegion(intArray, 0, static_cast<jsize>(ints.size()), ints.data());
      jdoubleArray numberArray = env->NewDoubleArray(static_cast<jsize>(numbers.size()));
      env->SetDoubleArrayRegion(numberArray, 0, static_cast<jsize>(numbers.size()), numbers.data());
      env->CallVoidMethod(host_, setLabelFrame_, static_cast<jlong>(frame.sequence), static_cast<jint>(frame.visual),
                          static_cast<jint>(frame.tile), static_cast<jboolean>(frame.night), ids, keys, strings, intArray,
                          numberArray);
      env->DeleteLocalRef(ids);
      env->DeleteLocalRef(keys);
      env->DeleteLocalRef(strings);
      env->DeleteLocalRef(intArray);
      env->DeleteLocalRef(numberArray);
    });
  }

 private:
  /// 3 strings (title, subtitle, accessibility label) at `index * 3` and 4 ints (visual, kind, flags, icon).
  static void packContent(JNIEnv* env, jobjectArray strings, jsize index, std::vector<jint>& ints,
                          const maprama::LabelCardContent& c) {
    setString(env, strings, index * 3, c.title);
    setString(env, strings, index * 3 + 1, c.subtitle);
    setString(env, strings, index * 3 + 2, c.accessibilityLabel);
    const jint flags = (c.water ? 1 : 0) | (c.arterial ? 2 : 0) | (c.showIcon ? 4 : 0) | (c.showSubtitle ? 8 : 0) |
                       (c.custom ? 16 : 0) | (c.player ? 32 : 0);
    ints.push_back(static_cast<jint>(c.visual));
    ints.push_back(static_cast<jint>(c.kind));
    ints.push_back(flags);
    ints.push_back(static_cast<jint>(c.icon));
    ints.push_back(static_cast<jint>(c.color & 0xFFFFFFu));
  }

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
  jmethodID modelLayerChanged_ = nullptr;
  jmethodID fetchBinary_ = nullptr;
  jmethodID measureLabels_ = nullptr;
  jmethodID setLabelFrame_ = nullptr;
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
  jclass jni = env->FindClass("dev/maprama/enginenative/MapramaJni");
  if (jni != nullptr) {
    gJniClass = static_cast<jclass>(env->NewGlobalRef(jni));
    env->DeleteLocalRef(jni);
    gDecodeImage = env->GetStaticMethodID(gJniClass, "decodeImage", "([B)[I");
  }
  clearException(env, "MapramaJni.decodeImage lookup");
  return JNI_VERSION_1_6;
}

JNIEXPORT jlong JNICALL Java_dev_maprama_enginenative_MapramaJni_create(JNIEnv* env, jclass, jstring engineId, jobject host,
                                                                        jboolean validateEvents) {
  auto* handle = new EngineHandle();
  handle->engineId = toUtf8(env, engineId);
  maprama::EngineConfig config;
  config.validateOutgoingEvents = validateEvents == JNI_TRUE;
  config.decodeImage = decodeImageAndroid;
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

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onBinaryFetched(JNIEnv* env, jclass, jlong handle, jlong token,
                                                                                 jboolean ok, jbyteArray bytes, jstring message) {
  if (handle == 0) return;
  const bool success = ok == JNI_TRUE && bytes != nullptr;
  std::string payload;
  if (success) {
    const jsize n = env->GetArrayLength(bytes);
    payload.resize(static_cast<std::size_t>(n));
    if (n > 0) env->GetByteArrayRegion(bytes, 0, n, reinterpret_cast<jbyte*>(&payload[0]));
  } else {
    payload = toUtf8(env, message);
  }
  fromHandle(handle)->engine->onBinaryFetched(static_cast<std::uint64_t>(token), success, std::move(payload));
}

JNIEXPORT void JNICALL Java_dev_maprama_enginenative_MapramaJni_onLabelsMeasured(JNIEnv* env, jclass, jlong handle,
                                                                                  jlong token, jdoubleArray sizes) {
  if (handle == 0) return;
  const jsize n = sizes != nullptr ? env->GetArrayLength(sizes) : 0;
  std::vector<jdouble> flat(static_cast<std::size_t>(n));
  if (n > 0) env->GetDoubleArrayRegion(sizes, 0, n, flat.data());
  std::vector<maprama::LabelSize> out;
  out.reserve(flat.size() / 2);
  for (std::size_t i = 0; i + 1 < flat.size(); i += 2) out.push_back(maprama::LabelSize{flat[i], flat[i + 1]});
  fromHandle(handle)->engine->onLabelsMeasured(static_cast<std::uint64_t>(token), std::move(out));
}

// [color, size, roundCaps, textLength, text code points..., shapeCount,
//  (fill, fillOpacity, stroke, strokeWidth, opCount, ops (M 0, L 1, C 2, Z 3)..., coordCount, coords...)...]
JNIEXPORT jfloatArray JNICALL Java_dev_maprama_enginenative_MapramaJni_labelIconData(JNIEnv* env, jclass, jboolean glyph,
                                                                                    jint icon) {
  if (icon < 0 || icon >= static_cast<jint>(maprama::EnumNames<maprama::LabelIcon>::values.size())) return nullptr;
  const auto labelIcon = static_cast<maprama::LabelIcon>(icon);
  const maprama::IconDrawing* d = glyph == JNI_TRUE ? maprama::poiGlyph(labelIcon) : &maprama::holoIcon(labelIcon);
  if (d == nullptr) return nullptr;
  std::vector<float> out;
  out.push_back(static_cast<float>(maprama::iconColor(labelIcon)));
  out.push_back(d->size);
  out.push_back(d->roundCaps ? 1.0f : 0.0f);
  const std::string text = d->text != nullptr ? d->text : "";
  out.push_back(static_cast<float>(text.size()));  // ASCII only ("M")
  for (char ch : text) out.push_back(static_cast<float>(static_cast<unsigned char>(ch)));
  out.push_back(static_cast<float>(d->shapeCount));
  for (std::size_t i = 0; i < d->shapeCount; ++i) {
    const maprama::IconShape& s = d->shapes[i];
    out.push_back(static_cast<float>(s.fill));
    out.push_back(s.fillOpacity);
    out.push_back(static_cast<float>(s.stroke));
    out.push_back(s.strokeWidth);
    const std::string ops = s.ops;
    out.push_back(static_cast<float>(ops.size()));
    for (char op : ops) out.push_back(op == 'M' ? 0.0f : op == 'L' ? 1.0f : op == 'C' ? 2.0f : 3.0f);
    out.push_back(static_cast<float>(s.coordCount));
    for (std::size_t k = 0; k < s.coordCount; ++k) out.push_back(s.coords[k]);
  }
  jfloatArray array = env->NewFloatArray(static_cast<jsize>(out.size()));
  env->SetFloatArrayRegion(array, 0, static_cast<jsize>(out.size()), out.data());
  return array;
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
