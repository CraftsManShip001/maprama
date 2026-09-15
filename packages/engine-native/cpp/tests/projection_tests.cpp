// Projection / haversine vs createProjection samples (1e-6 world units).
#include <cmath>
#include <limits>
#include <string>

#include "maprama/Projection.hpp"
#include "harness.hpp"

namespace {

using maprama::json::Value;

constexpr double kWorldTolerance = 1e-6;   // world units (brief completion criterion)
constexpr double kDegreeTolerance = 1e-9;  // degrees (~0.1 mm)
constexpr double kMeterTolerance = 1e-6;

/// Numbers or the strings "NaN" / "Infinity" / "-Infinity" (JSON cannot carry non-finite numbers).
double number(const Value& v) {
  if (v.isNumber()) return v.asNumber();
  const std::string& s = v.asString();
  if (s == "NaN") return std::numeric_limits<double>::quiet_NaN();
  if (s == "Infinity") return std::numeric_limits<double>::infinity();
  if (s == "-Infinity") return -std::numeric_limits<double>::infinity();
  return 0.0;
}

maprama::LngLat lngLat(const Value& v) { return {number(*v.find("lng")), number(*v.find("lat"))}; }

maprama::ProjectionOptions options(const Value& v) {
  maprama::ProjectionOptions o;
  o.origin = lngLat(*v.find("origin"));
  if (const Value* unit = v.find("unitMeters")) o.unitMeters = number(*unit);
  return o;
}

}  // namespace

MAPRAMA_TEST(projection_matches_create_projection) {
  const Value fixture = maprama::test::loadFixture(ctx, "projection.json");
  long points = 0;
  for (const Value& sample : fixture.find("samples")->items()) {
    const maprama::ProjectionOptions opts = options(sample);
    const std::string label = "origin " + maprama::json::stringify(*sample.find("origin")) + " unitMeters " +
                              (opts.unitMeters ? maprama::json::numberToString(*opts.unitMeters) : "default");
    maprama::Result<maprama::Projection> proj = maprama::Projection::create(opts);
    if (!ctx.check(proj.ok(), label + ": create failed: " + proj.error)) continue;
    const maprama::Projection& p = *proj.value;
    ctx.check(p.unitMeters() == sample.find("expectedUnitMeters")->asNumber(), label + ": unitMeters");

    for (const Value& c : sample.find("toWorld")->items()) {
      const maprama::WorldPoint w = p.toWorld(lngLat(*c.find("input")));
      const Value& e = *c.find("expected");
      ctx.near(w.x, e.find("x")->asNumber(), kWorldTolerance, label + ": toWorld.x");
      ctx.near(w.z, e.find("z")->asNumber(), kWorldTolerance, label + ": toWorld.z");
      ++points;
    }
    for (const Value& c : sample.find("toLngLat")->items()) {
      const Value& in = *c.find("input");
      const maprama::LngLat ll = p.toLngLat({in.find("x")->asNumber(), in.find("z")->asNumber()});
      const Value& e = *c.find("expected");
      ctx.near(ll.lng, e.find("lng")->asNumber(), kDegreeTolerance, label + ": toLngLat.lng");
      ctx.near(ll.lat, e.find("lat")->asNumber(), kDegreeTolerance, label + ": toLngLat.lat");
      // Inverse consistency in world units.
      const maprama::WorldPoint back = p.toWorld(ll);
      ctx.near(back.x, in.find("x")->asNumber(), kWorldTolerance, label + ": toWorld(toLngLat).x");
      ctx.near(back.z, in.find("z")->asNumber(), kWorldTolerance, label + ": toWorld(toLngLat).z");
      ++points;
    }
    for (const Value& c : sample.find("distances")->items()) {
      const double meters = c.find("meters")->asNumber();
      ctx.near(p.metersToUnits(meters), c.find("units")->asNumber(), kWorldTolerance, label + ": metersToUnits");
      ctx.near(p.unitsToMeters(meters), c.find("unitsToMeters")->asNumber(), kMeterTolerance, label + ": unitsToMeters");
    }
  }
  ctx.check(points > 1000, "projection fixture has samples (" + std::to_string(points) + ")");
}

MAPRAMA_TEST(projection_errors_match_range_error_messages) {
  const Value fixture = maprama::test::loadFixture(ctx, "projection.json");
  for (const Value& c : fixture.find("errors")->items()) {
    maprama::Result<maprama::Projection> proj = maprama::Projection::create(options(c));
    const std::string& expected = c.find("error")->asString();
    ctx.check(!proj.ok() && proj.error == expected,
              "expected \"" + expected + "\", got " + (proj.ok() ? std::string("ok") : "\"" + proj.error + "\""));
  }
}

MAPRAMA_TEST(haversine_matches) {
  const Value fixture = maprama::test::loadFixture(ctx, "projection.json");
  for (const Value& c : fixture.find("haversine")->items()) {
    ctx.near(maprama::haversineMeters(lngLat(*c.find("a")), lngLat(*c.find("b"))), c.find("meters")->asNumber(),
             kMeterTolerance, "haversineMeters " + maprama::json::stringify(c));
  }
}
