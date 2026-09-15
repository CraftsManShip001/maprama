// Shared fixtures of the map session suites (M1 + M2a): a recording MessageSink, a fake MapAdapter that
// records every call, and an engine harness with an injected clock. Every emitted envelope is appended to
// --emit so that scripts/verify-emitted-events.mjs validates it with the TypeScript decodeEvent.
#pragma once

#include <cstdint>
#include <cstdio>
#include <fstream>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "maprama/BuildingMesh.hpp"
#include "maprama/Engine.hpp"
#include "maprama/MapAdapter.hpp"
#include "maprama/MapLook.hpp"
#include "maprama/ModelLayer.hpp"
#include "maprama/RoadGraph.hpp"
#include "maprama/protocol.hpp"
#include "harness.hpp"

namespace maprama::test::maptest {

using json::Value;

class RecordingSink final : public MessageSink {
 public:
  void onEvent(std::string envelopeJson) override { events.push_back(std::move(envelopeJson)); }
  void onLog(LogLevel level, std::string_view message) override { logs.emplace_back(level, message); }

  Value eventMsg(std::size_t i) const { return protocol::decodeEvent(events.at(i)).value.msg; }
  std::vector<Value> eventsOfType(const std::string& type, std::size_t from = 0) const {
    std::vector<Value> out;
    for (std::size_t i = from; i < events.size(); ++i) {
      Value m = eventMsg(i);
      if (m.find("type")->asString() == type) out.push_back(std::move(m));
    }
    return out;
  }
  bool loggedContaining(const std::string& needle, LogLevel level) const { return countLogs(needle, level) > 0; }
  std::size_t countLogs(const std::string& needle, LogLevel level) const {
    std::size_t n = 0;
    for (const auto& l : logs) n += (l.first == level && l.second.find(needle) != std::string::npos) ? 1 : 0;
    return n;
  }
  std::size_t errors() const {
    std::size_t n = 0;
    for (const auto& l : logs) n += l.first == LogLevel::Error ? 1 : 0;
    return n;
  }

  std::vector<std::string> events;
  std::vector<std::pair<LogLevel, std::string>> logs;
};

class FakeAdapter final : public MapAdapter {
 public:
  void setStyleJson(std::string styleJson) override { styles.push_back(std::move(styleJson)); }
  void setPaintProperties(const std::vector<PaintPropertyChange>& changes) override { paints.push_back(changes); }
  void setLight(const MapLight& light) override { lights.push_back(light); }
  void setUi(const MapUiState& ui) override { uis.push_back(ui); }
  void setBuildingLayer(std::shared_ptr<const BuildingLayerData> data) override { buildingLayers.push_back(std::move(data)); }
  void setCameraLimits(const MapCameraLimits& l) override { limits.push_back(l); }
  void moveCamera(const MapCameraPose& pose, double durationMs) override { moves.emplace_back(pose, durationMs); }
  void project(std::uint64_t token, const LngLat& coordinate) override { projects.emplace_back(token, coordinate); }
  void projectPoints(std::uint64_t token, const std::vector<LngLat>& coordinates) override {
    pointProjections.emplace_back(token, coordinates);
  }
  void unproject(std::uint64_t token, double x, double y) override { unprojects.emplace_back(token, x, y); }
  void queryBuilding(std::uint64_t token, double x, double y) override { queries.emplace_back(token, x, y); }
  void fetchText(std::uint64_t token, const std::string& url) override { fetches.emplace_back(token, url); }
  void scheduleFrame(double delayMs) override { frames.push_back(delayMs); }
  void setSourceData(const std::string& sourceId, std::string geojson) override {
    sourceData.emplace_back(sourceId, std::move(geojson));
  }
  void startLocationUpdates() override { ++locationStarts; }
  void stopLocationUpdates() override { ++locationStops; }
  void setModelLayer(std::shared_ptr<const ModelLayerFrame> frame) override { modelFrames.push_back(std::move(frame)); }
  void fetchBinary(std::uint64_t token, const std::string& url) override { binaryFetches.emplace_back(token, url); }

