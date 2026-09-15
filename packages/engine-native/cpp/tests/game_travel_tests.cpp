// Travel planning and following: conformance with engine-web's follower.ts / travel.ts / requests.ts
// (travel-plan.json, travel-trace.json).
#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "game_fixtures.hpp"
#include "maprama/LocationFilter.hpp"
#include "maprama/TravelLogic.hpp"

namespace {

using maprama::LngLat;
using maprama::PlannedLeg;
using maprama::TravelMode;
using maprama::WorldPoint;
using maprama::json::Value;
using namespace maprama::test::game;

std::string modeName(TravelMode m) { return std::string(maprama::enumName(m)); }

}  // namespace

MAPRAMA_TEST(game_travel_plans_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "travel-plan.json");
  const auto worlds = loadGameWorlds(ctx, *fixture.find("worlds"));
  FloatStats stats(ctx);
  std::map<std::string, std::pair<long, double>> nativeTimes;
  long plans = 0, legsTotal = 0;
  for (const Value& c : fixture.find("plans")->items()) {
    const std::string key = str(c, "world");
    const GameWorld& w = worlds.at(key);
    const WorldPoint from = point(*c.find("from")), to = point(*c.find("to"));
    const std::vector<TravelMode> ms = modes(*c.find("modes"));
    const auto t0 = std::chrono::steady_clock::now();
    const std::vector<PlannedLeg> legs = maprama::planLegs(w.plan, from, to, ms);
    auto& t = nativeTimes[key];
    t.first += 1;
    t.second += msSince(t0);
    const std::string label = "plan " + std::to_string(plans) + " (" + key + ")";
    const Value& expected = *c.find("legs");
    ++plans;
    if (!ctx.check(legs.size() == expected.items().size(), label + ": leg count expected " + std::to_string(expected.items().size()) +
                                                                ", got " + std::to_string(legs.size()))) {
      continue;
    }
    for (std::size_t i = 0; i < legs.size(); ++i) {
      const Value& e = expected.items()[i];
      const std::string what = label + " leg " + std::to_string(i);
      ctx.check(modeName(legs[i].mode) == str(e, "mode"), what + ": mode expected " + str(e, "mode") + ", got " + modeName(legs[i].mode));
      stats.points(legs[i].pts, e.find("pts"), what + ".pts");
      const Value* st = e.find("stations");
      ctx.check(legs[i].stations.has_value() == (st != nullptr), what + ": stations present");
      if (legs[i].stations && st != nullptr) {
        ctx.check((*legs[i].stations)[0].id == st->items()[0].asString() && (*legs[i].stations)[1].id == st->items()[1].asString(),
                  what + ": station ids");
      }
      ++legsTotal;
    }
  }
  ctx.check(plans > 500, "travel-plan.json has plans (" + std::to_string(plans) + ")");
  stats.report("planLegs: " + std::to_string(plans) + " plans, " + std::to_string(legsTotal) + " legs");
  const Value& times = *fixture.find("times");
  for (const auto& [key, t] : nativeTimes) {
    const Value* web = times.find(key);
    char line[200];
    std::snprintf(line, sizeof line, "    %s: %ld plans, native %.3f ms/plan (test build), engine-web %.3f ms/plan (node)\n", key.c_str(),
                  t.first, t.second / static_cast<double>(t.first),
                  web != nullptr ? num(*web, "webMs") / num(*web, "plans") : 0.0);
    std::cout << line;
  }
}

