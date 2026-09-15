// Procedural worlds: conformance with engine-web's generators (procedural.json), the WorldData conversion
// and generation time.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "maprama/ProceduralWorld.hpp"
#include "maprama/WorldStore.hpp"
#include "harness.hpp"

namespace {

using maprama::Vec2;
using maprama::json::Value;
using maprama::test::Context;

/// Relative tolerance for generated geometry (the port keeps V8's operation order; residual differences
/// can only come from the platform libm's sin / cos / atan2 / pow last bit).
constexpr double kRelTol = 1e-9;

struct NumStats {
  long values = 0;
  long exact = 0;
  double maxAbs = 0.0;
};

class Comparer {
 public:
  Comparer(Context& ctx, std::string label) : ctx_(ctx), label_(std::move(label)) {}

  void number(double actual, const Value* expected, const std::string& what) {
    if (!ctx_.check(expected != nullptr && expected->isNumber(), label_ + ": " + what + " missing in fixture")) return;
    const double e = expected->asNumber();
    ++stats_.values;
    if (actual == e) ++stats_.exact;
    stats_.maxAbs = std::max(stats_.maxAbs, std::fabs(actual - e));
    ctx_.near(actual, e, kRelTol * std::max(1.0, std::fabs(e)), label_ + ": " + what);
  }
  void number(double actual, const Value& object, const char* key, const std::string& what) {
    number(actual, object.find(key), what + "." + key);
  }
  void integer(long actual, const Value* expected, const std::string& what) {
    const long e = expected != nullptr && expected->isNumber() ? static_cast<long>(expected->asNumber()) : -1;
    ctx_.check(actual == e, label_ + ": " + what + " expected " + std::to_string(e) + ", got " + std::to_string(actual));
  }
  void text(std::string_view actual, const Value* expected, const std::string& what) {
    const std::string e = expected != nullptr && expected->isString() ? expected->asString() : std::string("<missing>");
    ctx_.check(actual == e, label_ + ": " + what + " expected \"" + e + "\", got \"" + std::string(actual) + "\"");
  }
  /// Absent JS booleans (optional fields) count as false.
  void flag(bool actual, const Value* expected, const std::string& what) {
    const bool e = expected != nullptr && expected->asBool();
    ctx_.check(actual == e, label_ + ": " + what + " expected " + (e ? "true" : "false"));
  }
  bool count(std::size_t actual, const Value* expected, const std::string& what) {
    const std::size_t e = expected != nullptr ? expected->items().size() : 0;
    return ctx_.check(actual == e, label_ + ": " + what + " count expected " + std::to_string(e) + ", got " +
                                       std::to_string(actual));
  }
  void points(const std::vector<Vec2>& actual, const Value* expected, const std::string& what) {
    if (!count(actual.size(), expected, what)) return;
    for (std::size_t i = 0; i < actual.size(); ++i) {
      const Value& p = expected->items()[i];
      number(actual[i][0], &p.items()[0], what + "[" + std::to_string(i) + "].x");
      number(actual[i][1], &p.items()[1], what + "[" + std::to_string(i) + "].z");
    }
  }
  void point(double x, double z, const Value* expected, const std::string& what) {
    if (!ctx_.check(expected != nullptr && expected->isObject(), label_ + ": " + what + " missing")) return;
    number(x, *expected, "x", what);
    number(z, *expected, "z", what);
  }

  const NumStats& stats() const { return stats_; }

