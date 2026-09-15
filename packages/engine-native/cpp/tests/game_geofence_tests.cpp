// Geofence membership: conformance with engine-web's geofences.ts `GeofenceTracker` (geofences.json).
#include <algorithm>
#include <string>
#include <vector>

#include "game_fixtures.hpp"
#include "maprama/GeofenceLogic.hpp"

namespace {

using maprama::json::Value;
using namespace maprama::test::game;

}  // namespace

MAPRAMA_TEST(game_geofences_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "geofences.json");
  FloatStats stats(ctx);
  long scenarios = 0, updates = 0, transitions = 0;
  for (const Value& sc : fixture.find("scenarios")->items()) {
    const std::string name = str(sc, "name");
    const Value& origin = *sc.find("origin");
    const auto proj = *maprama::Projection::create(maprama::ProjectionOptions{maprama::LngLat{num(origin, "lng"), num(origin, "lat")}, num(sc, "unitMeters")}).value;
    maprama::GeofenceTracker tracker;
    const Value& ops = *sc.find("ops");
    const Value& results = *sc.find("results");
    for (std::size_t i = 0; i < ops.items().size(); ++i) {
      const Value& op = ops.items()[i];
      const Value& res = results.items()[i];
      const std::string what = name + " op " + std::to_string(i);
      if (str(op, "op") == "set") {
        std::vector<maprama::WorldFence> fences;
        for (const Value& f : op.find("fences")->items()) fences.push_back(maprama::WorldFence{str(f, "id"), num(f, "x"), num(f, "z"), num(f, "r")});
        if (const Value* specs = op.find("specs")) {
          std::vector<maprama::GeofenceSpec> list;
          for (const Value& s : specs->items()) {
            const Value& c = *s.find("center");
            list.push_back(maprama::GeofenceSpec{str(s, "id"), maprama::LngLat{num(c, "lng"), num(c, "lat")}, num(s, "radiusMeters")});
          }
          const std::vector<maprama::WorldFence> own = maprama::worldFences(list, proj);
          if (ctx.check(own.size() == fences.size(), what + ": converted fence count")) {
            for (std::size_t k = 0; k < own.size(); ++k) {
              ctx.check(own[k].id == fences[k].id, what + ": fence id");
              stats.number(own[k].x, fences[k].x, what + " fence.x");
              stats.number(own[k].z, fences[k].z, what + " fence.z");
              stats.number(own[k].r, fences[k].r, what + " fence.r");
            }
          }
        }
        tracker.set(fences);
        continue;
      }
      std::vector<maprama::CharacterPosition> chars;
      for (const Value& c : op.find("characters")->items()) chars.push_back(maprama::CharacterPosition{str(c, "id"), num(c, "x"), num(c, "z"), false});
      const std::vector<maprama::GeofenceTransition> events = tracker.update(chars);
      const Value& expected = *res.find("events");
      if (ctx.check(events.size() == expected.items().size(), what + ": transition count expected " + std::to_string(expected.items().size()) +
                                                                ", got " + std::to_string(events.size()))) {
        for (std::size_t k = 0; k < events.size(); ++k) {
          const Value& e = expected.items()[k];
          const std::string type = events[k].enter ? "geofence:enter" : "geofence:exit";
          ctx.check(type == str(e, "type") && events[k].geofenceId == str(e, "geofenceId") && events[k].characterId == str(e, "characterId"),
                    what + ": transition " + std::to_string(k) + " expected " + str(e, "type") + " " + str(e, "geofenceId") + "/" +
                        str(e, "characterId") + ", got " + type + " " + events[k].geofenceId + "/" + events[k].characterId);
        }
      }
      transitions += static_cast<long>(events.size());
      const Value& inside = *res.find("inside");
      const auto& list = tracker.list();
      if (ctx.check(list.size() == inside.items().size(), what + ": fence list")) {
        for (std::size_t k = 0; k < list.size(); ++k) {
          std::vector<std::string> in;
          for (const auto& c : chars) {
            if (tracker.isInside(list[k].id, c.id)) in.push_back(c.id);
          }
          std::sort(in.begin(), in.end());
          std::vector<std::string> exp;
          for (const Value& v : inside.items()[k].find("inside")->items()) exp.push_back(v.asString());
          ctx.check(in == exp, what + ": inside " + list[k].id);
        }
      }
      ++updates;
    }
    ++scenarios;
  }
  ctx.check(scenarios >= 5 && transitions > 20, "geofence scenarios with transitions");
  stats.report("geofences: " + std::to_string(scenarios) + " scenarios, " + std::to_string(updates) + " updates, " + std::to_string(transitions) +
               " transitions");
}
