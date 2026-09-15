// M3a on procedural worlds: `init {world: {kind: "procedural"}}` hands the generated world to the game session
// (`MapSessionHooks::worldLoaded`), which plans on the generator's road graph and stations (engine-web
// `loadWorld` keeps the generator's `WorldModel.graph`), spawns characters at the generator's start and runs the
// simulated walker through its `loopWays`. The `route` / `snapToRoad` responses, the `travel:start` legs and the
// player's spawn point, all sent through the Engine, are compared with engine-web's travel-plan.json cases of the
// procedural fixture worlds (town42, grid7).
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "game_fixtures.hpp"
#include "map_harness.hpp"
#include "maprama/ProceduralWorld.hpp"
#include "maprama/Projection.hpp"
#include "maprama/RoadGraph.hpp"
#include "maprama/TravelLogic.hpp"

namespace {

namespace game = maprama::test::game;
namespace mt = maprama::test::maptest;
using maprama::LngLat;
using maprama::WorldPoint;
using maprama::json::Value;

Value llValue(const LngLat& p) { return mt::lngLat(p.lng, p.lat); }
Value llPair(const Value& pair) { return mt::lngLat(pair.items()[0].asNumber(), pair.items()[1].asNumber()); }

Value requestMsg(const std::string& id, const char* method, Value params) {
  return Value::object({{"type", "request"}, {"requestId", id}, {"method", method}, {"params", std::move(params)}});
}

/// The response to `requestId` (null when none was emitted).
Value responseTo(const mt::Harness& h, const std::string& requestId) {
  for (const Value& r : h.sink->eventsOfType("response")) {
    if (r.find("requestId")->asString() == requestId) return r;
  }
  return Value();
}

Value proceduralSource(const Value& spec) {
  return Value::object({{"kind", "procedural"}, {"layout", game::str(spec, "layout")}, {"seed", game::num(spec, "seed")}});
}

/// The generated world, its planning world and projection as the fixture exporter built them.
struct Generated {
  maprama::ProceduralWorld world;
  maprama::PlanWorld plan;
  std::optional<maprama::Projection> proj;
};

Generated generate(const Value& spec) {
  Generated g;
  g.world = maprama::buildProceduralWorld(*maprama::parseEnum<maprama::ProceduralLayout>(game::str(spec, "layout")),
                                          game::num(spec, "seed"));
  g.plan = maprama::planWorldFromProcedural(g.world);
  g.proj = *maprama::Projection::create(maprama::ProjectionOptions{g.world.origin, g.world.unitMeters}).value;
  return g;
}

}  // namespace

MAPRAMA_TEST(game_session_procedural_requests_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "travel-plan.json");
  game::FloatStats stats(ctx);
  std::map<std::string, long> routes, snaps;
  long nulls = 0;
  for (const maprama::json::Member& m : fixture.find("worlds")->members()) {
    if (game::str(m.value, "kind") != "procedural") continue;
    mt::Harness h;
    h.send(mt::initMsg(proceduralSource(m.value)));
    if (!ctx.check(h.engine->worldStore().loaded(), m.key + ": procedural world loaded")) continue;

    for (const Value& c : fixture.find("routes")->items()) {
      if (game::str(c, "world") != m.key) continue;
      const std::string id = m.key + " route " + std::to_string(routes[m.key]++);
      h.send(requestMsg(id, "route",
                        Value::object({{"from", llPair(*c.find("from"))}, {"to", llPair(*c.find("to"))}, {"modes", *c.find("modes")}})));
      const Value r = responseTo(h, id);
      if (!ctx.check(r.isObject() && r.find("ok")->asBool(), id + ": ok response")) continue;
      const Value& result = *r.find("result");
      const Value& legs = *result.find("legs");
      const Value& expected = *c.find("legs");
      if (!ctx.check(legs.items().size() == expected.items().size(), id + ": leg count")) continue;
      for (std::size_t i = 0; i < legs.items().size(); ++i) {
        const Value& a = legs.items()[i];
        const Value& e = expected.items()[i];
        const std::string what = id + " leg " + std::to_string(i);
        ctx.check(game::str(a, "mode") == game::str(e, "mode"), what + ": mode expected " + game::str(e, "mode") + ", got " + game::str(a, "mode"));
        stats.number(game::num(a, "meters"), e.find("meters"), what + ".meters");
        const Value& path = *a.find("path");
        const Value& ePath = *e.find("path");
        if (!ctx.check(path.items().size() == ePath.items().size(), what + ": path length")) continue;
        for (std::size_t k = 0; k < path.items().size(); ++k) {
          stats.lngLat(LngLat{game::num(path.items()[k], "lng"), game::num(path.items()[k], "lat")}, ePath.items()[k], what + ".path");
        }
      }
      stats.number(game::num(result, "meters"), c.find("meters"), id + ".meters");
      stats.number(game::num(result, "etaSeconds"), c.find("etaSeconds"), id + ".etaSeconds");
    }

    for (const Value& c : fixture.find("snaps")->items()) {
      if (game::str(c, "world") != m.key) continue;
      const std::string id = m.key + " snap " + std::to_string(snaps[m.key]++);
      Value params = Value::object({{"coordinate", llPair(*c.find("coordinate"))}});
      if (game::has(c, "maxDistanceMeters")) params.set("maxDistanceMeters", game::num(c, "maxDistanceMeters"));
      h.send(requestMsg(id, "snapToRoad", std::move(params)));
      const Value r = responseTo(h, id);
      if (!ctx.check(r.isObject() && r.find("ok")->asBool(), id + ": ok response")) continue;
      const Value& result = *r.find("result");
      const Value& e = *c.find("result");
      if (!ctx.check(result.isNull() == e.isNull(), id + ": null result expected " + (e.isNull() ? "yes" : "no"))) continue;
      if (e.isNull()) {
        ++nulls;
        continue;
      }
      ctx.check(game::str(result, "roadId") == game::str(e, "roadId"), id + ": roadId expected " + game::str(e, "roadId") + ", got " + game::str(result, "roadId"));
      const Value& coordinate = *result.find("coordinate");
      stats.lngLat(LngLat{game::num(coordinate, "lng"), game::num(coordinate, "lat")}, *e.find("coordinate"), id + ".coordinate");
      stats.number(game::num(result, "distanceMeters"), e.find("distanceMeters"), id + ".distanceMeters");
    }
    mt::appendEmitted(ctx, *h.sink);
  }
  ctx.check(routes["town42"] >= 10 && routes["grid7"] >= 10, "route cases on the procedural town and grid (" +
                                                                  std::to_string(routes["town42"]) + ", " + std::to_string(routes["grid7"]) + ")");
  ctx.check(snaps["town42"] >= 10 && nulls > 0 && nulls < snaps["town42"], "snapToRoad cases on the procedural town, with and without results");
  stats.report("procedural route: " + std::to_string(routes["town42"] + routes["grid7"]) + " results; snapToRoad: " +
               std::to_string(snaps["town42"]) + " (" + std::to_string(nulls) + " null)");
}