  /// The characters (or drops) of the last model frame as a GeoJSON-like FeatureCollection (`properties` and a point
  /// `geometry`), so the M3a assertions read the M3b model layer the way they read the former marker sources.
  /// Null when no model frame was sent.
  Value modelCollection(ModelVisual::Kind kind) const {
    if (modelFrames.empty() || !modelFrames.back()) return Value();
    Value features = Value::array();
    for (const ModelVisual& v : modelFrames.back()->visuals) {
      if (v.kind != kind) continue;
      Value props = Value::object({{"id", v.id}, {"color", cssHex(v.color)}});
      if (kind == ModelVisual::Kind::Character) {
        props.set("kind", "body");
        props.set("scale", v.scale);
        props.set("player", v.isPlayer);
        props.set("mode", std::string(enumName(v.mode)));
        props.set("gltf", v.gltf);
        props.set("animation", v.animation ? Value(std::string(enumName(*v.animation))) : Value(nullptr));
        props.set("altitude", v.altitude);
        props.set("heading", v.headingDeg);
      } else {
        props.set("layer", v.layerId);
        props.set("pop", v.pop);
        props.set("type", std::string(enumName(v.type)));
        props.set("rarity", std::string(enumName(v.rarity)));
        props.set("gltf", v.gltf);
      }
      features.push(Value::object({{"type", "Feature"},
                                   {"properties", std::move(props)},
                                   {"geometry", Value::object({{"type", "Point"}, {"coordinates", Value::array({v.position.lng, v.position.lat})}})}}));
    }
    return Value::object({{"type", "FeatureCollection"}, {"features", std::move(features)}});
  }

  /// The last data sent for a game source, parsed (null when none was sent).
  Value lastSource(const std::string& sourceId) const {
    for (auto it = sourceData.rbegin(); it != sourceData.rend(); ++it) {
      if (it->first == sourceId) return json::parse(it->second).value;
    }
    return Value();
  }
  std::size_t sourceUpdates(const std::string& sourceId) const {
    std::size_t n = 0;
    for (const auto& s : sourceData) n += s.first == sourceId ? 1 : 0;
    return n;
  }

  /// The paint change for `layer` / `property` in the last `setPaintProperties` batch, if any.
  const PaintPropertyChange* lastPaint(const std::string& layer, const std::string& property) const {
    if (paints.empty()) return nullptr;
    for (const PaintPropertyChange& c : paints.back()) {
      if (c.layerId == layer && c.property == property) return &c;
    }
    return nullptr;
  }

  std::vector<std::string> styles;
  std::vector<std::vector<PaintPropertyChange>> paints;
  std::vector<MapLight> lights;
  std::vector<MapUiState> uis;
  std::vector<std::shared_ptr<const BuildingLayerData>> buildingLayers;
  std::vector<MapCameraLimits> limits;
  std::vector<std::pair<MapCameraPose, double>> moves;
  std::vector<std::pair<std::uint64_t, LngLat>> projects;
  std::vector<std::pair<std::uint64_t, std::vector<LngLat>>> pointProjections;
  std::vector<std::tuple<std::uint64_t, double, double>> unprojects;
  std::vector<std::tuple<std::uint64_t, double, double>> queries;
  std::vector<std::pair<std::uint64_t, std::string>> fetches;
  std::vector<double> frames;
  std::vector<std::pair<std::string, std::string>> sourceData;
  std::vector<std::shared_ptr<const ModelLayerFrame>> modelFrames;
  std::vector<std::pair<std::uint64_t, std::string>> binaryFetches;
  int locationStarts = 0;
  int locationStops = 0;
};

struct Harness {
  std::shared_ptr<RecordingSink> sink = std::make_shared<RecordingSink>();
  std::shared_ptr<FakeAdapter> adapter = std::make_shared<FakeAdapter>();
  double now = 1000.0;
  std::unique_ptr<Engine> engine;
  std::uint64_t seq = 0;
  js_math::Mulberry32 rng{20260916};
  std::uint64_t collectIds = 0;
  /// Makes the collectId generator return the previous id again (duplicate-id failure path).
  bool repeatCollectIds = false;
  /// Model parsing jobs (`EngineConfig::runAsync`), run outside the engine lock by `runJobs` / `run`.
  std::vector<std::function<void()>> jobs;

