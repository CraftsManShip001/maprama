// M1 map session: world style, setCamera merge, camera:change throttling, project/unproject through a fake
// MapAdapter, url worlds, viewport changes. Every emitted envelope is appended to --emit so that
// scripts/verify-emitted-events.mjs validates it with the TypeScript decodeEvent.
#include <cmath>
#include <memory>
#include <optional>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "maprama/CameraMath.hpp"
#include "maprama/Engine.hpp"
#include "maprama/EngineRegistry.hpp"
#include "maprama/MapAdapter.hpp"
#include "maprama/Projection.hpp"
#include "maprama/SubscriptionRegistry.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/protocol.hpp"
#include "harness.hpp"
#include "map_harness.hpp"

namespace {

using maprama::json::Value;
namespace protocol = maprama::protocol;
namespace cm = maprama::camera_math;

using namespace maprama::test::maptest;

}  // namespace

MAPRAMA_TEST(camera_math_conversions) {
  for (double lat : {0.0, 37.5445, -33.9, 60.0}) {
    for (double h : {320.0, 500.0, 932.0}) {
      for (double d : {112.0, 288.0, 1200.0}) {
        const double z = cm::distanceToMapLibreZoom(d, lat, h);
        ctx.near(cm::mapLibreZoomToDistance(z, lat, h), d, 1e-6 * d, "distance -> zoom -> distance");
      }
      // Protocol (web-map, 256-px) zoom z frames the same span as MapLibre zoom z - 1.
      for (double webZoom : {14.0, 16.5, 18.0}) {
        const double d = cm::webZoomToDistance(webZoom, lat, h);
        ctx.near(cm::distanceToMapLibreZoom(d, lat, h), webZoom - 1.0, 1e-6, "web zoom z == MapLibre zoom z - 1");
      }
    }
  }
  ctx.near(cm::normalizeBearing(-90), 270, 0, "bearing -90 -> 270");
  ctx.near(cm::normalizeBearing(720.5), 0.5, 1e-9, "bearing 720.5 -> 0.5");
  ctx.check(cm::normalizeBearing(-0.0) == 0.0 && cm::normalizeBearing(360) == 0.0, "bearing 360 -> 0");
}

MAPRAMA_TEST(subscription_registry_throttle) {
  maprama::SubscriptionRegistry reg;
  using maprama::SubscriptionTopic;
  reg.subscribe(SubscriptionTopic::CameraChange, std::string("ignored"), 100);
  double next = 0;
  ctx.check(reg.takeDue(SubscriptionTopic::CameraChange, 0, &next).size() == 1 && std::isinf(next),
            "a new subscription is due immediately");
  reg.markChanged(SubscriptionTopic::CameraChange);
  ctx.check(reg.takeDue(SubscriptionTopic::CameraChange, 40, &next).empty(), "change inside the window waits");
  ctx.near(next, 60, 1e-9, "wait until the window ends");
  ctx.check(reg.takeDue(SubscriptionTopic::CameraChange, 100, &next).size() == 1, "due when the window ends");
  ctx.check(reg.takeDue(SubscriptionTopic::CameraChange, 500, &next).empty(), "nothing pending, nothing due");
  ctx.check(reg.unsubscribe(SubscriptionTopic::CameraChange, std::nullopt) && !reg.has(SubscriptionTopic::CameraChange),
            "camera:change unsubscribe ignores the id");
  reg.subscribe(SubscriptionTopic::CharacterPosition, std::string("a"), 0);
  reg.subscribe(SubscriptionTopic::CharacterPosition, std::string("b"), 0);
  reg.subscribe(SubscriptionTopic::CharacterPosition, std::string("a"), 50);
  ctx.check(reg.entries().size() == 2, "character:position keyed by id; re-subscribe replaces");
}

MAPRAMA_TEST(engine_registry_is_weak) {
  auto sink = std::make_shared<RecordingSink>();
  std::shared_ptr<maprama::Engine> engine = maprama::createEngine(sink);
  auto& registry = maprama::EngineRegistry::shared();
  registry.add("e1", engine);
  ctx.check(registry.find("e1") == engine, "registered engine found");
  std::shared_ptr<maprama::Engine> other = maprama::createEngine(sink);
  registry.remove("e1", other.get());
  ctx.check(registry.find("e1") == engine, "remove with another engine keeps the entry");
  engine.reset();
  ctx.check(registry.find("e1") == nullptr, "registry does not keep engines alive");
  registry.remove("e1");
  ctx.check(registry.find("missing") == nullptr, "unknown id");
}