MAPRAMA_TEST(game_session_procedural_travel_and_spawn_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "travel-plan.json");
  game::FloatStats stats(ctx);
  std::map<std::string, long> travels;
  for (const maprama::json::Member& m : fixture.find("worlds")->members()) {
    if (game::str(m.value, "kind") != "procedural") continue;
    bool hasPlans = false;
    for (const Value& c : fixture.find("plans")->items()) hasPlans = hasPlans || game::str(c, "world") == m.key;
    if (!hasPlans) continue;
    const Generated g = generate(m.value);
    mt::Harness h;
    h.send(mt::initMsg(proceduralSource(m.value)));
    if (!ctx.check(h.engine->worldStore().loaded(), m.key + ": procedural world loaded")) continue;

    // A player without a position spawns at the generator's start snapped to the generator's roads (engine-web
    // `CharacterManager.spawnPoint`: procedural worlds use `world.start`, data worlds the plaza).
    h.send(Value::object({{"type", "subscribe"}, {"topic", "character:position"}, {"throttleMs", 16}}));
    h.send(Value::object({{"type", "upsertCharacters"}, {"characters", Value::array({Value::object({{"id", "p"}, {"isPlayer", true}})})}}));
    h.run(64);
    const std::vector<Value> positions = h.sink->eventsOfType("character:position");
    const std::optional<maprama::GraphSnap> spawn = maprama::snapToGraph(g.plan.graph, g.world.start.x, g.world.start.z);
    if (ctx.check(!positions.empty() && spawn.has_value(), m.key + ": spawn position reported")) {
      const LngLat expected = g.proj->toLngLat(WorldPoint{spawn->x, spawn->z});
      const Value& c = *positions.front().find("coordinate");
      stats.number(game::num(c, "lng"), expected.lng, m.key + " spawn.lng");
      stats.number(game::num(c, "lat"), expected.lat, m.key + " spawn.lat");
    }

    // `travel` from / to the fixture plans' points plans the same legs as engine-web's `planLegs` on the
    // generator's world (plans with an empty mode list are skipped: `decodeCommand` rejects `travel.modes: []`).
    long n = 0;
    for (const Value& c : fixture.find("plans")->items()) {
      if (game::str(c, "world") != m.key || c.find("modes")->items().empty() || n >= 40) continue;
      const std::string id = m.key + " travel " + std::to_string(n++);
      const WorldPoint from = game::point(*c.find("from"));
      const WorldPoint to = game::point(*c.find("to"));
      h.send(Value::object({{"type", "upsertCharacters"},
                            {"characters", Value::array({Value::object({{"id", "p"}, {"position", llValue(g.proj->toLngLat(from))}})})}}));
      const std::size_t before = h.sink->events.size();
      h.send(Value::object({{"type", "travel"},
                            {"requestId", id},
                            {"characterId", "p"},
                            {"to", llValue(g.proj->toLngLat(to))},
                            {"modes", *c.find("modes")}}));
      Value start;
      for (const Value& e : h.sink->eventsOfType("travel:start", before)) {
        if (e.find("requestId")->asString() == id) start = e;
      }
      if (!ctx.check(start.isObject(), id + ": travel:start")) continue;
      const Value& legs = *start.find("legs");
      const Value& expected = *c.find("legs");
      std::string actualModes, expectedModes;
      for (const Value& l : legs.items()) actualModes += game::str(l, "mode") + ",";
      for (const Value& l : expected.items()) expectedModes += game::str(l, "mode") + ",";
      ctx.check(actualModes == expectedModes, id + ": legs expected " + expectedModes + " got " + actualModes);
    }
    travels[m.key] = n;
    mt::appendEmitted(ctx, *h.sink);
  }
  ctx.check(travels["town42"] > 0 && travels["grid7"] > 0, "travel cases on the procedural town and grid");
  stats.report("procedural spawn points");
}