 private:
  Context& ctx_;
  std::string label_;
  NumStats stats_;
};

double msSince(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

void compareWorld(Comparer& c, const maprama::ProceduralWorld& nw, const Value& w) {
  using maprama::enumName;
  c.text(nw.name, w.find("name"), "name");
  c.number(nw.unitMeters, w.find("unitMeters"), "unitMeters");
  c.number(nw.origin.lng, *w.find("origin"), "lng", "origin");
  c.number(nw.origin.lat, *w.find("origin"), "lat", "origin");
  const Value& bounds = *w.find("bounds");
  c.number(nw.bounds.minX, bounds, "minX", "bounds");
  c.number(nw.bounds.minZ, bounds, "minZ", "bounds");
  c.number(nw.bounds.maxX, bounds, "maxX", "bounds");
  c.number(nw.bounds.maxZ, bounds, "maxZ", "bounds");

  const Value* roads = w.find("roads");
  if (c.count(nw.graph.roads.size(), roads, "roads")) {
    for (std::size_t i = 0; i < nw.graph.roads.size(); ++i) {
      const maprama::GraphRoad& r = nw.graph.roads[i];
      const Value& e = roads->items()[i];
      const std::string what = "road " + r.id;
      c.text(r.id, e.find("id"), what + ".id");
      c.text(r.name.value_or(""), e.find("name"), what + ".name");
      c.text(enumName(r.cls), e.find("cls"), what + ".cls");
      c.flag(r.bridge, e.find("bridge"), what + ".bridge");
      c.points(r.pts, e.find("pts"), what + ".pts");
    }
  }
  const Value* nodes = w.find("nodes");
  if (c.count(nw.graph.nodes.size(), nodes, "graph nodes")) {
    for (std::size_t i = 0; i < nw.graph.nodes.size(); ++i) {
      const Value& e = nodes->items()[i];
      c.number(nw.graph.nodes[i].x, e, "x", "node " + std::to_string(i));
      c.number(nw.graph.nodes[i].z, e, "z", "node " + std::to_string(i));
    }
  }
  const Value* edges = w.find("edges");
  if (c.count(nw.graph.edges.size(), edges, "graph edges")) {
    for (std::size_t i = 0; i < nw.graph.edges.size(); ++i) {
      const maprama::GraphEdge& ed = nw.graph.edges[i];
      const Value& e = edges->items()[i];
      const std::string what = "edge " + std::to_string(i);
      c.integer(ed.a, e.find("a"), what + ".a");
      c.integer(ed.b, e.find("b"), what + ".b");
      c.text(enumName(ed.cls), e.find("cls"), what + ".cls");
      c.text(nw.graph.roads[static_cast<std::size_t>(ed.road)].id, e.find("roadId"), what + ".roadId");
      c.flag(ed.bridge, e.find("bridge"), what + ".bridge");
      c.number(ed.len, e.find("len"), what + ".len");
    }
  }

  const Value* buildings = w.find("buildings");
  if (c.count(nw.buildings.size(), buildings, "buildings")) {
    for (std::size_t i = 0; i < nw.buildings.size(); ++i) {
      const maprama::ProceduralBuilding& b = nw.buildings[i];
      const Value& e = buildings->items()[i];
      const std::string what = "building " + b.id;
      c.text(b.id, e.find("id"), what + ".id");
      c.integer(b.idx, e.find("idx"), what + ".idx");
      c.number(b.x, e, "x", what);
      c.number(b.z, e, "z", what);
      c.number(b.yaw, e, "yaw", what);
      c.number(b.w, *e.find("rect"), "w", what + ".rect");
      c.number(b.d, *e.find("rect"), "d", what + ".rect");
      c.points(b.footprint, e.find("footprint"), what + ".footprint");
      c.number(b.h, e, "h", what);
      c.text(enumName(b.kind), e.find("kind"), what + ".kind");
      c.text(enumName(b.roof), e.find("roof"), what + ".roof");
      c.integer(b.ci, e.find("ci"), what + ".ci");
      const Value& decos = *e.find("decos");
      c.flag(b.sign, decos.find("sign"), what + ".decos.sign");
      c.flag(b.antenna, decos.find("antenna"), what + ".decos.antenna");
      c.flag(b.garden, decos.find("garden"), what + ".decos.garden");
      c.text(maprama::massShapeName(b.autoShape), e.find("autoShape"), what + ".autoShape");
      c.flag(b.landmark, e.find("landmark"), what + ".landmark");
    }
  }

  const auto ribbons = [&](const std::vector<maprama::ProceduralRibbon>& actual, const char* key) {
    const Value* expected = w.find(key);
    if (!c.count(actual.size(), expected, key)) return;
    for (std::size_t i = 0; i < actual.size(); ++i) {
      const Value& e = expected->items()[i];
      c.number(actual[i].width, e, "width", std::string(key) + "[" + std::to_string(i) + "]");
      c.points(actual[i].pts, e.find("pts"), std::string(key) + "[" + std::to_string(i) + "].pts");
    }
  };
  ribbons(nw.waterRibbons, "waterRibbons");
  ribbons(nw.banks, "banks");
  const Value* pads = w.find("pads");
  if (c.count(nw.pads.size(), pads, "pads")) {
    for (std::size_t i = 0; i < nw.pads.size(); ++i) c.points(nw.pads[i], &pads->items()[i], "pads[" + std::to_string(i) + "]");
  }
  const Value* water = w.find("water");
  c.count(0, water, "water polygons");
  const Value* parks = w.find("parks");
  if (c.count(nw.parks.size(), parks, "parks")) {
    for (std::size_t i = 0; i < nw.parks.size(); ++i) {
      const Value& e = parks->items()[i];
      c.text(nw.parks[i].name.value_or(""), e.find("name"), "park name");
      c.points(nw.parks[i].poly, e.find("poly"), "park poly");
    }
  }
  const Value* plaza = w.find("plaza");
  if (nw.plaza) {
    c.point(nw.plaza->x, nw.plaza->z, plaza, "plaza");
    if (plaza != nullptr && plaza->isObject()) c.number(nw.plaza->radius, *plaza, "radius", "plaza");
  }
  const Value* blocks = w.find("gridBlocks");
  if (blocks == nullptr || blocks->isNull()) {
    c.count(nw.gridBlocks.size(), nullptr, "gridBlocks");
  } else if (c.count(nw.gridBlocks.size(), blocks, "gridBlocks")) {
    for (std::size_t i = 0; i < nw.gridBlocks.size(); ++i) {
      const maprama::ProceduralGridBlock& b = nw.gridBlocks[i];
      const Value& e = blocks->items()[i];
      const std::string what = "gridBlock " + std::to_string(i);
      c.number(b.cx, e, "cx", what);
      c.number(b.cz, e, "cz", what);
      c.text(maprama::gridBlockKindName(b.kind), e.find("kind"), what + ".kind");
      c.integer(b.bi, e.find("bi"), what + ".bi");
      c.integer(b.bj, e.find("bj"), what + ".bj");
    }
  }
  const Value* trees = w.find("sceneryTrees");
  if (c.count(nw.sceneryTrees.size(), trees, "sceneryTrees")) {
    for (std::size_t i = 0; i < nw.sceneryTrees.size(); ++i) {
      const maprama::ProceduralTree& t = nw.sceneryTrees[i];
      const Value& e = trees->items()[i];
      const std::string what = "tree " + std::to_string(i);
      c.number(t.x, e, "x", what);
      c.number(t.y, e, "y", what);
      c.number(t.z, e, "z", what);
      c.number(t.s, e, "s", what);
      c.flag(t.noOutline, e.find("noOutline"), what + ".noOutline");
    }
  }
  c.text(nw.ground, w.find("ground"), "ground");
  c.number(nw.buildingBaseY, w.find("buildingBaseY"), "buildingBaseY");

  const Value* pois = w.find("pois");
  if (c.count(nw.pois.size(), pois, "pois")) {
    for (std::size_t i = 0; i < nw.pois.size(); ++i) {
      const maprama::Poi& p = nw.pois[i];
      const Value& e = pois->items()[i];
      c.text(p.id, e.find("id"), "poi id");
      c.text(p.name, e.find("name"), "poi " + p.id + ".name");
      c.text(enumName(p.cat), e.find("cat"), "poi " + p.id + ".cat");
      c.point(p.x, p.z, &e, "poi " + p.id);
    }
  }
  const Value* stations = w.find("stations");
  if (c.count(nw.stations.size(), stations, "stations")) {
    for (std::size_t i = 0; i < nw.stations.size(); ++i) {
      const maprama::Station& s = nw.stations[i];
      const Value& e = stations->items()[i];
      c.text(s.id, e.find("id"), "station id");
      c.text(s.name, e.find("name"), "station " + s.id + ".name");
      c.point(s.x, s.z, &e, "station " + s.id);
    }
  }
  const Value* districts = w.find("districts");
  if (c.count(nw.districts.size(), districts, "districts")) {
    for (std::size_t i = 0; i < nw.districts.size(); ++i) {
      const maprama::District& d = nw.districts[i];
      const Value& e = districts->items()[i];
      c.text(d.name, e.find("name"), "district name");
      c.point(d.x, d.z, &e, "district " + d.name);
      c.flag(d.water.value_or(false), e.find("water"), "district " + d.name + ".water");
    }
  }
  c.point(nw.start.x, nw.start.z, w.find("start"), "start");
  c.points(nw.spawn, w.find("spawn"), "spawn");
  c.points(nw.loopWays, w.find("loopWays"), "loopWays");
}

}  // namespace

MAPRAMA_TEST(procedural_mulberry32_matches_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "procedural.json");
  long sequences = 0;
  for (const Value& c : fixture.find("prng")->items()) {
    const double seed = c.find("seed")->asNumber();
    maprama::js_math::Mulberry32 r(seed);
    int i = 0;
    for (const Value& v : c.find("values")->items()) {
      const double actual = r();
      ctx.check(actual == v.asNumber(), "mulberry32(" + maprama::json::numberToString(seed) + ") value " + std::to_string(i) +
                                            ": expected " + maprama::json::numberToString(v.asNumber()) + ", got " +
                                            maprama::json::numberToString(actual));
      ++i;
    }
    ++sequences;
  }
  ctx.check(sequences >= 10, "procedural.json has PRNG sequences");
  ctx.check(maprama::js_math::toInt32(2147485024.0) == -2147482272, "toInt32 wraps");
  ctx.check(maprama::js_math::round(2.5) == 3 && maprama::js_math::round(-2.5) == -2 && maprama::js_math::round(-0.2) == 0,
            "Math.round semantics");
}