MAPRAMA_TEST(m1_init_seongsu_style_and_default_camera) {
  Harness h;
  ctx.check(h.adapter->styles.size() == 1 && maprama::json::parse(h.adapter->styles[0]).ok,
            "attach sends the empty style");
  const Value worldValue = seongsuValue(ctx);
  auto store = maprama::createWorldStore();
  ctx.check(store->load(worldValue).ok(), "Seongsu sample loads");
  const maprama::WorldData& w = *store->world();

  h.send(initMsg(Value::object({{"kind", "data"}, {"world", worldValue}})));
  ctx.check(h.engine->worldStore().loaded(), "init loads the world");
  ctx.check(h.adapter->styles.size() == 2, "init sends the world style");
  const maprama::json::ParseResult style = maprama::json::parse(h.adapter->styles.back());
  if (ctx.check(style.ok, "world style is valid JSON")) {
    const Value& s = style.value;
    ctx.check(s.find("version")->asNumber() == 8, "style version 8");
    ctx.check(countFeatures(s, "maprama-roads") == w.roads.size(), "one road feature per road");
    ctx.check(countFeatures(s, "maprama-buildings") == w.buildings.size(), "one building feature per building");
    ctx.check(countFeatures(s, "maprama-water") == w.water.size(), "one water feature per polygon");
    ctx.check(countFeatures(s, "maprama-parks") == w.parks.size(), "one park feature per park");
    ctx.check(countFeatures(s, "maprama-pois") == w.pois.size(), "one POI feature per POI");
    ctx.check(countFeatures(s, "maprama-stations") == w.stations.size(), "one station feature per station");
    for (const char* id : {"background", "area", "parks", "water", "roads-alley", "roads-local", "roads-arterial",
                           "buildings", "pois", "stations"}) {
      ctx.check(hasLayer(s, id), std::string("style has layer ") + id);
    }
    // Building rings are closed GeoJSON rings in lng/lat.
    const Value& ring = s.find("sources")->find("maprama-buildings")->find("data")->find("features")->items()[0]
                            .find("geometry")->find("coordinates")->items()[0];
    ctx.check(ring.items().size() == w.buildings[0].footprint.size() + 1, "building ring closed");
    const maprama::LngLat first = store->projection()->toLngLat({w.buildings[0].footprint[0][0], w.buildings[0].footprint[0][1]});
    ctx.near(ring.items()[0].items()[0].asNumber(), first.lng, 1e-12, "ring lng via Projection");
    ctx.near(ring.items()[0].items()[1].asNumber(), first.lat, 1e-12, "ring lat via Projection");
  }

  // Default framing: engine-web DEFAULT_ORBIT around the plaza (or bounds centre).
  const maprama::CameraState state = h.engine->cameraState();
  maprama::WorldPoint start{(w.bounds.minX + w.bounds.maxX) / 2, (w.bounds.minZ + w.bounds.maxZ) / 2};
  if (w.plaza) start = *w.plaza;
  const maprama::LngLat startLL = store->projection()->toLngLat(start);
  ctx.near(state.center.lng, startLL.lng, 1e-12, "default centre lng");
  ctx.near(state.center.lat, startLL.lat, 1e-12, "default centre lat");
  ctx.near(state.distance, 36 * w.unitMeters, 1e-9, "default distance 36 world units");
  ctx.check(state.pitch == 50 && state.bearing == 28, "default pitch 50, bearing 28");
  if (ctx.check(!h.adapter->moves.empty(), "init moves the camera")) {
    const auto& [pose, duration] = h.adapter->moves.back();
    ctx.check(duration == 0, "init camera jumps");
    ctx.near(pose.zoom, cm::distanceToMapLibreZoom(state.distance, state.center.lat, 500), 1e-9, "pose zoom from distance");
    ctx.check(pose.pitch == 50 && pose.bearing == 28, "pose pitch / bearing");
  }
  if (ctx.check(!h.adapter->limits.empty(), "init pushes camera limits")) {
    const maprama::MapCameraLimits& l = h.adapter->limits.back();
    ctx.check(l.minPitch == 0 && l.maxPitch == 60, "pitch limited to 0-60");
    ctx.near(l.minZoom, cm::distanceToMapLibreZoom(150 * w.unitMeters, w.origin.lat, 500) - 0.01, 1e-9, "min zoom = DIST_MAX");
    ctx.near(l.maxZoom, cm::distanceToMapLibreZoom(14 * w.unitMeters, w.origin.lat, 500) + 0.01, 1e-9, "max zoom = DIST_MIN");
  }
  ctx.check(h.sink->loggedContaining("world loaded", maprama::LogLevel::Info), "world load logged");
  ctx.check(h.sink->errors() == 0 && h.sink->eventsOfType("error").empty(), "no errors");

  // init.camera is merged over the default framing.
  Harness h2;
  h2.send(initMsg(Value::object({{"kind", "data"}, {"world", worldValue}}),
                  Value::object({{"center", lngLat(127.0561, 37.5447)}, {"pitch", 30}, {"distance", 400}})));
  const maprama::CameraState s2 = h2.engine->cameraState();
  ctx.check(s2.center.lng == 127.0561 && s2.center.lat == 37.5447 && s2.pitch == 30 && s2.distance == 400 &&
                s2.bearing == 28,
            "init.camera merged over the default orbit");
  appendEmitted(ctx, *h.sink);
  appendEmitted(ctx, *h2.sink);
}

