// Location smoothing, road following and the simulated demo loop: conformance with engine-web's
// location.ts and features.ts `driveToFix` (location.json).
#include <chrono>
#include <cmath>
#include <functional>
#include <string>
#include <vector>

#include "game_fixtures.hpp"
#include "maprama/LocationFilter.hpp"

namespace {

using maprama::WorldPoint;
using maprama::json::Value;
using namespace maprama::test::game;

maprama::SmootherOptions smootherOptions(const Value* o) {
  maprama::SmootherOptions opts;
  if (o == nullptr || !o->isObject()) return opts;
  if (has(*o, "gain")) opts.gain = num(*o, "gain");
  if (has(*o, "velocityGain")) opts.velocityGain = num(*o, "velocityGain");
  if (has(*o, "outlierUnits")) opts.outlierUnits = num(*o, "outlierUnits");
  if (has(*o, "maxSpeedUnits")) opts.maxSpeedUnits = num(*o, "maxSpeedUnits");
  if (has(*o, "maxConsecutiveRejects")) opts.maxConsecutiveRejects = num(*o, "maxConsecutiveRejects");
  if (has(*o, "maxAccuracyUnits")) opts.maxAccuracyUnits = num(*o, "maxAccuracyUnits");
  return opts;
}

void compareSmoothed(maprama::test::Context& ctx, FloatStats& stats, const maprama::SmoothedFix& a, const Value& e, const std::string& what) {
  stats.number(a.x, e.find("x"), what + ".x");
  stats.number(a.z, e.find("z"), what + ".z");
  stats.number(a.accuracy, e.find("accuracy"), what + ".accuracy");
  stats.number(a.vx, e.find("vx"), what + ".vx");
  stats.number(a.vz, e.find("vz"), what + ".vz");
  ctx.check(a.rejected == e.find("rejected")->asBool(), what + ": rejected expected " + (e.find("rejected")->asBool() ? "true" : "false"));
}

std::function<double()> mulberry(double seed) { return maprama::js_math::Mulberry32(seed); }

}  // namespace

MAPRAMA_TEST(game_gps_smoother_matches_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "location.json");
  FloatStats stats(ctx);
  long sequences = 0, fixes = 0, rejected = 0;
  for (const Value& c : fixture.find("smoother")->items()) {
    maprama::GpsSmoother s(smootherOptions(c.find("options")));
    const Value& in = *c.find("fixes");
    const Value& out = *c.find("out");
    for (std::size_t i = 0; i < in.items().size(); ++i) {
      const Value& f = in.items()[i];
      maprama::WorldFix wf{num(f, "x"), num(f, "z"), num(f, "t"), std::nullopt};
      if (has(f, "accuracy")) wf.accuracy = num(f, "accuracy");
      const maprama::SmoothedFix r = s.push(wf);
      if (r.rejected) ++rejected;
      compareSmoothed(ctx, stats, r, out.items()[i], str(c, "name") + " fix " + std::to_string(i));
      ++fixes;
    }
    ++sequences;
  }
  ctx.check(sequences >= 10 && rejected > 0, "smoother sequences with rejections");
  stats.report("GpsSmoother: " + std::to_string(sequences) + " sequences, " + std::to_string(fixes) + " fixes (" + std::to_string(rejected) +
               " rejected)");
}

