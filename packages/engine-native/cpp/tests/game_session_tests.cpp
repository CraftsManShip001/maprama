// M3a game session: characters, location sources, travel + routing, drops, geofences, the follow camera and
// the style-layer visuals, driven through the Engine with the fake MapAdapter and an injected clock (commands
// → events, every error code). Every emitted envelope is appended to --emit so that
// scripts/verify-emitted-events.mjs validates it with the TypeScript decodeEvent.
#include <algorithm>
#include <cmath>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "maprama/CameraMath.hpp"
#include "maprama/Engine.hpp"
#include "maprama/GameVisuals.hpp"
#include "maprama/LocationFilter.hpp"
#include "maprama/MapLook.hpp"
#include "maprama/Projection.hpp"
#include "maprama/RoadGraph.hpp"
#include "maprama/TravelLogic.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/protocol.hpp"
#include "harness.hpp"
#include "map_harness.hpp"

namespace {

using maprama::LngLat;
using maprama::WorldPoint;
using maprama::json::Value;
namespace gs = maprama::game_style;
using namespace maprama::test::maptest;

/// The Seongsu sample as the game session sees it: the player's spawn (plaza snapped to a road) and a road
/// node 10–16 world units away (the shortest walking route among those).
struct Scene {
  const maprama::WorldData* world = nullptr;
  const maprama::Projection* proj = nullptr;
  maprama::PlanWorld plan;
  WorldPoint spawn;
  WorldPoint dest;
  double routeUnits = 0.0;

  LngLat ll(const WorldPoint& p) const { return proj->toLngLat(p); }
  Value v(const WorldPoint& p) const {
    const LngLat l = ll(p);
    return lngLat(l.lng, l.lat);
  }
  double unit() const { return world->unitMeters; }
};

void initWorld(Harness& h, const maprama::test::Context& ctx, const char* locationSource = "external") {
  Value msg = initMsg(dataWorld(ctx));
  msg.set("locationSource", locationSource);
  h.send(msg);
}

Scene sceneOf(const Harness& h) {
  Scene s;
  s.world = h.engine->worldStore().world();
  s.proj = h.engine->worldStore().projection();
  s.plan = maprama::planWorldFromData(*s.world);
  const WorldPoint base = s.world->plaza ? *s.world->plaza : WorldPoint{0, 0};
  const std::optional<maprama::GraphSnap> snap = maprama::snapToGraph(s.plan.graph, base.x, base.z);
  s.spawn = snap ? WorldPoint{snap->x, snap->z} : base;
  double best = 1e18;
  for (const maprama::GraphNode& n : s.plan.graph.nodes) {
    const double d = std::hypot(n.x - s.spawn.x, n.z - s.spawn.z);
    if (d < 10 || d > 16) continue;
    const auto legs = maprama::planLegs(s.plan, s.spawn, WorldPoint{n.x, n.z}, {maprama::TravelMode::Walk});
    if (legs.size() != 1) continue;
    const double length = maprama::polylineLength(legs[0].pts);
    if (length < best) {
      best = length;
      s.dest = WorldPoint{n.x, n.z};
      s.routeUnits = length;
    }
  }
  return s;
}

Value modes(std::initializer_list<const char*> list) {
  Value out = Value::array();
  for (const char* m : list) out.push(m);
  return out;
}

Value upsert(Value characters) { return Value::object({{"type", "upsertCharacters"}, {"characters", std::move(characters)}}); }

Value travelMsg(const std::string& requestId, const std::string& characterId, Value to, double timeScale = 20,
                Value modeList = Value()) {
  Value msg = Value::object({{"type", "travel"},
                             {"requestId", requestId},
                             {"characterId", characterId},
                             {"to", std::move(to)},
                             {"modes", modeList.isNull() ? modes({"walk"}) : std::move(modeList)}});
  if (timeScale != 1) msg.set("timeScale", timeScale);
  return msg;
}

Value subscribeMsg(const char* topic, double throttleMs, std::optional<std::string> id = std::nullopt) {
  Value msg = Value::object({{"type", "subscribe"}, {"topic", topic}, {"throttleMs", throttleMs}});
  if (id) msg.set("id", *id);
  return msg;
}

Value requestMsg(const std::string& id, const char* method, Value params) {
  return Value::object({{"type", "request"}, {"requestId", id}, {"method", method}, {"params", std::move(params)}});
}

Value dropLayerMsg(const std::string& layerId, Value drops, double radius, std::optional<Value> collectors = std::nullopt) {
  Value msg = Value::object({{"type", "setDropLayer"}, {"layerId", layerId}, {"drops", std::move(drops)}, {"collectRadiusMeters", radius}});
  if (collectors) msg.set("collectorIds", std::move(*collectors));
  return msg;
}

Value fix(const LngLat& at, double timestampMs) {
  return Value::object({{"type", "pushLocation"},
                        {"fix", Value::object({{"lng", at.lng}, {"lat", at.lat}, {"accuracyMeters", 3}, {"timestamp", timestampMs}})}});
}

bool runUntil(Harness& h, const std::function<bool()>& done, double maxMs) {
  for (double t = 0; t < maxMs; t += 16) {
    if (done()) return true;
    h.run(16);
  }
  return done();
}

std::size_t count(const Harness& h, const std::string& type) { return h.sink->eventsOfType(type).size(); }

Value last(const Harness& h, const std::string& type) {
  const std::vector<Value> events = h.sink->eventsOfType(type);
  return events.empty() ? Value() : events.back();
}

bool isError(const Value& e, const std::string& code, const std::string& message) {
  return e.isObject() && e.find("code")->asString() == code && e.find("message")->asString() == message &&
         !e.find("fatal")->asBool();
}

const std::vector<Value>& features(const Value& collection) {
  static const std::vector<Value> kNone;
  const Value* f = collection.isObject() ? collection.find("features") : nullptr;
  return f != nullptr ? f->items() : kNone;
}

/// Features whose `properties[key] == value`.
std::vector<Value> featuresWith(const Value& collection, const char* key, const std::string& value) {
  std::vector<Value> out;
  for (const Value& f : features(collection)) {
    const Value* p = f.find("properties")->find(key);
    if (p != nullptr && p->isString() && p->asString() == value) out.push_back(f);
  }
  return out;
}

LngLat pointOf(const Value& feature) {
  const Value& c = *feature.find("geometry")->find("coordinates");
  return LngLat{c.items()[0].asNumber(), c.items()[1].asNumber()};
}

std::string prop(const Value& feature, const char* key) {
  const Value* p = feature.find("properties")->find(key);
  return p != nullptr && p->isString() ? p->asString() : std::string();
}

double meters(const LngLat& a, const LngLat& b) { return maprama::haversineMeters(a, b); }

int layerIndex(const Value& style, const std::string& id) {
  const auto& layers = style.find("layers")->items();
  for (std::size_t i = 0; i < layers.size(); ++i) {
    if (layers[i].find("id")->asString() == id) return static_cast<int>(i);
  }
  return -1;
}

double ringArea(const Value& ring) {
  double a = 0;
  const auto& pts = ring.items();
  for (std::size_t i = 0, j = pts.size() - 1; i < pts.size(); j = i++) {
    a += pts[j].items()[0].asNumber() * pts[i].items()[1].asNumber() - pts[i].items()[0].asNumber() * pts[j].items()[1].asNumber();
  }
  return a / 2;
}

}  // namespace