MAPRAMA_TEST(m1_set_camera_merge_semantics) {
  Harness h;
  const Value worldValue = seongsuValue(ctx);
  h.send(initMsg(Value::object({{"kind", "data"}, {"world", worldValue}})));
  const maprama::CameraState base = h.engine->cameraState();

  h.send(setCameraMsg(Value::object({{"pitch", 30}})));
  maprama::CameraState s = h.engine->cameraState();
  ctx.check(s.pitch == 30 && s.distance == base.distance && s.bearing == base.bearing &&
                s.center.lng == base.center.lng && s.center.lat == base.center.lat,
            "unset fields keep their value");
  ctx.check(h.adapter->moves.back().first.pitch == 30 && h.adapter->moves.back().second == 0, "jump applied to the map");

  h.send(setCameraMsg(Value::object({{"distance", 500}})));
  ctx.check(h.engine->cameraState().distance == 500, "distance in meters");
  h.send(setCameraMsg(Value::object({{"distance", 5}})));
  ctx.check(h.engine->cameraState().distance == 14 * 8, "distance clamped to DIST_MIN (14 units)");
  h.send(setCameraMsg(Value::object({{"distance", 99999}})));
  ctx.check(h.engine->cameraState().distance == 150 * 8, "distance clamped to DIST_MAX (150 units)");

  h.send(setCameraMsg(Value::object({{"center", lngLat(127.05, 37.545)}, {"zoom", 17}})));
  s = h.engine->cameraState();
  ctx.near(s.distance, cm::webZoomToDistance(17, 37.545, 500), 1e-9, "zoom -> distance (engine-web zoomToMeters)");
  ctx.near(h.adapter->moves.back().first.zoom, 16, 1e-9, "protocol zoom 17 == MapLibre zoom 16");
  h.send(setCameraMsg(Value::object({{"distance", 300}, {"zoom", 10}})));
  ctx.check(h.engine->cameraState().distance == 300, "distance wins over zoom");

  h.send(setCameraMsg(Value::object({{"pitch", 80}})));
  ctx.check(h.engine->cameraState().pitch == 60, "pitch clamped to 60");
  h.send(setCameraMsg(Value::object({{"pitch", 0}})));
  ctx.check(h.engine->cameraState().pitch == 0, "pitch 0 = straight down");
  const std::size_t errorsBefore = h.sink->eventsOfType("error").size();
  h.send(setCameraMsg(Value::object({{"pitch", -5}})));  // protocol range is 0-90: rejected by decodeCommand
  ctx.check(h.sink->eventsOfType("error").size() == errorsBefore + 1 && h.engine->cameraState().pitch == 0,
            "negative pitch rejected as invalid_message");
  h.send(setCameraMsg(Value::object({{"bearing", -90}})));
  ctx.check(h.adapter->moves.back().first.bearing == -90, "bearing passed through (MapLibre normalises)");

  // camera:change reports the normalised bearing.
  h.send(Value::object({{"type", "subscribe"}, {"topic", "camera:change"}, {"throttleMs", 0}}));
  const std::vector<Value> changes = h.sink->eventsOfType("camera:change");
  if (ctx.check(changes.size() == 1, "subscribe emits the current camera once")) {
    ctx.check(changes[0].find("camera")->find("bearing")->asNumber() == 270, "bearing -90 reported as 270");
  }

  // Animated: the map eases, the state follows the adapter's reports.
  const std::size_t moves = h.adapter->moves.size();
  const maprama::CameraState before = h.engine->cameraState();
  h.send(setCameraMsg(Value::object({{"bearing", 45}, {"animate", true}})));
  ctx.check(h.adapter->moves.size() == moves + 1 && h.adapter->moves.back().second == 600, "animate: true = 600 ms");
  ctx.check(h.engine->cameraState().bearing == before.bearing, "state waits for the map's reports");
  h.engine->onCameraChanged(h.adapter->moves.back().first);
  ctx.near(h.engine->cameraState().bearing, 45, 1e-9, "report updates the state");
  ctx.near(h.engine->cameraState().distance, before.distance, 1e-6, "report keeps the distance (zoom round trip)");
  h.send(setCameraMsg(Value::object({{"pitch", 10}, {"animate", Value::object({{"durationMs", 250}})}})));
  ctx.check(h.adapter->moves.back().second == 250, "animate.durationMs");
  h.send(setCameraMsg(Value::object({{"pitch", 12}, {"animate", false}})));
  ctx.check(h.adapter->moves.back().second == 0 && h.engine->cameraState().pitch == 12, "animate: false jumps");

  // follow resolves the character first (M3a, engine-web): an unknown one fails the whole command.
  h.send(setCameraMsg(Value::object({{"follow", "player"}, {"pitch", 20}})));
  const std::vector<Value> errors = h.sink->eventsOfType("error");
  ctx.check(!errors.empty() && errors.back().find("code")->asString() == "unknown_character" &&
                errors.back().find("message")->asString() == "setCamera: cannot follow \"player\": no such character",
            "follow of an unknown character -> unknown_character");
  ctx.check(h.engine->cameraState().pitch == 12, "other fields are not applied when follow fails");
  const std::size_t logs = h.sink->logs.size();
  h.send(setCameraMsg(Value::object({{"follow", nullptr}})));
  ctx.check(h.sink->logs.size() == logs, "follow: null is silent");

  // Gesture reports update the state; identical reports are ignored.
  maprama::MapCameraPose pose = h.adapter->moves.back().first;
  pose.zoom += 1;
  h.engine->onCameraChanged(pose);
  ctx.near(h.engine->cameraState().distance, cm::mapLibreZoomToDistance(pose.zoom, pose.center.lat, 500), 1e-9,
           "gesture zoom -> distance");
  ctx.check(h.sink->errors() == 0, "no dropped events");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m1_camera_change_throttling) {
  Harness h;
  // Subscribing before the world loads emits nothing until init.
  h.send(Value::object({{"type", "subscribe"}, {"topic", "camera:change"}, {"throttleMs", 100}}));
  ctx.check(h.sink->eventsOfType("camera:change").empty(), "no camera:change before a world is loaded");
  h.send(initMsg(Value::object({{"kind", "data"}, {"world", seongsuValue(ctx)}})));
  ctx.check(h.sink->eventsOfType("camera:change").size() == 1, "world load emits the pending subscription");
  // The M3a game session asked for its own (still pending) frame at the world load: count the map session's.
  const std::size_t framesAtLoad = h.adapter->frames.size();

  maprama::MapCameraPose pose = h.adapter->moves.back().first;
  const auto report = [&](double dBearing) {
    pose.bearing += dBearing;
    h.engine->onCameraChanged(pose);
  };
  h.now = 1010;
  report(1);
  ctx.check(h.sink->eventsOfType("camera:change").size() == 1, "change inside the window is held");
  ctx.check(h.adapter->frames.size() == framesAtLoad + 1 && h.adapter->frames.back() == 90, "frame scheduled for the window end");
  h.now = 1050;
  report(1);
  ctx.check(h.adapter->frames.size() == framesAtLoad + 1, "no duplicate frame request");
  h.now = 1100;
  h.engine->frame(h.now);
  std::vector<Value> changes = h.sink->eventsOfType("camera:change");
  if (ctx.check(changes.size() == 2, "held change emitted when the window ends")) {
    ctx.near(changes[1].find("camera")->find("bearing")->asNumber(), 30, 1e-9, "latest camera emitted");
  }
  h.now = 1101;
  h.engine->frame(h.now);
  ctx.check(h.sink->eventsOfType("camera:change").size() == 2, "nothing pending, nothing emitted");
  h.now = 1300;
  report(1);
  ctx.check(h.sink->eventsOfType("camera:change").size() == 3, "change after the window is emitted immediately");
  h.engine->onCameraChanged(pose);
  h.now = 1500;
  h.engine->frame(h.now);
  ctx.check(h.sink->eventsOfType("camera:change").size() == 3, "identical camera report is not a change");

  h.send(Value::object({{"type", "subscribe"}, {"topic", "camera:change"}, {"throttleMs", 0}}));
  const std::size_t n = h.sink->eventsOfType("camera:change").size();
  ctx.check(n == 4, "re-subscribe emits once");
  report(1);
  report(1);
  ctx.check(h.sink->eventsOfType("camera:change").size() == n + 2, "throttleMs 0 emits every change");
  h.send(Value::object({{"type", "unsubscribe"}, {"topic", "camera:change"}}));
  report(1);
  ctx.check(h.sink->eventsOfType("camera:change").size() == n + 2, "no events after unsubscribe");

  // Other topics go to the game session (M3a): handled without a warning.
  h.send(Value::object({{"type", "subscribe"}, {"topic", "travel:progress"}, {"throttleMs", 0}}));
  ctx.check(!h.sink->loggedContaining("is not implemented", maprama::LogLevel::Warn), "travel:progress subscription handled (M3a)");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m1_project_unproject_requests) {
  Harness h;
  h.send(initMsg(Value::object({{"kind", "data"}, {"world", seongsuValue(ctx)}})));
  const auto request = [&](const std::string& id, const char* method, Value params) {
    h.send(Value::object({{"type", "request"}, {"requestId", id}, {"method", method}, {"params", std::move(params)}}));
  };
  const auto lastResponse = [&]() { return h.sink->eventsOfType("response").back(); };

  request("p1", "project", Value::object({{"coordinate", lngLat(127.05, 37.54)}}));
  ctx.check(h.adapter->projects.size() == 1 && h.adapter->projects[0].second.lng == 127.05, "project forwarded");
  ctx.check(h.sink->eventsOfType("response").empty(), "answered asynchronously");
  h.engine->onProjected(h.adapter->projects[0].first, 120.5, 240.25);
  Value r = lastResponse();
  ctx.check(r.find("requestId")->asString() == "p1" && r.find("ok")->asBool() &&
                r.find("result")->find("x")->asNumber() == 120.5 && r.find("result")->find("y")->asNumber() == 240.25 &&
                r.find("result")->find("visible")->asBool(),
            "project response {x, y, visible: true}");
  h.engine->onProjected(h.adapter->projects[0].first, 1, 1);
  ctx.check(h.sink->eventsOfType("response").size() == 1, "a token is answered once");

  request("p2", "project", Value::object({{"coordinate", lngLat(0, 0)}}));
  h.engine->onProjected(h.adapter->projects.back().first, -40, 9000);
  ctx.check(!lastResponse().find("result")->find("visible")->asBool(), "off-screen point is not visible");

  request("u1", "unproject", Value::object({{"x", 10}, {"y", 20}}));
  ctx.check(std::get<1>(h.adapter->unprojects.back()) == 10 && std::get<2>(h.adapter->unprojects.back()) == 20,
            "unproject forwarded");
  h.engine->onUnprojected(std::get<0>(h.adapter->unprojects.back()), maprama::LngLat{127.051, 37.543});
  r = lastResponse();
  ctx.check(r.find("requestId")->asString() == "u1" && r.find("ok")->asBool() &&
                r.find("result")->find("coordinate")->find("lng")->asNumber() == 127.051,
            "unproject response {coordinate}");
  request("u2", "unproject", Value::object({{"x", 10}, {"y", -9000}}));
  h.engine->onUnprojected(std::get<0>(h.adapter->unprojects.back()), std::nullopt);
  ctx.check(lastResponse().find("result")->find("coordinate")->isNull(), "unproject miss -> coordinate null");

  request("s1", "snapToRoad", Value::object({{"coordinate", lngLat(127.05, 37.54)}}));
  ctx.check(lastResponse().find("requestId")->asString() == "s1" && lastResponse().find("ok")->asBool(),
            "snapToRoad answered by the game session (M3a)");

  request("p3", "project", Value::object({{"coordinate", lngLat(127.05, 37.54)}}));
  h.engine->detachMapAdapter();
  r = lastResponse();
  ctx.check(r.find("requestId")->asString() == "p3" && !r.find("ok")->asBool() &&
                r.find("error")->find("code")->asString() == "not_ready",
            "pending request answered with not_ready on detach");
  request("p4", "project", Value::object({{"coordinate", lngLat(127.05, 37.54)}}));
  ctx.check(lastResponse().find("requestId")->asString() == "p4" &&
                lastResponse().find("error")->find("code")->asString() == "not_ready",
            "request without a map view -> not_ready");
  ctx.check(h.sink->errors() == 0, "no dropped events");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m1_url_and_procedural_worlds) {
  Harness h;
  const std::string url = "https://example.test/seongsu.json";
  h.send(initMsg(Value::object({{"kind", "url"}, {"url", url}}), Value::object({{"pitch", 35}})));
  if (ctx.check(h.adapter->fetches.size() == 1 && h.adapter->fetches[0].second == url, "url world fetched by the adapter")) {
    h.engine->onTextFetched(h.adapter->fetches[0].first, true, seongsuText(ctx));
    ctx.check(h.engine->worldStore().loaded() && h.adapter->styles.size() == 2, "fetched world loaded and styled");
    ctx.check(h.engine->cameraState().pitch == 35, "init.camera applied after the url load");
    h.engine->onTextFetched(h.adapter->fetches[0].first, true, "{}");
    ctx.check(h.sink->eventsOfType("error").empty(), "a stale fetch reply is ignored");
  }

  Harness f;
  f.send(initMsg(Value::object({{"kind", "url"}, {"url", url}})));
  f.engine->onTextFetched(f.adapter->fetches.back().first, false, "HTTP 404 while loading " + url);
  std::vector<Value> errors = f.sink->eventsOfType("error");
  ctx.check(errors.size() == 1 && errors[0].find("code")->asString() == "world_load_failed" &&
                errors[0].find("fatal")->asBool() && errors[0].find("message")->asString() == "HTTP 404 while loading " + url,
            "fetch failure -> world_load_failed with the platform message");
  f.send(initMsg(Value::object({{"kind", "url"}, {"url", url}})));
  f.engine->onTextFetched(f.adapter->fetches.back().first, true, "not json");
  errors = f.sink->eventsOfType("error");
  ctx.check(errors.size() == 2 && errors[1].find("message")->asString().rfind("failed to load " + url + ": ", 0) == 0,
            "invalid JSON -> failed to load <url>: ...");
  f.send(initMsg(Value::object({{"kind", "url"}, {"url", url}})));
  f.engine->onTextFetched(f.adapter->fetches.back().first, true, "{\"version\":1}");
  errors = f.sink->eventsOfType("error");
  ctx.check(errors.size() == 3 && errors[2].find("message")->asString().rfind("invalid WorldData from " + url + ": ", 0) == 0,
            "invalid WorldData -> invalid WorldData from <url>: ...");
  f.send(initMsg(Value::object({{"kind", "url"}, {"url", url}})));
  f.engine->detachMapAdapter();
  errors = f.sink->eventsOfType("error");
  ctx.check(errors.size() == 4 && errors[3].find("code")->asString() == "world_load_failed", "detach fails a pending url load");

  Harness p;
  p.send(initMsg(Value::object({{"kind", "procedural"}, {"layout", "town"}, {"seed", 7}})));
  ctx.check(p.sink->eventsOfType("error").empty() && p.engine->worldStore().loaded() &&
                p.engine->worldStore().world()->name == "Procedural town",
            "procedural world loads (M2b, see procedural_tests.cpp)");
  appendEmitted(ctx, *h.sink);
  appendEmitted(ctx, *f.sink);
  appendEmitted(ctx, *p.sink);
}