MAPRAMA_TEST(procedural_worlds_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "procedural.json");
  long worlds = 0;
  for (const Value& c : fixture.find("worlds")->items()) {
    const std::string& layoutName = c.find("layout")->asString();
    const double seed = c.find("seed")->asNumber();
    const std::optional<maprama::ProceduralLayout> layout = maprama::parseEnum<maprama::ProceduralLayout>(layoutName);
    if (!ctx.check(layout.has_value(), "fixture layout " + layoutName)) continue;
    const auto t0 = std::chrono::steady_clock::now();
    const maprama::ProceduralWorld nw = maprama::buildProceduralWorld(*layout, seed);
    const double nativeMs = msSince(t0);
    const std::string label = layoutName + " seed " + maprama::json::numberToString(seed);
    Comparer cmp(ctx, label);
    compareWorld(cmp, nw, *c.find("world"));
    const NumStats& st = cmp.stats();
    char line[256];
    std::snprintf(line, sizeof line,
                  "    %s: %zu buildings, %zu roads, %zu edges; %ld numbers, %ld bit-exact, max |diff| %.3g; "
                  "native %.1f ms (test build), engine-web %.1f ms (node)\n",
                  label.c_str(), nw.buildings.size(), nw.graph.roads.size(), nw.graph.edges.size(), st.values, st.exact,
                  st.maxAbs, nativeMs, c.find("webMs")->asNumber());
    std::cout << line;
    ++worlds;
  }
  ctx.check(worlds >= 6, "procedural.json has worlds for both layouts");
}