MAPRAMA_TEST(game_location_service_pipeline_matches_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "location.json");
  const auto worlds = loadGameWorlds(ctx, *fixture.find("worlds"));
  FloatStats stats(ctx);
  long used = 0;
  for (const Value& p : fixture.find("pipelines")->items()) {
    const GameWorld& w = worlds.at(str(p, "world"));
    maprama::LocationService svc(mulberry(num(p, "seed")));
    svc.worldChanged(maprama::buildDemoLoop(w.plan.graph, w.loopWays, w.start));
    long i = 0;
    for (const Value& s : p.find("steps")->items()) {
      const std::string what = str(p, "world") + " step " + std::to_string(i++);
      if (has(s, "setKind")) {
        const bool changed = svc.setKind(*maprama::parseEnum<maprama::LocationSourceKind>(str(s, "setKind")));
        ctx.check(changed == s.find("changed")->asBool(), what + ": setKind changed");
        continue;
      }
      const Value& f = *s.find("fix");
      maprama::LocationFix fix;
      fix.lng = num(f, "lng");
      fix.lat = num(f, "lat");
      fix.timestamp = num(f, "timestamp");
      if (has(f, "accuracyMeters")) fix.accuracyMeters = num(f, "accuracyMeters");
      if (has(f, "headingDeg")) fix.headingDeg = num(f, "headingDeg");
      const std::optional<maprama::ProcessedFix> r = svc.push(fix, *w.projection);
      if (!ctx.check(r.has_value() == s.find("used")->asBool(), what + ": push used")) continue;
      if (!r) continue;
      ++used;
      const Value& e = *s.find("out");
      compareSmoothed(ctx, stats, r->fix, e, what);
      stats.point(r->raw, *e.find("raw"), what + ".raw");
      ctx.check(r->headingDeg.has_value() == has(e, "headingDeg"), what + ": heading present");
      if (r->headingDeg) stats.number(*r->headingDeg, e.find("headingDeg"), what + ".headingDeg");
      ctx.check(svc.last().has_value() && svc.last()->fix.x == r->fix.x, what + ": last fix");
    }
  }
  ctx.check(used > 50, "external pipeline processed fixes");
  stats.report("LocationService (external): " + std::to_string(used) + " fixes");
}

MAPRAMA_TEST(game_demo_loop_and_simulated_walker_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "location.json");
  const auto worlds = loadGameWorlds(ctx, *fixture.find("worlds"));
  FloatStats stats(ctx);
  const Value& constants = *fixture.find("constants");
  stats.number(maprama::kSimulatedWalkSpeed, constants.find("SIMULATED_WALK_SPEED"), "SIMULATED_WALK_SPEED");
  stats.number(maprama::kMaxSnapUnits, constants.find("MAX_SNAP_UNITS"), "MAX_SNAP_UNITS");
  stats.number(maprama::kTeleportUnits, constants.find("TELEPORT_UNITS"), "TELEPORT_UNITS");
  for (const Value& d : fixture.find("demoLoops")->items()) {
    const GameWorld& w = worlds.at(str(d, "world"));
    stats.point(w.start, *d.find("start"), str(d, "world") + " start");
    stats.points(maprama::buildDemoLoop(w.plan.graph, w.loopWays, w.start), d.find("loop"), str(d, "world") + " demo loop");
  }
  {
    auto rng = mulberry(num(*fixture.find("gauss"), "seed"));
    long k = 0;
    for (const Value& v : fixture.find("gauss")->find("values")->items()) stats.number(maprama::gauss(rng), v.asNumber(), "gauss " + std::to_string(k++));
  }
  long fixesTotal = 0, outliers = 0;
  for (const Value& sim : fixture.find("simulated")->items()) {
    const std::string name = "simulated " + str(sim, "world");
    const GameWorld& w = worlds.at(str(sim, "world"));
    const std::vector<WorldPoint> loop = maprama::buildDemoLoop(w.plan.graph, w.loopWays, w.start);
    stats.points(loop, sim.find("loop"), name + " loop");
    maprama::SimulatedWalker walker(loop, mulberry(num(sim, "seed")));
    maprama::GpsSmoother smoother;
    const double dt = num(sim, "dt");
    const long steps = static_cast<long>(num(sim, "steps"));
    const Value& fixes = *sim.find("fixes");
    const Value& truth = *sim.find("truth");
    std::size_t fi = 0, ti = 0;
    double t = 0;
    for (long i = 0; i < steps; ++i) {
      t += dt;
      const std::optional<maprama::SimulatedFix> f = walker.step(dt);
      if (i % 10 == 0 && ti < truth.items().size()) {
        const Value& e = truth.items()[ti++];
        stats.number(walker.truth.x, e.find("x"), name + " truth.x");
        stats.number(walker.truth.z, e.find("z"), name + " truth.z");
        stats.number(walker.t, e.find("t"), name + " walker.t");
        ctx.check(static_cast<double>(walker.seg) == num(e, "seg"), name + ": walker segment at step " + std::to_string(i));
      }
      if (!f) continue;
      if (!ctx.check(fi < fixes.items().size() && static_cast<long>(num(fixes.items()[fi], "i")) == i,
                     name + ": fix due at step " + std::to_string(i))) {
        break;
      }
      const Value& e = fixes.items()[fi++];
      const std::string what = name + " fix @" + std::to_string(i);
      stats.number(f->x, e.find("x"), what + ".x");
      stats.number(f->z, e.find("z"), what + ".z");
      ctx.check(f->outlier == e.find("outlier")->asBool(), what + ": outlier flag");
      if (f->outlier) ++outliers;
      compareSmoothed(ctx, stats, smoother.push(maprama::WorldFix{f->x, f->z, t, std::nullopt}), *e.find("out"), what);
      ++fixesTotal;
    }
    ctx.check(fi == fixes.items().size(), name + ": all fixes produced");
  }
  ctx.check(fixesTotal > 300 && outliers > 0, "simulated walker produced fixes and outliers");
  stats.report("demo loops, gauss, simulated walkers (" + std::to_string(fixesTotal) + " fixes, " + std::to_string(outliers) + " outliers)");
}

