// Camera distance limits in meters and `fitBounds` geometry: conformance with engine-web's
// `core/camera.ts` (DIST_MIN / DIST_MAX / DIST_HARD_* / limitsInUnits / nearFor / farFor) and
// `core/fit-bounds.ts` (camera.json, produced from those sources).
//
// The fit math is scale free, so the core runs it in meters where engine-web runs it in world
// units; the fixture is in world units and compared directly (one unit = one length unit).
#include <cmath>
#include <string>
#include <vector>

#include "harness.hpp"
#include "game_fixtures.hpp"
#include "maprama/CameraMath.hpp"

namespace {

namespace cm = maprama::camera_math;
using maprama::json::Value;
using maprama::test::game::num;
using maprama::test::game::str;

cm::FitOrientation orientationOf(const std::string& name) {
  if (name == "keep") return cm::FitOrientation::Keep;
  if (name == "reset") return cm::FitOrientation::Reset;
  return cm::FitOrientation::Auto;
}

/// engine-web `limitsInUnits` + `CameraController.setDistanceLimits`, as the session applies them.
struct Effective {
  double min;
  double max;
  bool clamped;
};

Effective effectiveLimits(const Value& limits, double unitMeters) {
  const Value* min = limits.find("min");
  const Value* max = limits.find("max");
  const double wantMin = min != nullptr ? min->asNumber() / unitMeters : cm::kDistanceMinUnits;
  const double wantMax = max != nullptr ? max->asNumber() / unitMeters : cm::kDistanceMaxUnits;
  const double lo = cm::clampValue(wantMin, cm::kDistanceHardMinUnits, cm::kDistanceHardMaxUnits);
  const double hi = cm::clampValue(wantMax, lo, cm::kDistanceHardMaxUnits);
  return {lo, hi, lo != wantMin || hi != wantMax};
}

}  // namespace

MAPRAMA_TEST(camera_constants_match_engine_web) {
  const Value fx = maprama::test::loadFixture(ctx, "camera.json");
  if (!ctx.check(fx.isObject(), "camera.json loads")) return;
  const Value& c = *fx.find("constants");
  ctx.check(num(c, "fovDeg") == cm::kReferenceFovDeg, "field of view = 40 degrees");
  ctx.check(num(c, "distMinUnits") == cm::kDistanceMinUnits, "DIST_MIN = 14 world units");
  ctx.check(num(c, "distMaxUnits") == cm::kDistanceMaxUnits, "DIST_MAX = 150 world units");
  ctx.check(num(c, "hardMinUnits") == cm::kDistanceHardMinUnits, "DIST_HARD_MIN = 2 world units");
  ctx.check(num(c, "hardMaxUnits") == cm::kDistanceHardMaxUnits, "DIST_HARD_MAX = 1000 world units");
  ctx.check(static_cast<int>(num(c, "fitIterations")) == cm::kFitIterations, "FIT_ITERATIONS = 24");

  // `visibleSpanMeters`: the conversion integrators were hard-coding.
  for (const Value& s : fx.find("visibleSpan")->items()) {
    const double d = num(s, "distance");
    const double got = 2.0 * d * std::tan((cm::kReferenceFovDeg * 3.14159265358979323846 / 180.0) / 2.0);
    ctx.near(got, num(s, "span"), 1e-9, "visibleSpanMeters(" + std::to_string(d) + ")");
  }
}

MAPRAMA_TEST(camera_distance_limits_in_meters_match_engine_web) {
  const Value fx = maprama::test::loadFixture(ctx, "camera.json");
  if (!ctx.check(fx.isObject(), "camera.json loads")) return;
  int n = 0;
  for (const Value& c : fx.find("limits")->items()) {
    const double u = num(c, "unitMeters");
    const Effective eff = effectiveLimits(*c.find("limits"), u);
    const Value& want = *c.find("effective");
    const std::string at = "unitMeters " + std::to_string(static_cast<int>(u)) + " case " + std::to_string(n);
    ctx.near(eff.min, num(want, "min"), 1e-12, at + ": min in world units");
    ctx.near(eff.max, num(want, "max"), 1e-12, at + ": max in world units");
    ctx.check(eff.clamped == want.find("clamped")->asBool(), at + ": clamped flag");
    // The same request clamps to the same distance in meters at every world scale.
    ctx.near(eff.min * u, num(c, "clampedMinMeters"), 1e-9, at + ": closest in meters");
    ctx.near(eff.max * u, num(c, "clampedMaxMeters"), 1e-9, at + ": furthest in meters");
    ++n;
  }
  ctx.check(n == 18, "3 world scales x 6 ranges");
}

MAPRAMA_TEST(camera_fit_bounds_matches_engine_web) {
  const Value fx = maprama::test::loadFixture(ctx, "camera.json");
  if (!ctx.check(fx.isObject(), "camera.json loads")) return;
  int n = 0;
  for (const Value& c : fx.find("fit")->items()) {
    const std::string name = str(c, "name");
    const Value& in = *c.find("input");
    cm::FitBoundsInput input;
    for (const Value& p : in.find("corners")->items()) input.corners.push_back({num(p, "x"), num(p, "z")});
    input.width = num(in, "width");
    input.height = num(in, "height");
    const Value& pad = *in.find("padding");
    input.padding = {num(pad, "top"), num(pad, "right"), num(pad, "bottom"), num(pad, "left")};
    input.fovDeg = num(in, "fovDeg");
    input.pitch = num(in, "pitch");
    input.bearing = num(in, "bearing");
    input.minDistance = num(in, "minDistance");
    input.maxDistance = num(in, "maxDistance");
    input.startDistance = num(in, "startDistance");

    const cm::FitBoundsOutput got = cm::fitBounds(input, orientationOf(str(c, "orientation")));
    const Value& want = *c.find("out");
    const double tol = 1e-6 * std::max(1.0, std::fabs(num(want, "distance")));
    ctx.near(got.distance, num(want, "distance"), tol, name + ": distance");
    ctx.near(got.x, num(want, "x"), tol, name + ": target x");
    ctx.near(got.z, num(want, "z"), tol, name + ": target z");
    ctx.near(got.pitch, num(want, "pitch"), 1e-12, name + ": pitch");
    ctx.near(got.bearing, num(want, "bearing"), 1e-12, name + ": bearing");
    ctx.check(got.fitted == want.find("fitted")->asBool(), name + ": fitted");
    ctx.check(got.distanceLimited == want.find("distanceLimited")->asBool(), name + ": distanceLimited");
    ++n;
  }
  ctx.check(n >= 14, "every fitBounds fixture case ran");
}
