// Shared helpers of the game-logic conformance suites (game_*_tests.cpp): fixture worlds, JSON accessors
// and float comparison statistics.
#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "harness.hpp"
#include "maprama/LocationFilter.hpp"
#include "maprama/ProceduralWorld.hpp"
#include "maprama/TravelLogic.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/json.hpp"

namespace maprama::test::game {

using json::Value;

/// Documented float tolerance of the game-logic ports: relative 1e-9 (the ports keep V8's operation order
/// and are bit-exact wherever only + - * / sqrt / hypot are involved; residual differences can only come
/// from the platform libm's sin / cos / atan2 / log last bit or the projection's cos).
inline constexpr double kRelTol = 1e-9;

inline double num(const Value* v) { return v != nullptr ? v->asNumber() : std::nan(""); }
inline double num(const Value& o, const char* key) { return num(o.find(key)); }
inline std::string str(const Value& o, const char* key) {
  const Value* v = o.find(key);
  return v != nullptr && v->isString() ? v->asString() : std::string();
}
inline bool has(const Value& o, const char* key) {
  const Value* v = o.find(key);
  return v != nullptr && !v->isNull();
}
inline WorldPoint point(const Value& pair) { return WorldPoint{pair.items()[0].asNumber(), pair.items()[1].asNumber()}; }
inline LngLat lngLat(const Value& pair) { return LngLat{pair.items()[0].asNumber(), pair.items()[1].asNumber()}; }
inline std::vector<TravelMode> modes(const Value& list) {
  std::vector<TravelMode> out;
  for (const Value& m : list.items()) out.push_back(*parseEnum<TravelMode>(m.asString()));
  return out;
}

/// Float comparison with statistics (values compared, bit-exact count, max absolute / relative deviation).
class FloatStats {
 public:
  explicit FloatStats(Context& ctx) : ctx_(ctx) {}

  bool number(double actual, double expected, const std::string& what) {
    ++values_;
    if (actual == expected || (std::isnan(actual) && std::isnan(expected))) {
      ++exact_;
      return ctx_.check(true, what);
    }
    const double diff = std::fabs(actual - expected);
    maxAbs_ = std::max(maxAbs_, diff);
    maxRel_ = std::max(maxRel_, diff / std::max(1.0, std::fabs(expected)));
    return ctx_.near(actual, expected, kRelTol * std::max(1.0, std::fabs(expected)), what);
  }
  bool number(double actual, const Value* expected, const std::string& what) {
    if (!ctx_.check(expected != nullptr && expected->isNumber(), what + " missing in fixture")) return false;
    return number(actual, expected->asNumber(), what);
  }
  void point(const WorldPoint& actual, const Value& pair, const std::string& what) {
    number(actual.x, pair.items()[0].asNumber(), what + ".x");
    number(actual.z, pair.items()[1].asNumber(), what + ".z");
  }
  void lngLat(const LngLat& actual, const Value& pair, const std::string& what) {
    number(actual.lng, pair.items()[0].asNumber(), what + ".lng");
    number(actual.lat, pair.items()[1].asNumber(), what + ".lat");
  }
  bool points(const std::vector<WorldPoint>& actual, const Value* expected, const std::string& what) {
    const std::size_t n = expected != nullptr ? expected->items().size() : 0;
    if (!ctx_.check(actual.size() == n, what + ": point count expected " + std::to_string(n) + ", got " + std::to_string(actual.size()))) {
      return false;
    }
    for (std::size_t i = 0; i < n; ++i) point(actual[i], expected->items()[i], what + "[" + std::to_string(i) + "]");
    return true;
  }

  long values() const { return values_; }
  long exact() const { return exact_; }
  double maxAbs() const { return maxAbs_; }
  double maxRel() const { return maxRel_; }

  /// One summary line: "<label>: N numbers, M bit-exact, max |diff| a (rel r)".
  void report(const std::string& label) const {
    char line[320];
    std::snprintf(line, sizeof line, "    %s: %ld numbers, %ld bit-exact, max |diff| %.3g (rel %.3g)\n", label.c_str(), values_, exact_,
                  maxAbs_, maxRel_);
    std::cout << line;
  }

 private:
  Context& ctx_;
  long values_ = 0;
  long exact_ = 0;
  double maxAbs_ = 0.0;
  double maxRel_ = 0.0;
};

inline double msSince(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

/// A fixture world (`worlds` of the game fixtures).
struct GameWorld {
  PlanWorld plan;
  std::optional<Projection> projection;
  std::optional<ProceduralLayout> layout;
  WorldPoint start;
  std::vector<Vec2> loopWays;
};

/// Builds every world named in `specs` (`{kind: 'data', inputPath | data, extraStations?}` or
/// `{kind: 'procedural', layout, seed}`).
inline std::map<std::string, GameWorld> loadGameWorlds(Context& ctx, const Value& specs) {
  std::map<std::string, GameWorld> out;
  for (const json::Member& m : specs.members()) {
    const Value& spec = m.value;
    GameWorld w;
    if (str(spec, "kind") == "procedural") {
      const std::optional<ProceduralLayout> layout = parseEnum<ProceduralLayout>(str(spec, "layout"));
      if (!ctx.check(layout.has_value(), m.key + ": procedural layout")) continue;
      const ProceduralWorld pw = buildProceduralWorld(*layout, num(spec, "seed"));
      w.plan = planWorldFromProcedural(pw);
      w.projection = *Projection::create(ProjectionOptions{pw.origin, pw.unitMeters}).value;
      w.layout = layout;
      w.start = pw.start;
      w.loopWays = pw.loopWays;
    } else {
      auto store = createWorldStore();
      Result<WorldLoadReport> r = has(spec, "inputPath") ? store->loadJson(readFile(str(spec, "inputPath"))) : store->load(*spec.find("data"));
      if (!ctx.check(r.ok(), m.key + ": world loads: " + r.error)) continue;
      const WorldData& data = *store->world();
      w.plan = planWorldFromData(data);
      if (const Value* extra = spec.find("extraStations")) {
        for (const Value& s : extra->items()) w.plan.stations.push_back(Station{str(s, "id"), str(s, "name"), num(s, "x"), num(s, "z")});
      }
      w.projection = *Projection::create(ProjectionOptions{data.origin, data.unitMeters}).value;
      w.start = dataWorldStart(data);
    }
    out.emplace(m.key, std::move(w));
  }
  return out;
}

}  // namespace maprama::test::game