MAPRAMA_TEST(m1_viewport_and_late_attach) {
  // init before the view is laid out: the camera is sent once the viewport is known.
  Harness h(true, maprama::Viewport{0, 0, 1});
  h.send(initMsg(Value::object({{"kind", "data"}, {"world", seongsuValue(ctx)}})));
  ctx.check(h.adapter->moves.empty() && h.adapter->limits.empty(), "no camera / limits without a viewport");
  h.engine->setViewport({390, 500, 3});
  ctx.check(h.adapter->moves.size() == 1 && h.adapter->limits.size() == 1, "viewport sends limits and camera");
  const double distance = h.engine->cameraState().distance;
  h.engine->setViewport({390, 800, 3});
  ctx.check(h.adapter->moves.size() == 2, "resize re-applies the camera");
  ctx.near(h.adapter->moves.back().first.zoom, cm::distanceToMapLibreZoom(distance, h.engine->cameraState().center.lat, 800),
           1e-9, "resize keeps the distance (zoom re-derived)");
  ctx.check(h.engine->cameraState().distance == distance, "distance unchanged by a resize");
  h.engine->setViewport({500, 800, 3});
  ctx.check(h.adapter->moves.size() == 2, "width-only change does not move the camera");

  // Adapter attached after init: gets the world style, limits and camera immediately.
  Harness late(false);
  late.send(initMsg(Value::object({{"kind", "data"}, {"world", seongsuValue(ctx)}})));
  late.engine->attachMapAdapter(late.adapter);
  ctx.check(late.adapter->styles.size() == 1 && late.adapter->styles[0].find("maprama-buildings") != std::string::npos,
            "late attach sends the world style");
  ctx.check(late.adapter->limits.size() == 1 && late.adapter->moves.size() == 1, "late attach sends limits and camera");

  // Shutdown ignores later platform callbacks.
  late.engine->shutdown();
  const std::size_t events = late.sink->events.size();
  late.engine->onCameraChanged(maprama::MapCameraPose{});
  late.engine->frame(0);
  ctx.check(late.sink->events.size() == events, "callbacks after shutdown are ignored");
  appendEmitted(ctx, *h.sink);
  appendEmitted(ctx, *late.sink);
}