MAPRAMA_TEST(game_route_and_snap_requests_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "travel-plan.json");
  const auto worlds = loadGameWorlds(ctx, *fixture.find("worlds"));
  FloatStats stats(ctx);
  long routes = 0;
  for (const Value& c : fixture.find("routes")->items()) {
    const GameWorld& w = worlds.at(str(c, "world"));
    const maprama::RouteResult r = maprama::routeResult(w.plan, *w.projection, lngLat(*c.find("from")), lngLat(*c.find("to")), modes(*c.find("modes")));
    const std::string label = "route " + std::to_string(routes++);
    const Value& legs = *c.find("legs");
    if (!ctx.check(r.legs.size() == legs.items().size(), label + ": leg count")) continue;
    for (std::size_t i = 0; i < r.legs.size(); ++i) {
      const Value& e = legs.items()[i];
      const std::string what = label + " leg " + std::to_string(i);
      ctx.check(modeName(r.legs[i].mode) == str(e, "mode"), what + ": mode");
      stats.number(r.legs[i].meters, e.find("meters"), what + ".meters");
      const Value& path = *e.find("path");
      if (!ctx.check(r.legs[i].path.size() == path.items().size(), what + ": path length")) continue;
      for (std::size_t k = 0; k < path.items().size(); ++k) stats.lngLat(r.legs[i].path[k], path.items()[k], what + ".path");
    }
    stats.number(r.meters, c.find("meters"), label + ".meters");
    stats.number(r.etaSeconds, c.find("etaSeconds"), label + ".etaSeconds");
  }
  long snaps = 0, nulls = 0;
  for (const Value& c : fixture.find("snaps")->items()) {
    const GameWorld& w = worlds.at(str(c, "world"));
    std::optional<double> maxDistance;
    if (has(c, "maxDistanceMeters")) maxDistance = num(c, "maxDistanceMeters");
    const auto r = maprama::snapToRoad(w.plan, *w.projection, lngLat(*c.find("coordinate")), maxDistance);
    const Value& e = *c.find("result");
    const std::string label = "snap " + std::to_string(snaps++);
    if (!ctx.check(r.has_value() == !e.isNull(), label + ": null result expected " + (e.isNull() ? "yes" : "no"))) continue;
    if (!r) {
      ++nulls;
      continue;
    }
    ctx.check(r->roadId == str(e, "roadId"), label + ": roadId expected " + str(e, "roadId") + ", got " + r->roadId);
    stats.lngLat(r->coordinate, *e.find("coordinate"), label + ".coordinate");
    stats.number(r->distanceMeters, e.find("distanceMeters"), label + ".distanceMeters");
  }
  ctx.check(routes > 100 && snaps > 100 && nulls > 0 && nulls < snaps, "routes and snaps (with and without results) exported");
  stats.report("route: " + std::to_string(routes) + " results; snapToRoad: " + std::to_string(snaps) + " (" + std::to_string(nulls) + " null)");
}

MAPRAMA_TEST(game_travel_helpers_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "travel-plan.json");
  const Value& h = *fixture.find("helpers");
  FloatStats stats(ctx);
  for (const Value& c : h.find("playbackSpeeds")->items()) {
    const maprama::ModeSpeeds s = maprama::playbackSpeeds(num(c, "unitMeters"), num(c, "timeScale"));
    for (std::size_t i = 0; i < s.size(); ++i) stats.number(s[i], &c.find("speeds")->items()[i], "playbackSpeeds");
  }
  for (const Value& c : h.find("etaSeconds")->items()) {
    stats.number(maprama::etaSeconds(num(c, "meters"), *maprama::parseEnum<TravelMode>(str(c, "mode"))), c.find("seconds"), "etaSeconds");
  }
  for (const Value& c : h.find("planeAltitude")->items()) {
    stats.number(maprama::planeAltitude(num(c, "t"), num(c, "length")), c.find("altitude"), "planeAltitude");
  }
  for (const Value& c : h.find("splitByLength")->items()) {
    std::vector<WorldPoint> pts;
    for (const Value& p : c.find("pts")->items()) pts.push_back(point(p));
    const auto parts = maprama::splitByLength(pts, static_cast<std::size_t>(num(c, "n")));
    const Value& e = *c.find("parts");
    if (!ctx.check(parts.size() == e.items().size(), "splitByLength part count")) continue;
    for (std::size_t i = 0; i < parts.size(); ++i) stats.points(parts[i], &e.items()[i], "splitByLength part " + std::to_string(i));
  }
  for (const Value& c : h.find("normalizeModes")->items()) {
    std::string actual, expected;
    for (TravelMode m : maprama::normalizeModes(modes(*c.find("modes")))) actual += modeName(m) + ",";
    for (const Value& m : c.find("normalized")->items()) expected += m.asString() + ",";
    ctx.check(actual == expected, "normalizeModes expected " + expected + ", got " + actual);
  }
  for (const Value& c : h.find("remainingEta")->items()) {
    std::vector<maprama::LegRemaining> rem;
    for (const Value& r : c.find("rem")->items()) rem.push_back(maprama::LegRemaining{*maprama::parseEnum<TravelMode>(str(r, "mode")), num(r, "d")});
    stats.number(maprama::remainingEtaSeconds(rem, num(c, "unitMeters"), num(c, "timeScale")), c.find("seconds"), "remainingEtaSeconds");
  }
  const Value& gy = *h.find("groundY");
  stats.number(maprama::groundYFor(maprama::ProceduralLayout::Grid), gy.find("grid"), "groundY grid");
  stats.number(maprama::groundYFor(maprama::ProceduralLayout::Town), gy.find("town"), "groundY town");
  stats.number(maprama::groundYFor(std::nullopt), gy.find("data"), "groundY data");
  stats.report("helpers");
}