MAPRAMA_TEST(procedural_world_data_loads_into_world_store) {
  for (const maprama::ProceduralLayout layout : {maprama::ProceduralLayout::Town, maprama::ProceduralLayout::Grid}) {
    for (const double seed : {0.0, 42.0}) {
      const maprama::ProceduralWorld world = maprama::buildProceduralWorld(layout, seed);
      const std::string label = std::string(maprama::enumName(layout)) + " seed " + maprama::json::numberToString(seed);
      const Value data = maprama::proceduralWorldData(world);
      auto store = maprama::createWorldStore();
      maprama::Result<maprama::WorldLoadReport> r = store->load(data);
      if (!ctx.check(r.ok(), label + ": WorldData validates: " + r.error)) continue;
      const maprama::WorldLoadReport& report = *r.value;
      std::string warnings;
      for (const std::string& w : report.warnings) warnings += " " + w;
      ctx.check(report.warnings.empty(), label + ": no load warnings (unique ids, positive winding):" + warnings);
      ctx.check(report.negativeAreaFootprints == 0, label + ": footprints have positive winding");
      ctx.check(report.buildings == world.buildings.size() && report.roads == world.graph.roads.size(),
                label + ": all buildings and roads converted");
      const bool town = layout == maprama::ProceduralLayout::Town;
      ctx.check(report.water == (town ? 1u : 2u), label + ": water = river ribbon / grid park ponds (" +
                                                      std::to_string(report.water) + ")");
      ctx.check(report.parks == (town ? 3u : 2u), label + ": parks = banks + named parks / park blocks (" +
                                                      std::to_string(report.parks) + ")");
      ctx.check(report.pois == world.pois.size() && report.stations == world.stations.size() &&
                    report.districts == world.districts.size(),
                label + ": pois / stations / districts converted");
      const maprama::WorldData& wd = *store->world();
      ctx.check(wd.plaza.has_value() && wd.plaza->x == world.plaza->x && wd.plaza->z == world.plaza->z, label + ": plaza");
      const maprama::BuildingFootprint* landmark = store->findBuilding("landmark");
      ctx.check(landmark != nullptr && landmark->height == 8 && landmark->kind == maprama::BuildingKind::Glass,
                label + ": landmark tower");
      ctx.check(wd.name == world.name && wd.unitMeters == 8 && wd.origin.lng == maprama::kProceduralOrigin.lng,
                label + ": name / origin / unit");
      // The JSON text path (what a host would send as a `data` world) loads the same world.
      maprama::Result<maprama::WorldLoadReport> again = maprama::createWorldStore()->loadJson(maprama::json::stringify(data));
      ctx.check(again.ok() && again.value->buildings == report.buildings, label + ": stringified WorldData reloads");
    }
  }
  // Deterministic: the same seed gives the same world, another seed a different one.
  const maprama::ProceduralWorld a = maprama::buildTownWorld(3), b = maprama::buildTownWorld(3), other = maprama::buildTownWorld(4);
  ctx.check(maprama::json::stringify(maprama::proceduralWorldData(a)) == maprama::json::stringify(maprama::proceduralWorldData(b)),
            "town seed 3 is deterministic");
  ctx.check(maprama::json::stringify(maprama::proceduralWorldData(a)) != maprama::json::stringify(maprama::proceduralWorldData(other)),
            "town seeds 3 and 4 differ");
}