MAPRAMA_TEST(m3a_visuals_builders) {
  const maprama::Projection proj = *maprama::Projection::create({LngLat{127.05, 37.54}, 8.0}).value;
  const std::vector<maprama::Vec2> ring = maprama::circleRing(1, 2, 3, 80);
  ctx.check(ring.size() == 80, "circle ring has the requested segments");
  ctx.near(std::hypot(ring[17][0] - 1, ring[17][1] - 2), 3, 1e-12, "circle ring radius");

  const Value fences = maprama::json::parse(maprama::fencesGeoJson({maprama::WorldFence{"z", 0, 0, 5}}, proj)).value;
  const std::vector<Value> fill = featuresWith(fences, "part", "fill");
  const std::vector<Value> band = featuresWith(fences, "part", "ring");
  ctx.check(fill.size() == 1 && band.size() == 1, "a fence is a fill disc and a ring");
  if (band.size() == 1) {
    const auto& rings = band[0].find("geometry")->find("coordinates")->items();
    ctx.check(rings.size() == 2 && rings[0].items().size() == 81 && rings[1].items().size() == 81, "ring: outer + hole, 80 segments, closed");
    if (rings.size() == 2) ctx.check(ringArea(rings[0]) * ringArea(rings[1]) < 0, "the hole winds opposite to the outer ring");
    // engine-web: ring width min(0.35, 0.2 r) → inner radius 4.65 units.
    const auto& hole = rings[1].items()[0].items();
    const WorldPoint h = proj.toWorld(LngLat{hole[0].asNumber(), hole[1].asNumber()});
    ctx.near(std::hypot(h.x, h.z), 4.65, 1e-6, "ring inner radius r - min(0.35, 0.2 r)");
  }

  const Value size = maprama::groundSizeExpression(4.0, 6.0, 37.54);
  ctx.check(size.items().size() == 3 + 2 * 11 && size.items()[0].asString() == "interpolate", "size: interpolate over zoom 12..22");
  ctx.check(size.items()[4].asNumber() == 6.0, "small sizes are clamped to the minimum (zoom 12)");
  ctx.near(size.items().back().asNumber(), 4.0 / maprama::camera_math::mapLibreMetersPerPixel(22, 37.54), 1e-9,
           "large zooms keep the ground size");

  maprama::json::Value layers = maprama::json::parse(
                                    R"([{"id":"background"},{"id":"roads"},{"id":"buildings-captured"},{"id":"buildings"}])")
                                    .value;
  maprama::insertGameLayers(layers, 37.54, 8);
  std::vector<std::string> ids;
  for (const Value& l : layers.items()) ids.push_back(l.find("id")->asString());
  const auto at = [&](const char* id) { return std::find(ids.begin(), ids.end(), id) - ids.begin(); };
  ctx.check(at(gs::kLayerFenceFill) < at("buildings-captured") && at(gs::kLayerRoute) < at("buildings-captured") &&
                at(gs::kLayerPuckAccuracy) < at("buildings"),
            "ground game layers below the buildings");
  ctx.check(at(gs::kLayerDrops) > at("buildings") && at(gs::kLayerCharacters) > at(gs::kLayerPuck) &&
                at(gs::kLayerCharacterHeading) > at(gs::kLayerCharacters) && ids.size() == 4 + 10,
            "markers above the buildings, heading dots last");

  const Value empty = maprama::json::parse(maprama::puckGeoJson(std::nullopt)).value;
  ctx.check(features(empty).empty(), "no puck -> empty collection");
}