MAPRAMA_TEST(m1_camera_report_before_viewport_keeps_world_camera) {
  // The world loads before the view is laid out, and the map reports its own initial pose (MLNMapView:
  // 0,0, zoom 0, pitch 0) before the viewport arrives (seen on iOS when a MapramaView remounts). That pose
  // must not replace the world camera that waits for the viewport.
  Harness h(true, maprama::Viewport{0, 0, 1});
  h.send(initMsg(dataWorld(ctx), Value::object({{"pitch", 45.0}, {"distance", 400.0}})));
  ctx.check(h.adapter->moves.empty(), "no camera without a viewport");
  const auto target = h.engine->cameraState();
  h.engine->onCameraChanged(maprama::MapCameraPose{});
  h.engine->setViewport({390, 500, 3});
  ctx.check(h.adapter->moves.size() == 1, "the viewport sends the pending camera");
  if (!h.adapter->moves.empty()) {
    const maprama::MapCameraPose& sent = h.adapter->moves.back().first;
    ctx.near(sent.center.lng, target.center.lng, 1e-9, "pending camera keeps the world centre (lng)");
    ctx.near(sent.center.lat, target.center.lat, 1e-9, "pending camera keeps the world centre (lat)");
    ctx.near(sent.pitch, 45.0, 1e-9, "pending camera keeps the pitch");
    ctx.near(sent.zoom, cm::distanceToMapLibreZoom(400.0, target.center.lat, 500), 1e-9, "pending camera keeps the distance");
  }
  ctx.near(h.engine->cameraState().distance, 400.0, 1e-9, "camera state keeps the distance");

  // Once the camera reached the map, its reports are the camera again.
  maprama::MapCameraPose moved = h.adapter->moves.empty() ? maprama::MapCameraPose{} : h.adapter->moves.back().first;
  moved.center.lng += 0.001;
  h.engine->onCameraChanged(moved);
  ctx.near(h.engine->cameraState().center.lng, moved.center.lng, 1e-12, "reports after the camera was sent update the state");
  appendEmitted(ctx, *h.sink);
}