namespace {

struct TraceChar {
  std::string id;
  maprama::Follower follower;
};

void compareEvent(maprama::test::Context& ctx, FloatStats& stats, const maprama::TravelEvent& a, const Value& e, const std::string& what) {
  ctx.check(std::string(maprama::travelEventTypeName(a.type)) == str(e, "type"),
            what + ": type expected " + str(e, "type") + ", got " + std::string(maprama::travelEventTypeName(a.type)));
  ctx.check(a.requestId == str(e, "requestId") && a.characterId == str(e, "characterId"), what + ": ids");
  if (a.type == maprama::TravelEvent::Type::Start) {
    const Value& legs = *e.find("legs");
    if (!ctx.check(a.legs.size() == legs.items().size(), what + ": start leg count")) return;
    for (std::size_t i = 0; i < a.legs.size(); ++i) {
      ctx.check(modeName(a.legs[i].mode) == str(legs.items()[i], "mode"), what + ": start leg mode");
      stats.number(a.legs[i].meters, legs.items()[i].find("meters"), what + ".legs.meters");
    }
  } else if (a.type == maprama::TravelEvent::Type::Progress) {
    stats.number(a.remainingMeters, e.find("remainingMeters"), what + ".remainingMeters");
    stats.number(a.etaSeconds, e.find("etaSeconds"), what + ".etaSeconds");
    ctx.check(modeName(a.mode) == str(e, "mode"), what + ": progress mode expected " + str(e, "mode") + ", got " + modeName(a.mode));
  }
}

void compareEvents(maprama::test::Context& ctx, FloatStats& stats, const std::vector<maprama::TravelEvent>& actual, const Value* expected,
                   const std::string& what) {
  const std::size_t n = expected != nullptr ? expected->items().size() : 0;
  if (!ctx.check(actual.size() == n, what + ": event count expected " + std::to_string(n) + ", got " + std::to_string(actual.size()))) return;
  for (std::size_t i = 0; i < n; ++i) compareEvent(ctx, stats, actual[i], expected->items()[i], what + " event " + std::to_string(i));
}

}  // namespace

