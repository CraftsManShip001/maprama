#include "diorama/WorldStore.hpp"

#include <set>
#include <utility>

#include "schemas.hpp"

namespace diorama {

namespace {

using json::Value;

Vec2 toVec2(const Value& v) { return Vec2{v.items()[0].asNumber(), v.items()[1].asNumber()}; }

std::vector<Vec2> toRing(const Value& v) {
  std::vector<Vec2> out;
  out.reserve(v.items().size());
  for (const Value& p : v.items()) out.push_back(toVec2(p));
  return out;
}

std::optional<std::string> optString(const Value& obj, std::string_view key) {
  const Value* v = obj.find(key);
  return v != nullptr ? std::optional<std::string>(v->asString()) : std::nullopt;
}

std::optional<bool> optBool(const Value& obj, std::string_view key) {
  const Value* v = obj.find(key);
  return v != nullptr ? std::optional<bool>(v->asBool()) : std::nullopt;
}

double num(const Value& obj, std::string_view key) { return obj.find(key)->asNumber(); }
const std::string& text(const Value& obj, std::string_view key) { return obj.find(key)->asString(); }

/// Converts a value that already passed `schemas::worldData()`.
WorldData convert(const Value& w) {
  WorldData out;
  out.version = static_cast<int>(num(w, "version"));
  out.name = text(w, "name");
  const Value& origin = *w.find("origin");
  out.origin = LngLat{num(origin, "lng"), num(origin, "lat")};
  out.unitMeters = num(w, "unitMeters");
  const Value& b = *w.find("bounds");
  out.bounds = WorldBounds{num(b, "minX"), num(b, "minZ"), num(b, "maxX"), num(b, "maxZ")};

  for (const Value& r : w.find("roads")->items()) {
    out.roads.push_back(Road{text(r, "id"), optString(r, "name"), *parseEnum<RoadClass>(text(r, "cls")),
                             optBool(r, "bridge"), toRing(*r.find("pts"))});
  }
  for (const Value& bd : w.find("buildings")->items()) {
    BuildingFootprint f;
    f.id = text(bd, "id");
    f.footprint = toRing(*bd.find("footprint"));
    f.height = num(bd, "height");
    if (const Value* levels = bd.find("levels")) f.levels = levels->asNumber();
    if (const Value* kind = bd.find("kind")) f.kind = parseEnum<BuildingKind>(kind->asString());
    f.name = optString(bd, "name");
    out.buildings.push_back(std::move(f));
  }
  for (const Value& poly : w.find("water")->items()) out.water.push_back(toRing(poly));
  for (const Value& p : w.find("parks")->items()) out.parks.push_back(Park{optString(p, "name"), toRing(*p.find("poly"))});
  for (const Value& p : w.find("pois")->items()) {
    out.pois.push_back(
        Poi{text(p, "id"), text(p, "name"), *parseEnum<PoiCategory>(text(p, "cat")), num(p, "x"), num(p, "z")});
  }
  for (const Value& s : w.find("stations")->items()) {
    out.stations.push_back(Station{text(s, "id"), text(s, "name"), num(s, "x"), num(s, "z")});
  }
  for (const Value& d : w.find("districts")->items()) {
    out.districts.push_back(District{text(d, "name"), num(d, "x"), num(d, "z"), optBool(d, "water")});
  }
  if (const Value* plaza = w.find("plaza")) out.plaza = WorldPoint{num(*plaza, "x"), num(*plaza, "z")};
  for (const Value& a : w.find("attribution")->items()) out.attribution.push_back(a.asString());
  return out;
}

template <class T>
void warnDuplicateIds(const std::vector<T>& items, const char* collection, std::vector<std::string>& warnings) {
  std::set<std::string_view> seen;
  for (const T& item : items) {
    if (!seen.insert(item.id).second) {
      warnings.push_back(std::string(collection) + ": duplicate id " + json::quote(item.id) +
                         " (first occurrence wins for lookups)");
    }
  }
}

class WorldStoreImpl final : public WorldStore {
 public:
  Result<WorldLoadReport> loadJson(std::string_view jsonText) override {
    json::ParseResult parsed = json::parse(jsonText);
    if (!parsed.ok) return Result<WorldLoadReport>::failure("$: invalid JSON: " + parsed.error);
    return load(parsed.value);
  }

  Result<WorldLoadReport> load(const Value& value) override {
    validate::RunResult checked = validate::run(schemas::worldData(), &value);
    if (!checked.ok) return Result<WorldLoadReport>::failure(std::move(checked.error));

    WorldData world = convert(value);
    Result<Projection> projection = Projection::create(ProjectionOptions{world.origin, world.unitMeters});
    if (!projection.ok()) return Result<WorldLoadReport>::failure(projection.error);  // unreachable after schema

    WorldLoadReport report;
    report.roads = world.roads.size();
    report.buildings = world.buildings.size();
    report.water = world.water.size();
    report.parks = world.parks.size();
    report.pois = world.pois.size();
    report.stations = world.stations.size();
    report.districts = world.districts.size();
    warnDuplicateIds(world.roads, "roads", report.warnings);
    warnDuplicateIds(world.buildings, "buildings", report.warnings);
    warnDuplicateIds(world.pois, "pois", report.warnings);
    warnDuplicateIds(world.stations, "stations", report.warnings);
    if (world.bounds.minX > world.bounds.maxX || world.bounds.minZ > world.bounds.maxZ) {
      report.warnings.emplace_back("bounds: min exceeds max");
    }
    std::string negativeExamples;
    for (const BuildingFootprint& b : world.buildings) {
      if (shoelaceArea2(b.footprint) < 0) {
        if (++report.negativeAreaFootprints <= 3) {
          negativeExamples += (negativeExamples.empty() ? "" : ", ") + json::quote(b.id);
        }
      }
    }
    if (report.negativeAreaFootprints > 0) {
      report.warnings.push_back("buildings: " + std::to_string(report.negativeAreaFootprints) +
                                " footprint(s) have negative shoelace area over [x, z] (expected positive), e.g. " +
                                negativeExamples);
    }

    world_ = std::move(world);
    projection_ = std::move(projection.value);
    return Result<WorldLoadReport>::success(std::move(report));
  }

  bool loaded() const override { return world_.has_value(); }
  const WorldData* world() const override { return world_ ? &*world_ : nullptr; }
  const Projection* projection() const override { return projection_ ? &*projection_ : nullptr; }

  const BuildingFootprint* findBuilding(std::string_view id) const override {
    if (!world_) return nullptr;
    for (const BuildingFootprint& b : world_->buildings) {
      if (b.id == id) return &b;
    }
    return nullptr;
  }

  const Road* findRoad(std::string_view id) const override {
    if (!world_) return nullptr;
    for (const Road& r : world_->roads) {
      if (r.id == id) return &r;
    }
    return nullptr;
  }

  void clear() override {
    world_.reset();
    projection_.reset();
  }

 private:
  std::optional<WorldData> world_;
  std::optional<Projection> projection_;
};

}  // namespace

double shoelaceArea2(const std::vector<Vec2>& ring) {
  double sum = 0.0;
  const std::size_t n = ring.size();
  for (std::size_t i = 0; i < n; ++i) {
    const Vec2& a = ring[i];
    const Vec2& b = ring[(i + 1) % n];
    // Separate statements: no FMA contraction, so the sign matches the JS reference bit for bit.
    const double t1 = a[0] * b[1];
    const double t2 = b[0] * a[1];
    sum += t1 - t2;
  }
  return sum;
}

std::unique_ptr<WorldStore> createWorldStore() { return std::make_unique<WorldStoreImpl>(); }

}  // namespace diorama