MAPRAMA_TEST(m3a_commands_before_a_world) {
  Harness h;
  const Value origin = *seongsuValue(ctx).find("origin");
  const LngLat o{origin.find("lng")->asNumber(), origin.find("lat")->asNumber()};

  h.send(requestMsg("r1", "route", Value::object({{"from", lngLat(o.lng, o.lat)}, {"to", lngLat(o.lng, o.lat)}, {"modes", modes({"walk"})}})));
  h.send(requestMsg("s1", "snapToRoad", Value::object({{"coordinate", lngLat(o.lng, o.lat)}})));
  const std::vector<Value> responses = h.sink->eventsOfType("response");
  ctx.check(responses.size() == 2, "both requests answered");
  for (const Value& r : responses) {
    ctx.check(!r.find("ok")->asBool() && r.find("error")->find("code")->asString() == "not_ready" &&
                  r.find("error")->find("message")->asString() == "no world loaded (send init first)",
              "route / snapToRoad without a world -> not_ready (" + r.find("requestId")->asString() + ")");
  }

  h.send(travelMsg("t0", "me", lngLat(o.lng, o.lat)));
  ctx.check(isError(last(h, "error"), "not_ready", "travel: no world loaded (send init first)"), "travel without a world -> not_ready");
  h.send(Value::object({{"type", "cancelTravel"}, {"characterId", "me"}}));
  ctx.check(isError(last(h, "error"), "unknown_character", "cancelTravel: unknown character \"me\""), "cancelTravel unknown -> unknown_character");
  h.send(setCameraMsg(Value::object({{"follow", "me"}})));
  ctx.check(isError(last(h, "error"), "unknown_character", "setCamera: cannot follow \"me\": no such character"),
            "follow an unknown character -> unknown_character");

  // Deferred until the world loads (engine-web keeps `{...pending, ...spec}` including `null`).
  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"isPlayer", true}, {"color", "#E0457B"}})})));
  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"color", nullptr}})})));
  h.send(dropLayerMsg("coins", Value::array({Value::object({{"id", "c1"}, {"type", "coin"}, {"coordinate", lngLat(o.lng + 0.001, o.lat)}})}), 1));
  h.send(Value::object({{"type", "setGeofences"},
                        {"geofences", Value::array({Value::object({{"id", "zone"}, {"center", lngLat(o.lng, o.lat + 0.001)}, {"radiusMeters", 20}})})}}));
  h.send(Value::object({{"type", "upsertCharacters"}, {"characters", Value::array({Value::object({{"id", "gone"}})})}}));
  h.send(Value::object({{"type", "removeCharacters"}, {"ids", Value::array({"gone"})}}));
  ctx.check(h.adapter->sourceUpdates(gs::kSourceCharacters) == 0 && h.adapter->sourceUpdates(gs::kSourceDrops) == 0,
            "no game source data before a world");
  const std::size_t errors = count(h, "error");

  initWorld(h, ctx);
  h.run(32);
  ctx.check(count(h, "error") == errors, "deferred state applies without errors");
  const Value chars = h.adapter->lastSource(gs::kSourceCharacters);
  const std::vector<Value> bodies = featuresWith(chars, "kind", "body");
  ctx.check(bodies.size() == 1 && prop(bodies[0], "id") == "me", "pending character created at load (removed one dropped)");
  if (!bodies.empty()) {
    ctx.check(prop(bodies[0], "color") == maprama::cssHex(gs::kPlayerColor) && bodies[0].find("properties")->find("player")->asBool(),
              "pending null cleared the colour: default player colour");
  }
  ctx.check(features(h.adapter->lastSource(gs::kSourceDrops)).size() == 1, "pending drop layer applied at load");
  ctx.check(features(h.adapter->lastSource(gs::kSourceFences)).size() == 2, "pending geofence applied at load");
  ctx.check(h.sink->errors() == 0, "no invalid outgoing events");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m3a_route_and_snap_to_road_requests) {
  Harness h;
  initWorld(h, ctx);
  const Scene s = sceneOf(h);
  const LngLat from = s.ll(s.spawn), to = s.ll(s.dest);
  h.send(requestMsg("r1", "route", Value::object({{"from", s.v(s.spawn)}, {"to", s.v(s.dest)}, {"modes", modes({"walk", "car", "walk"})}})));
  const maprama::RouteResult expected =
      maprama::routeResult(s.plan, *s.proj, from, to, {maprama::TravelMode::Walk, maprama::TravelMode::Car, maprama::TravelMode::Walk});
  Value r = last(h, "response");
  ctx.check(r.find("requestId")->asString() == "r1" && r.find("ok")->asBool(), "route answered");
  const Value* result = r.find("result");
  if (result != nullptr && result->isObject()) {
    const auto& legs = result->find("legs")->items();
    ctx.check(legs.size() == expected.legs.size() && !legs.empty(), "route legs = TravelLogic::routeResult");
    for (std::size_t i = 0; i < std::min(legs.size(), expected.legs.size()); ++i) {
      ctx.check(legs[i].find("mode")->asString() == maprama::enumName(expected.legs[i].mode) &&
                    legs[i].find("path")->items().size() == expected.legs[i].path.size(),
                "route leg mode and path");
      ctx.near(legs[i].find("meters")->asNumber(), expected.legs[i].meters, 1e-9, "route leg meters");
    }
    ctx.near(result->find("meters")->asNumber(), expected.meters, 1e-9, "route meters");
    ctx.near(result->find("etaSeconds")->asNumber(), expected.etaSeconds, 1e-9, "route real-world ETA");
  }

  const WorldPoint off{s.spawn.x + 0.6, s.spawn.z - 0.4};
  h.send(requestMsg("s1", "snapToRoad", Value::object({{"coordinate", s.v(off)}})));
  const std::optional<maprama::SnapToRoadResult> snap = maprama::snapToRoad(s.plan, *s.proj, s.ll(off), std::nullopt);
  r = last(h, "response");
  ctx.check(snap && r.find("ok")->asBool() && r.find("result")->find("roadId")->asString() == snap->roadId, "snapToRoad road id");
  if (snap) {
    ctx.near(r.find("result")->find("distanceMeters")->asNumber(), snap->distanceMeters, 1e-9, "snapToRoad distance");
    h.send(requestMsg("s2", "snapToRoad", Value::object({{"coordinate", s.v(off)}, {"maxDistanceMeters", snap->distanceMeters / 2}})));
    r = last(h, "response");
    ctx.check(r.find("requestId")->asString() == "s2" && r.find("ok")->asBool() && r.find("result")->isNull(),
              "snapToRoad farther than maxDistanceMeters -> null");
  }
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m3a_characters_merge_player_rule_and_positions) {
  Harness h;
  initWorld(h, ctx);
  const Scene s = sceneOf(h);
  h.send(subscribeMsg("character:position", 0));
  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"isPlayer", true}, {"color", "#E0457B"}, {"position", s.v(s.spawn)}}),
                              Value::object({{"id", "npc"}})})));
  h.run(48);
  const std::vector<Value> positions = h.sink->eventsOfType("character:position");
  ctx.check(positions.size() == 2, "one character:position per character after subscribe");
  for (const Value& p : positions) {
    if (p.find("id")->asString() != "me") continue;
    const LngLat c{p.find("coordinate")->find("lng")->asNumber(), p.find("coordinate")->find("lat")->asNumber()};
    ctx.check(meters(c, s.ll(s.spawn)) < 1e-6, "position at the upserted coordinate");
    ctx.near(p.find("headingDeg")->asNumber(), 90, 1e-9, "initial heading (engine-web yaw π/2 = east)");
    ctx.check(p.find("speedMps")->asNumber() == 0, "standing still");
  }
  // NPC spawn: engine-web scatters non-player characters 30 units around the plaza by id hash, snapped to a road.
  {
    const std::uint32_t hsh = maprama::hashId("npc");
    const WorldPoint base = *s.world->plaza;
    const WorldPoint p{base.x + ((hsh % 1000) / 1000.0 - 0.5) * 30, base.z + (((hsh >> 10) % 1000) / 1000.0 - 0.5) * 30};
    const auto snap = maprama::snapToGraph(s.plan.graph, p.x, p.z);
    const std::vector<Value> npc = featuresWith(h.adapter->lastSource(gs::kSourceCharacters), "id", "npc");
    ctx.check(snap && !npc.empty() && meters(pointOf(npc[0]), s.ll(WorldPoint{snap->x, snap->z})) < 1e-6, "NPC spawn point");
    ctx.check(!npc.empty() && prop(npc[0], "color") == maprama::cssHex(gs::kNpcColors[hsh % 6]), "NPC colour by id hash");
  }
  const std::vector<Value> me = featuresWith(h.adapter->lastSource(gs::kSourceCharacters), "id", "me");
  ctx.check(!me.empty() && prop(me[0], "color") == "#E0457B" && prop(me[0], "ring") == "#FFFFFF", "player colour + ring");

  h.send(upsert(Value::array({Value::object({{"id", "npc"}, {"isPlayer", true}})})));
  ctx.check(isError(last(h, "error"), "invalid_character", "upsertCharacters: at most one character can be the player (got me, npc)"),
            "two players -> invalid_character");
  const std::size_t errors = count(h, "error");
  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"isPlayer", false}, {"color", nullptr}}),
                              Value::object({{"id", "npc"}, {"isPlayer", true}})})));
  ctx.check(count(h, "error") == errors, "handing the player over in one upsert is valid");
  h.run(32);
  const Value chars = h.adapter->lastSource(gs::kSourceCharacters);
  const std::vector<Value> me2 = featuresWith(chars, "id", "me");
  ctx.check(!me2.empty() && prop(me2[0], "color") == maprama::cssHex(gs::kNpcColors[maprama::hashId("me") % 6]) &&
                !me2[0].find("properties")->find("player")->asBool(),
            "color: null restores the default (now an NPC colour)");

  const std::size_t before = count(h, "character:position");
  h.run(500);
  ctx.check(count(h, "character:position") == before, "no character:position while nothing moves");
  h.send(Value::object({{"type", "removeCharacters"}, {"ids", Value::array({"npc"})}}));
  h.run(32);
  ctx.check(featuresWith(h.adapter->lastSource(gs::kSourceCharacters), "kind", "body").size() == 1, "removeCharacters removes the marker");
  ctx.check(h.sink->errors() == 0, "no invalid outgoing events");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m3a_travel_events_progress_and_time_scale) {
  Harness h;
  initWorld(h, ctx);
  const Scene s = sceneOf(h);
  ctx.check(s.routeUnits > 8, "scene has a walking destination");
  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"isPlayer", true}, {"position", s.v(s.spawn)}})})));
  h.send(subscribeMsg("travel:progress", 250, std::string("me")));
  h.run(32);
  const double startMs = h.now;
  h.send(travelMsg("t1", "me", s.v(s.dest), 20));
  const Value start = last(h, "travel:start");
  ctx.check(start.isObject() && start.find("requestId")->asString() == "t1" && start.find("legs")->items().size() == 1 &&
                start.find("legs")->items()[0].find("mode")->asString() == "walk",
            "travel:start with the planned legs");
  if (start.isObject() && !start.find("legs")->items().empty()) {
    ctx.near(start.find("legs")->items()[0].find("meters")->asNumber(), s.routeUnits * s.unit(), 1e-6, "leg meters");
  }
  h.run(16);
  const Value route = h.adapter->lastSource(gs::kSourceRoute);
  ctx.check(featuresWith(route, "part", "line").size() == 1 && featuresWith(route, "part", "pin").size() == 1,
            "player trip: route line + destination pin");
  const bool arrived = runUntil(h, [&] { return count(h, "travel:arrive") == 1; }, 20000);
  ctx.check(arrived, "travel:arrive");
  const double expectedMs = s.routeUnits * s.unit() / (4.8 / 3.6 * 20) * 1000;
  ctx.near(h.now - startMs, expectedMs, 80, "walk at 4.8 km/h x timeScale 20");
  const std::vector<Value> progress = h.sink->eventsOfType("travel:progress");
  ctx.check(progress.size() + 2 >= static_cast<std::size_t>(expectedMs / 256) && progress.size() <= expectedMs / 250 + 2,
            "travel:progress throttled to 250 ms (" + std::to_string(progress.size()) + ")");
  bool decreasing = !progress.empty();
  for (std::size_t i = 1; i < progress.size(); ++i) {
    decreasing = decreasing && progress[i].find("etaSeconds")->asNumber() < progress[i - 1].find("etaSeconds")->asNumber() &&
                 progress[i].find("remainingMeters")->asNumber() < progress[i - 1].find("remainingMeters")->asNumber() &&
                 progress[i].find("mode")->asString() == "walk";
  }
  ctx.check(decreasing, "progress: ETA and remaining meters decrease");
  if (!progress.empty()) {
    ctx.near(progress[0].find("etaSeconds")->asNumber(), expectedMs / 1000, 0.1, "first ETA = wall-clock seconds at the timeScale");
  }
  h.run(16);
  ctx.check(features(h.adapter->lastSource(gs::kSourceRoute)).empty(), "route overlay removed on arrival");
  const std::vector<Value> me = featuresWith(h.adapter->lastSource(gs::kSourceCharacters), "id", "me");
  ctx.check(!me.empty() && meters(pointOf(me[0]), s.ll(s.dest)) < 1e-3, "character at the destination");

  // A new travel supersedes the running one; cancelTravel cancels once.
  h.send(travelMsg("t2", "me", s.v(s.spawn)));
  h.run(100);
  h.send(travelMsg("t3", "me", s.v(s.dest)));
  Value cancel = last(h, "travel:cancel");
  ctx.check(cancel.isObject() && cancel.find("requestId")->asString() == "t2" && count(h, "travel:cancel") == 1,
            "superseded travel -> travel:cancel before the new travel:start");
  ctx.check(last(h, "travel:start").find("requestId")->asString() == "t3", "then travel:start");
  h.send(Value::object({{"type", "cancelTravel"}, {"characterId", "me"}}));
  ctx.check(count(h, "travel:cancel") == 2 && last(h, "travel:cancel").find("requestId")->asString() == "t3", "cancelTravel");
  const std::size_t errors = count(h, "error");
  h.send(Value::object({{"type", "cancelTravel"}, {"characterId", "me"}}));
  ctx.check(count(h, "travel:cancel") == 2 && count(h, "error") == errors, "cancelTravel without a trip: nothing");
  h.send(travelMsg("t4", "ghost", s.v(s.dest)));
  ctx.check(isError(last(h, "error"), "unknown_character", "travel: unknown character \"ghost\""), "travel unknown -> unknown_character");

  // A trip to the current position has no legs and arrives at once.
  h.run(32);
  const std::vector<Value> here = featuresWith(h.adapter->lastSource(gs::kSourceCharacters), "id", "me");
  if (!here.empty()) {
    const LngLat at = pointOf(here[0]);
    h.send(travelMsg("t5", "me", lngLat(at.lng, at.lat)));
    ctx.check(last(h, "travel:start").find("legs")->items().empty() && last(h, "travel:arrive").find("requestId")->asString() == "t5",
              "a trip without legs arrives at once");
  }
  // removeCharacters cancels a running trip.
  h.send(travelMsg("t6", "me", s.v(s.spawn)));
  h.send(Value::object({{"type", "removeCharacters"}, {"ids", Value::array({"me"})}}));
  ctx.check(last(h, "travel:cancel").find("requestId")->asString() == "t6", "removeCharacters -> travel:cancel");
  ctx.check(h.sink->errors() == 0, "no invalid outgoing events");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m3a_drops_collect_pop_and_layers) {
  Harness h;
  initWorld(h, ctx);
  const Scene s = sceneOf(h);
  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"isPlayer", true}, {"follow", "location"}, {"position", s.v(s.spawn)}})})));
  const Value coin = Value::object({{"id", "c1"}, {"type", "coin"}, {"rarity", "rare"}, {"value", 50}, {"coordinate", s.v(s.dest)},
                                    {"payload", Value::object({{"label", "gem"}})}});
  h.send(dropLayerMsg("coins", Value::array({coin}), 15));
  h.send(dropLayerMsg("nobody", Value::array({Value::object({{"id", "n1"}, {"type", "note"}, {"coordinate", s.v(s.dest)}})}), 50,
                      Value::array()));
  h.run(32);
  Value drops = h.adapter->lastSource(gs::kSourceDrops);
  ctx.check(features(drops).size() == 2, "two drop markers");
  const std::vector<Value> c1 = featuresWith(drops, "id", "c1");
  ctx.check(!c1.empty() && prop(c1[0], "color") == maprama::cssHex(gs::kRarityColors[1]), "rare drop colour");

  // An external fix on the drop: the player walks there (location drive) and collects it.
  h.send(fix(s.ll(s.dest), 1000));
  ctx.check(runUntil(h, [&] { return count(h, "drop:collect") >= 1; }, 10000), "drop:collect");
  const Value collect = last(h, "drop:collect");
  ctx.check(collect.isObject() && collect.find("layerId")->asString() == "coins" && collect.find("dropId")->asString() == "c1" &&
                collect.find("characterId")->asString() == "me" &&
                collect.find("collectId")->asString() == "00000000-0000-4000-8000-000000000001",
            "drop:collect fields");
  h.run(48);
  const std::vector<Value> popping = featuresWith(h.adapter->lastSource(gs::kSourceDrops), "id", "c1");
  ctx.check(popping.size() == 1 && popping[0].find("properties")->find("pop")->asNumber() > 0, "collected drop pops");
  h.run(400);
  drops = h.adapter->lastSource(gs::kSourceDrops);
  ctx.check(featuresWith(drops, "id", "c1").empty() && featuresWith(drops, "id", "n1").size() == 1,
            "popped drop removed; the collector-less layer stays");
  ctx.check(count(h, "drop:collect") == 1, "a drop is collected once");

  // The same spec again: the collector cannot collect it twice while its id stays in every spec.
  h.send(dropLayerMsg("coins", Value::array({coin}), 15));
  h.run(200);
  ctx.check(count(h, "drop:collect") == 1 && featuresWith(h.adapter->lastSource(gs::kSourceDrops), "id", "c1").size() == 1,
            "re-sent drop shown but not collected again");
  // Removed and restored (the RN DropLayer retry path): its history is forgotten.
  h.send(dropLayerMsg("coins", Value::array(), 15));
  h.send(dropLayerMsg("coins", Value::array({coin}), 15));
  h.run(48);
  ctx.check(count(h, "drop:collect") == 2 && last(h, "drop:collect").find("collectId")->asString() == "00000000-0000-4000-8000-000000000002",
            "restored drop collected again with a fresh collectId");
  // A collectId generator that repeats itself: engine-web's duplicate failure -> internal error, nothing reported.
  h.repeatCollectIds = true;
  h.send(dropLayerMsg("coins", Value::array(), 15));
  h.send(dropLayerMsg("coins", Value::array({coin}), 15));
  h.run(48);
  ctx.check(count(h, "drop:collect") == 2 &&
                isError(last(h, "error"), "internal", "drop:collect: collectId generator keeps returning duplicates"),
            "duplicate collectIds -> internal error");
  h.send(Value::object({{"type", "removeDropLayer"}, {"layerId", "nobody"}}));
  h.run(32);
  ctx.check(featuresWith(h.adapter->lastSource(gs::kSourceDrops), "id", "n1").empty(), "removeDropLayer removes its markers");
  ctx.check(h.sink->errors() == 0, "no invalid outgoing events");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m3a_geofences_enter_exit_and_visuals) {
  Harness h;
  initWorld(h, ctx);
  const Scene s = sceneOf(h);
  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"isPlayer", true}, {"position", s.v(s.spawn)}})})));
  const Value zone = Value::object({{"type", "setGeofences"},
                                    {"geofences", Value::array({Value::object({{"id", "zone"}, {"center", s.v(s.dest)}, {"radiusMeters", 24}})})}});
  h.send(zone);
  h.run(32);
  const Value fences = h.adapter->lastSource(gs::kSourceFences);
  ctx.check(featuresWith(fences, "part", "fill").size() == 1 && featuresWith(fences, "part", "ring").size() == 1, "fence fill + ring");
  ctx.check(count(h, "geofence:enter") == 0, "outside at the start");
  h.send(travelMsg("t1", "me", s.v(s.dest)));
  runUntil(h, [&] { return count(h, "travel:arrive") == 1; }, 20000);
  Value enter = last(h, "geofence:enter");
  ctx.check(count(h, "geofence:enter") == 1 && enter.isObject() && enter.find("geofenceId")->asString() == "zone" &&
                enter.find("characterId")->asString() == "me",
            "geofence:enter");
  h.send(travelMsg("t2", "me", s.v(s.spawn)));
  runUntil(h, [&] { return count(h, "travel:arrive") == 2; }, 20000);
  ctx.check(count(h, "geofence:exit") == 1 && last(h, "geofence:exit").find("geofenceId")->asString() == "zone", "geofence:exit");
  h.send(travelMsg("t3", "me", s.v(s.dest)));
  runUntil(h, [&] { return count(h, "travel:arrive") == 3; }, 20000);
  h.send(zone);
  h.run(100);
  ctx.check(count(h, "geofence:enter") == 2, "membership kept when the same fence is set again (no duplicate enter)");
  h.send(Value::object({{"type", "setGeofences"}, {"geofences", Value::array()}}));
  h.run(100);
  ctx.check(count(h, "geofence:exit") == 1 && features(h.adapter->lastSource(gs::kSourceFences)).empty(),
            "removed fences are forgotten silently");
  ctx.check(h.sink->errors() == 0, "no invalid outgoing events");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m3a_follow_camera) {
  Harness h;
  initWorld(h, ctx);
  const Scene s = sceneOf(h);
  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"isPlayer", true}, {"position", s.v(s.spawn)}})})));
  const double pitch = h.engine->cameraState().pitch;
  h.send(setCameraMsg(Value::object({{"follow", "ghost"}, {"pitch", 10}})));
  ctx.check(isError(last(h, "error"), "unknown_character", "setCamera: cannot follow \"ghost\": no such character") &&
                h.engine->cameraState().pitch == pitch,
            "unknown follow target fails the whole setCamera");

  h.send(setCameraMsg(Value::object({{"follow", "me"}})));
  h.send(travelMsg("t1", "me", s.v(s.dest)));
  runUntil(h, [&] { return count(h, "travel:arrive") == 1; }, 20000);
  h.run(3000);
  ctx.check(meters(h.engine->cameraState().center, s.ll(s.dest)) < 0.05, "the camera follows the character");
  const std::size_t jumps = static_cast<std::size_t>(
      std::count_if(h.adapter->moves.begin(), h.adapter->moves.end(), [](const auto& m) { return m.second == 0; }));
  ctx.check(jumps > 20, "follow moves the map camera every frame while it catches up");

  // A center without follow stops following.
  const WorldPoint elsewhere{s.dest.x + 6, s.dest.z + 6};
  h.send(setCameraMsg(Value::object({{"center", s.v(elsewhere)}})));
  h.send(travelMsg("t2", "me", s.v(s.spawn)));
  runUntil(h, [&] { return count(h, "travel:arrive") == 2; }, 20000);
  ctx.check(meters(h.engine->cameraState().center, s.ll(elsewhere)) < 1e-6, "center without follow stops following");

  // A user pan stops following.
  h.send(setCameraMsg(Value::object({{"follow", "me"}})));
  h.run(300);
  h.engine->onUserPan();
  const LngLat panned = h.engine->cameraState().center;
  h.send(travelMsg("t3", "me", s.v(s.dest)));
  runUntil(h, [&] { return count(h, "travel:arrive") == 3; }, 20000);
  ctx.check(meters(h.engine->cameraState().center, panned) < 1e-6, "user pan stops following");

  // Removing the followed character stops following.
  h.send(setCameraMsg(Value::object({{"follow", "me"}})));
  h.send(Value::object({{"type", "removeCharacters"}, {"ids", Value::array({"me"})}}));
  h.run(200);
  ctx.check(h.sink->errors() == 0, "no invalid outgoing events");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m3a_location_sources_device_and_puck) {
  Harness h;
  initWorld(h, ctx, "simulated");
  const Scene s = sceneOf(h);
  h.send(Value::object({{"type", "setUi"}, {"ui", Value::object({{"locationPuck", true}})}}));
  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"isPlayer", true}, {"follow", "location"}})})));
  h.send(subscribeMsg("character:position", 100, std::string("me")));
  h.run(6000);
  const std::vector<Value> positions = h.sink->eventsOfType("character:position");
  ctx.check(positions.size() > 20 && positions.size() <= 62, "simulated source moves the character (throttled 100 ms)");
  if (positions.size() > 2) {
    const auto at = [](const Value& p) {
      return LngLat{p.find("coordinate")->find("lng")->asNumber(), p.find("coordinate")->find("lat")->asNumber()};
    };
    ctx.check(meters(at(positions.front()), at(positions.back())) > 5, "the character walked the demo loop");
  }
  const Value puck = h.adapter->lastSource(gs::kSourcePuck);
  ctx.check(featuresWith(puck, "part", "dot").size() == 1 && featuresWith(puck, "part", "accuracy").size() == 1,
            "location puck with the accuracy disc under the player");
  ctx.check(h.adapter->frames.size() > 100, "frames scheduled while the walker runs");

  // pushLocation is ignored unless the source is external (engine-web).
  const std::size_t moved = h.sink->eventsOfType("character:position").size();
  h.send(Value::object({{"type", "setLocationSource"}, {"source", "device"}}));
  ctx.check(h.adapter->locationStarts == 1, "device source starts the platform location feed");
  h.engine->onDeviceLocationError("location permission not granted");
  ctx.check(isError(last(h, "error"), "location_unavailable", "device geolocation failed: location permission not granted"),
            "device failure -> location_unavailable");
  h.send(fix(s.ll(s.dest), 5000));
  h.run(200);
  maprama::LocationFix device;
  device.lng = s.ll(s.dest).lng;
  device.lat = s.ll(s.dest).lat;
  device.accuracyMeters = 4;
  device.timestamp = 6000;
  h.engine->onDeviceLocation(device);
  const bool reached = runUntil(h, [&] {
    const std::vector<Value> me = featuresWith(h.adapter->lastSource(gs::kSourceCharacters), "id", "me");
    return !me.empty() && meters(pointOf(me[0]), s.ll(s.dest)) < 1.0;
  }, 15000);
  ctx.check(reached && h.sink->eventsOfType("character:position").size() > moved, "a device fix drives the character");
  const std::size_t errors = count(h, "error");
  h.send(Value::object({{"type", "setLocationSource"}, {"source", "external"}}));
  ctx.check(h.adapter->locationStops == 1, "leaving the device source stops the feed");
  h.engine->onDeviceLocationError("provider disabled");
  ctx.check(count(h, "error") == errors, "no device error without the device source");
  h.send(Value::object({{"type", "setUi"}, {"ui", Value::object()}}));
  h.run(32);
  ctx.check(features(h.adapter->lastSource(gs::kSourcePuck)).empty(), "setUi without locationPuck hides the puck");
  ctx.check(h.sink->errors() == 0, "no invalid outgoing events");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m3a_style_layers_idle_frames_theme_and_reattach) {
  Harness h;
  initWorld(h, ctx);
  const Scene s = sceneOf(h);
  const Value style = maprama::json::parse(h.engine->styleJson()).value;
  for (const char* src : {gs::kSourceFences, gs::kSourceRoute, gs::kSourcePuck, gs::kSourceDrops, gs::kSourceCharacters}) {
    ctx.check(style.find("sources")->find(src) != nullptr, std::string("style has source ") + src);
  }
  ctx.check(layerIndex(style, gs::kLayerFenceFill) >= 0 && layerIndex(style, gs::kLayerFenceFill) < layerIndex(style, "buildings") &&
                layerIndex(style, gs::kLayerCharacters) > layerIndex(style, "buildings"),
            "game layers around the 3D buildings");

  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"isPlayer", true}, {"position", s.v(s.spawn)}})})));
  h.run(300);
  const std::size_t frames = h.adapter->frames.size();
  const std::size_t updates = h.adapter->sourceData.size();
  h.run(2000);
  ctx.check(h.adapter->frames.size() == frames && h.adapter->sourceData.size() == updates,
            "idle (external source, nothing moves): no frames, no source updates");

  const std::string day = prop(featuresWith(h.adapter->lastSource(gs::kSourceCharacters), "id", "me").at(0), "color");
  h.send(Value::object({{"type", "setTheme"}, {"theme", Value::object({{"base", "toy"}, {"timeOfDay", "night"}})}}));
  h.run(32);
  const std::string night = prop(featuresWith(h.adapter->lastSource(gs::kSourceCharacters), "id", "me").at(0), "color");
  ctx.check(day == maprama::cssHex(gs::kPlayerColor) && night != day, "character colour follows the time-of-day tint");

  h.engine->detachMapAdapter();
  h.adapter->sourceData.clear();
  const std::size_t styles = h.adapter->styles.size();
  h.engine->attachMapAdapter(h.adapter);
  h.run(32);
  bool all = h.adapter->styles.size() == styles + 1;
  for (const char* src : {gs::kSourceFences, gs::kSourceRoute, gs::kSourcePuck, gs::kSourceDrops, gs::kSourceCharacters}) {
    all = all && h.adapter->sourceUpdates(src) >= 1;
  }
  ctx.check(all, "re-attach: style re-sent, then every game source");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m3a_world_reload_cancels_trips_and_reprojects) {
  Harness h;
  initWorld(h, ctx);
  const Scene s = sceneOf(h);
  h.send(upsert(Value::array({Value::object({{"id", "me"}, {"isPlayer", true}, {"position", s.v(s.spawn)}})})));
  h.send(dropLayerMsg("coins", Value::array({Value::object({{"id", "c1"}, {"type", "cd"}, {"coordinate", s.v(s.dest)}})}), 1));
  h.send(Value::object({{"type", "setGeofences"},
                        {"geofences", Value::array({Value::object({{"id", "home"}, {"center", s.v(s.spawn)}, {"radiusMeters", 30}})})}}));
  h.run(48);
  ctx.check(count(h, "geofence:enter") == 1, "inside the home fence");
  h.send(travelMsg("t1", "me", s.v(s.dest), 1));
  h.run(500);
  const LngLat before = pointOf(featuresWith(h.adapter->lastSource(gs::kSourceCharacters), "id", "me").at(0));
  initWorld(h, ctx);
  ctx.check(last(h, "travel:cancel").find("requestId")->asString() == "t1", "a new world cancels running trips");
  h.run(48);
  const LngLat after = pointOf(featuresWith(h.adapter->lastSource(gs::kSourceCharacters), "id", "me").at(0));
  ctx.check(meters(before, after) < 1e-6, "characters keep their geographic position");
  ctx.check(features(h.adapter->lastSource(gs::kSourceDrops)).size() == 1 && features(h.adapter->lastSource(gs::kSourceFences)).size() == 2,
            "drop layers and geofences re-applied");
  ctx.check(count(h, "geofence:enter") == 1, "fence membership kept across the reload");
  appendEmitted(ctx, *h.sink);
}