MAPRAMA_TEST(game_travel_traces_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "travel-trace.json");
  const auto worlds = loadGameWorlds(ctx, *fixture.find("worlds"));
  long traces = 0, samplesTotal = 0, eventsTotal = 0;
  for (const Value& sc : fixture.find("traces")->items()) {
    const std::string name = str(sc, "name");
    const GameWorld& w = worlds.at(str(sc, "world"));
    const maprama::Projection& proj = *w.projection;
    FloatStats stats(ctx);
    const double gy = maprama::groundYFor(w.layout);
    std::vector<TraceChar> chars;
    for (const Value& c : sc.find("characters")->items()) {
      TraceChar ch{str(c, "id"), maprama::Follower(gy)};
      ch.follower.body.x = num(c, "x");
      ch.follower.body.z = num(c, "z");
      ch.follower.body.y = gy;
      chars.push_back(std::move(ch));
    }
    const auto find = [&](std::string_view id) -> maprama::Follower* {
      for (TraceChar& ch : chars) {
        if (ch.id == id) return &ch.follower;
      }
      return nullptr;
    };
    const maprama::FollowerLookup lookup = find;
    maprama::TravelTrips trips;
    std::vector<maprama::TravelEvent> events;
    const double dt = num(sc, "dt");
    const long steps = static_cast<long>(num(sc, "steps"));
    const long every = static_cast<long>(num(sc, "every"));
    const Value& samples = *sc.find("samples");
    const Value& commands = *sc.find("commands");
    std::size_t next = 0;
    const auto t0 = std::chrono::steady_clock::now();
    for (long i = 0; i <= steps; ++i) {
      for (const Value& c : commands.items()) {
        if (static_cast<long>(num(c, "at")) != i) continue;
        const std::string type = str(c, "type");
        maprama::Follower* f = find(str(c, "characterId"));
        if (!ctx.check(f != nullptr, name + ": command character")) continue;
        if (type == "travel") {
          const WorldPoint to = point(*c.find("toWorld"));
          const WorldPoint own = proj.toWorld(lngLat(*c.find("toLngLat")));
          stats.point(own, *c.find("toWorld"), name + ": projected destination");
          trips.start(w.plan, proj, str(c, "requestId"), str(c, "characterId"), *f, to, modes(*c.find("modes")), num(c, "timeScale"), events);
        } else if (type == "cancel") {
          trips.cancel(str(c, "characterId"), *f, events);
        } else if (type == "drive") {
          if (trips.isTraveling(str(c, "characterId"))) continue;
          const maprama::LocationDrive drive =
              maprama::planLocationDrive(w.plan.graph, WorldPoint{f->body.x, f->body.z}, point(*c.find("estimate")));
          maprama::applyLocationDrive(*f, drive);
        }
      }
      if (i > 0) {
        for (TraceChar& ch : chars) {
          if (ch.follower.stepCharacter(dt)) trips.arrived(ch.id, events);
        }
      }
      const bool want = !events.empty() || i % every == 0 || i == steps;
      const bool fixtureHas = next < samples.items().size() && static_cast<long>(num(samples.items()[next], "i")) == i;
      if (!ctx.check(want == fixtureHas, name + ": sample at step " + std::to_string(i) + (want ? " not expected" : " missing"))) {
        if (!fixtureHas) {
          events.clear();
          continue;
        }
      }
      if (!fixtureHas) continue;
      const Value& s = samples.items()[next++];
      const std::string at = name + " @" + std::to_string(i);
      compareEvents(ctx, stats, events, s.find("events"), at);
      eventsTotal += static_cast<long>(events.size());
      events.clear();
      std::vector<maprama::TravelEvent> progress;
      trips.progress(proj, lookup, progress);
      compareEvents(ctx, stats, progress, s.find("progress"), at + " progress");
      const Value& expectedChars = *s.find("chars");
      for (std::size_t k = 0; k < chars.size() && k < expectedChars.items().size(); ++k) {
        const Value& e = expectedChars.items()[k];
        const maprama::Follower& f = chars[k].follower;
        const std::string what = at + " " + chars[k].id;
        stats.number(f.body.x, e.find("x"), what + ".x");
        stats.number(f.body.y, e.find("y"), what + ".y");
        stats.number(f.body.z, e.find("z"), what + ".z");
        stats.number(f.body.speed, e.find("speed"), what + ".speed");
        stats.number(f.body.targetYaw, e.find("targetYaw"), what + ".targetYaw");
        stats.number(f.body.planePitch, e.find("planePitch"), what + ".planePitch");
        stats.number(f.wait, e.find("wait"), what + ".wait");
        ctx.check(modeName(f.body.mode) == str(e, "mode"), what + ": mode expected " + str(e, "mode") + ", got " + modeName(f.body.mode));
        ctx.check(static_cast<double>(f.li) == num(e, "li") && static_cast<double>(f.si) == num(e, "si"),
                  what + ": li/si expected " + std::to_string(num(e, "li")) + "/" + std::to_string(num(e, "si")) + ", got " +
                      std::to_string(f.li) + "/" + std::to_string(f.si));
        ctx.check(f.active() == e.find("active")->asBool(), what + ": active");
        const std::optional<TravelMode> fm = f.mode();
        ctx.check(fm ? modeName(*fm) == str(e, "followerMode") : e.find("followerMode")->isNull(), what + ": follower mode");
      }
      ++samplesTotal;
    }
    ctx.check(next == samples.items().size(), name + ": all samples visited");
    char line[320];
    std::snprintf(line, sizeof line, "    %s: %zu samples, native %.2f ms, engine-web %.2f ms\n", name.c_str(), samples.items().size(),
                  msSince(t0), num(sc, "webMs"));
    std::cout << line;
    stats.report("  " + name);
    ++traces;
  }
  ctx.check(traces >= 8, "travel-trace.json has traces");
  std::cout << "    traces: " << traces << ", samples: " << samplesTotal << ", travel events: " << eventsTotal << "\n";
}