MAPRAMA_TEST(procedural_generation_time) {
  // Generation + WorldData conversion + WorldStore validation/load (the whole `init` world path).
  for (const maprama::ProceduralLayout layout : {maprama::ProceduralLayout::Town, maprama::ProceduralLayout::Grid}) {
    std::vector<double> gen, total;
    for (int i = 0; i < 7; ++i) {
      const auto t0 = std::chrono::steady_clock::now();
      const maprama::ProceduralWorld world = maprama::buildProceduralWorld(layout, i);
      gen.push_back(msSince(t0));
      auto store = maprama::createWorldStore();
      const bool ok = store->load(maprama::proceduralWorldData(world)).ok();
      total.push_back(msSince(t0));
      ctx.check(ok, "generated world loads");
    }
    std::sort(gen.begin(), gen.end());
    std::sort(total.begin(), total.end());
    char line[200];
    std::snprintf(line, sizeof line, "    %s: generate %.2f ms, generate + WorldData + load %.2f ms (median of 7, test build)\n",
                  std::string(maprama::enumName(layout)).c_str(), gen[3], total[3]);
    std::cout << line;
    // Sanity bound for the sanitizer build; the -O2 number is recorded in DESIGN.md §6.8.
    ctx.check(total[3] < 2000, "generation finishes in reasonable time");
  }
}