MAPRAMA_TEST(game_location_trips_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "location.json");
  const auto worlds = loadGameWorlds(ctx, *fixture.find("worlds"));
  FloatStats stats(ctx);
  long trips = 0, teleports = 0, stills = 0;
  for (const Value& c : fixture.find("trips")->items()) {
    const GameWorld& w = worlds.at(str(c, "world"));
    const WorldPoint from = point(*c.find("from")), est = point(*c.find("est"));
    const std::string what = "trip " + std::to_string(trips++) + " (" + str(c, "world") + ")";
    const maprama::LocationTrip trip = maprama::locationTrip(w.plan.graph, from, est);
    stats.points(trip.pts, c.find("pts"), what + ".pts");
    stats.number(trip.speed, c.find("speed"), what + ".speed");
    if (trip.speed == 0) ++stills;
    if (has(c, "maxSnap")) {
      const maprama::LocationTrip t2 = maprama::locationTrip(w.plan.graph, from, est, num(c, "maxSnap"));
      stats.points(t2.pts, c.find("pts2"), what + ".pts(maxSnap)");
      stats.number(t2.speed, c.find("speed2"), what + ".speed(maxSnap)");
    }
    const maprama::LocationDrive drive = maprama::planLocationDrive(w.plan.graph, from, est);
    ctx.check(drive.teleport == c.find("drive")->find("teleport")->asBool(), what + ": teleport decision");
    if (drive.teleport) ++teleports;
  }
  ctx.check(trips >= 100 && teleports > 0 && stills > 0, "trips include teleports and still estimates");
  stats.report("locationTrip: " + std::to_string(trips) + " trips (" + std::to_string(teleports) + " teleports, " + std::to_string(stills) +
               " still)");
}

MAPRAMA_TEST(game_location_drive_applies_to_follower) {
  maprama::RoadGraph graph = maprama::buildRoadGraph(
      {maprama::GraphRoad{"main", std::nullopt, maprama::RoadClass::Arterial, false, {{-100, 0}, {100, 0}}},
       maprama::GraphRoad{"cross", std::nullopt, maprama::RoadClass::Local, false, {{0, -40}, {0, 40}}}});
  maprama::Follower f(0.09);
  f.body.x = -10;
  // near a road: walk along the network at the override speed
  maprama::LocationDrive d = maprama::planLocationDrive(graph, {-10, 0}, {0.5, 10});
  maprama::applyLocationDrive(f, d);
  ctx.check(!d.teleport && f.active() && f.speedOverride && *f.speedOverride > 0 && *f.speedOverride <= 8, "walks to a near estimate");
  // far: teleport and stop
  d = maprama::planLocationDrive(graph, {-10, 0}, {60, 0});
  maprama::applyLocationDrive(f, d);
  ctx.check(d.teleport && !f.active() && f.body.x == 60 && f.body.z == 0, "teleports beyond 40 units");
  // the source switch resets the smoother; pushes only count for the external source
  maprama::LocationService svc(mulberry(1));
  const auto proj = *maprama::Projection::create(maprama::ProjectionOptions{maprama::LngLat{127, 37.5}, 8.0}).value;
  maprama::LocationFix fix;
  fix.lng = 127;
  fix.lat = 37.5;
  ctx.check(!svc.push(fix, proj).has_value(), "push ignored with the simulated source");
  ctx.check(svc.setKind(maprama::LocationSourceKind::External) && !svc.setKind(maprama::LocationSourceKind::External), "setKind reports changes");
  ctx.check(svc.push(fix, proj).has_value() && !svc.onDevice(fix, proj).has_value(), "external source takes pushLocation only");
}