MAPRAMA_TEST(game_follower_unit_behaviour) {
  // engine-web follower.test.ts: the ETA matches the playback time at timeScale 1 and 20.
  maprama::PlanWorld world;
  world.graph = maprama::buildRoadGraph({maprama::GraphRoad{"main", std::nullopt, maprama::RoadClass::Arterial, false, {{-60, 0}, {60, 0}}},
                                         maprama::GraphRoad{"cross", std::nullopt, maprama::RoadClass::Local, false, {{0, -60}, {0, 60}}}});
  for (const double timeScale : {1.0, 20.0}) {
    maprama::Follower f(0.09);
    f.body.x = -40;
    f.body.z = 3;
    f.setTrip(maprama::planLegs(world, {-40, 3}, {2, 40}, {TravelMode::Walk}), std::nullopt, maprama::playbackSpeeds(8, timeScale));
    const double eta = maprama::remainingEtaSeconds(f.remainingByLeg(), 8, timeScale);
    double t = 0;
    int arrivals = 0;
    while (f.active() && t < 10000) {
      if (f.step(0.1)) ++arrivals;
      t += 0.1;
    }
    ctx.check(!f.active() && arrivals == 1, "follower arrives once");
    ctx.check(std::fabs(t - eta) < 0.11, "ETA matches playback time at timeScale " + std::to_string(timeScale));
    ctx.check(std::fabs(f.body.x - 2) < 1e-9 && std::fabs(f.body.z - 40) < 1e-9, "follower ends at the destination");
  }
  // A trip without legs: travel:start then travel:arrive, the follower is untouched.
  maprama::TravelTrips trips;
  maprama::Follower f;
  std::vector<maprama::TravelEvent> events;
  const auto proj = *maprama::Projection::create(maprama::ProjectionOptions{LngLat{127, 37.5}, 8.0}).value;
  trips.start(world, proj, "r", "c", f, {0, 0}, {TravelMode::Car}, 1, events);
  ctx.check(events.size() == 2 && events[0].type == maprama::TravelEvent::Type::Start && events[1].type == maprama::TravelEvent::Type::Arrive &&
                !trips.isTraveling("c"),
            "no-leg trip starts and arrives at once");
}