  explicit Harness(bool attach = true, Viewport viewport = {390, 500, 3}) {
    EngineConfig config;
    config.validateOutgoingEvents = true;
    config.clockMs = [this] { return now; };
    // Deterministic simulated walker and collectIds (UUID v4 shaped).
    config.random = [this] { return rng(); };
    config.collectId = [this] {
      char id[40];
      if (!repeatCollectIds) ++collectIds;
      std::snprintf(id, sizeof id, "00000000-0000-4000-8000-%012llx", static_cast<unsigned long long>(collectIds));
      return std::string(id);
    };
    config.runAsync = [this](std::function<void()> job) { jobs.push_back(std::move(job)); };
    engine = createEngine(sink, config);
    engine->start();
    if (attach) engine->attachMapAdapter(adapter);
    if (viewport.height > 0) engine->setViewport(viewport);
  }

  void send(const Value& msg) { engine->postMessage(protocol::encodeCommand(msg, seq++)); }

  /// Runs the queued worker jobs (and the jobs they queue).
  void runJobs() {
    while (!jobs.empty()) {
      std::vector<std::function<void()>> list = std::move(jobs);
      jobs.clear();
      for (std::function<void()>& job : list) job();
    }
  }

  /// Advances the clock in 16 ms frames for `ms` milliseconds, delivering a frame each step (the sessions
  /// ignore frames they did not ask for).
  void run(double ms) {
    for (double t = 0; t < ms; t += 16) {
      runJobs();
      now += 16;
      engine->frame(now);
    }
  }
};

inline Value lngLat(double lng, double lat) { return Value::object({{"lng", lng}, {"lat", lat}}); }

inline Value initMsg(Value worldSource, std::optional<Value> camera = std::nullopt, Value theme = Value::object(),
                     Value ui = Value::object()) {
  Value msg = Value::object({{"type", "init"},
                             {"world", std::move(worldSource)},
                             {"theme", std::move(theme)},
                             {"labels", Value::object()},
                             {"ui", std::move(ui)},
                             {"locationSource", "external"}});
  if (camera) msg.set("camera", std::move(*camera));
  return msg;
}

inline std::string seongsuText(const Context& ctx) {
  const Value fixture = loadFixture(ctx, "world.json");
  for (const Value& c : fixture.find("cases")->items()) {
    if (const Value* path = c.find("inputPath")) return readFile(path->asString());
  }
  throw std::runtime_error("world.json fixture has no Seongsu sample case (tools/osm/samples/seongsu.world.json)");
}

inline Value seongsuValue(const Context& ctx) { return json::parse(seongsuText(ctx)).value; }

inline Value dataWorld(const Context& ctx) { return Value::object({{"kind", "data"}, {"world", seongsuValue(ctx)}}); }

inline Value setCameraMsg(Value camera) { return Value::object({{"type", "setCamera"}, {"camera", std::move(camera)}}); }

inline void appendEmitted(const Context& ctx, const RecordingSink& sink) {
  if (ctx.emitPath.empty()) return;
  std::ofstream out(ctx.emitPath, std::ios::app);
  for (const std::string& e : sink.events) out << e << "\n";
}

inline std::size_t countFeatures(const Value& style, const char* source) {
  return style.find("sources")->find(source)->find("data")->find("features")->items().size();
}

inline const Value* findLayer(const Value& style, const std::string& id) {
  for (const Value& l : style.find("layers")->items()) {
    if (l.find("id")->asString() == id) return &l;
  }
  return nullptr;
}

inline bool hasLayer(const Value& style, const std::string& id) { return findLayer(style, id) != nullptr; }

/// `layer.paint[property]` serialised, or "" when absent.
inline std::string paintOf(const Value& style, const std::string& layer, const std::string& property) {
  const Value* l = findLayer(style, layer);
  const Value* p = l != nullptr ? l->find("paint") : nullptr;
  const Value* v = p != nullptr ? p->find(property) : nullptr;
  return v != nullptr ? json::stringify(*v) : std::string();
}

}  // namespace maprama::test::maptest
