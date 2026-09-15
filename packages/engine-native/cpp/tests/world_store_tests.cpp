// WorldStore: validateWorldData parity, typed conversion, semantic warnings.
#include <string>

#include "diorama/WorldStore.hpp"
#include "diorama/protocol.hpp"
#include "harness.hpp"

namespace {
using diorama::json::Value;
}  // namespace

DIORAMA_TEST(world_store_matches_validate_world_data) {
  const Value fixture = diorama::test::loadFixture(ctx, "world.json");
  long okCases = 0;
  bool sawRealSample = false;
  for (const Value& c : fixture.find("cases")->items()) {
    const std::string& name = c.find("name")->asString();
    std::string input;
    if (const Value* path = c.find("inputPath")) {
      input = diorama::test::readFile(path->asString());
      sawRealSample = true;
    } else {
      input = c.find("input")->asString();
    }
    auto store = diorama::createWorldStore();
    diorama::Result<diorama::WorldLoadReport> r = store->loadJson(input);

    if (!c.find("ok")->asBool()) {
      const std::string& expected = c.find("error")->asString();
      ctx.check(!r.ok() && r.error == expected, "world [" + name + "]: expected \"" + expected + "\", got " +
                                                    (r.ok() ? std::string("ok") : "\"" + r.error + "\""));
      ctx.check(!store->loaded(), "world [" + name + "]: failed load leaves the store empty");
      continue;
    }
    ++okCases;
    if (!ctx.check(r.ok(), "world [" + name + "]: expected ok, got \"" + r.error + "\"")) continue;
    const Value& s = *c.find("summary");
    const diorama::WorldLoadReport& report = *r.value;
    const diorama::WorldData& w = *store->world();
    const auto count = [&s](const char* key) { return static_cast<std::size_t>(s.find(key)->asNumber()); };
    ctx.check(w.name == s.find("name")->asString(), "world [" + name + "]: name");
    ctx.check(report.roads == count("roads") && w.roads.size() == count("roads"), "world [" + name + "]: roads");
    ctx.check(report.buildings == count("buildings") && w.buildings.size() == count("buildings"),
              "world [" + name + "]: buildings");
    ctx.check(report.water == count("water") && report.parks == count("parks") && report.pois == count("pois") &&
                  report.stations == count("stations") && report.districts == count("districts"),
              "world [" + name + "]: water/parks/pois/stations/districts");
    ctx.check(w.attribution.size() == count("attribution"), "world [" + name + "]: attribution");
    ctx.check(w.plaza.has_value() == s.find("hasPlaza")->asBool(), "world [" + name + "]: plaza");
    ctx.check(report.negativeAreaFootprints == count("negativeAreaFootprints"),
              "world [" + name + "]: negative-area footprints " + std::to_string(report.negativeAreaFootprints) +
                  " vs JS " + std::to_string(count("negativeAreaFootprints")));
    ctx.check(store->projection() != nullptr && store->projection()->unitMeters() == w.unitMeters,
              "world [" + name + "]: projection built from origin/unitMeters");
  }
  ctx.check(okCases >= 3, "world fixture has valid cases");
  if (!sawRealSample) std::cout << "    note: tools/osm/samples/seongsu.world.json case not present in fixtures\n";
}

DIORAMA_TEST(world_store_typed_conversion_and_warnings) {
  const Value fixture = diorama::test::loadFixture(ctx, "world.json");
  const std::string& sample = fixture.find("cases")->items().at(0).find("input")->asString();
  auto store = diorama::createWorldStore();
  diorama::Result<diorama::WorldLoadReport> r = store->loadJson(sample);
  if (!ctx.check(r.ok(), "sample world loads: " + r.error)) return;

  const diorama::BuildingFootprint* b1 = store->findBuilding("b1");
  ctx.check(b1 != nullptr && b1->footprint.size() == 3 && b1->height == 3 && b1->levels == 4.0 &&
                b1->kind == diorama::BuildingKind::Glass && b1->name == std::string("Tower"),
            "building b1 converted");
  const diorama::Road* r1 = store->findRoad("r1");
  ctx.check(r1 != nullptr && r1->cls == diorama::RoadClass::Arterial && r1->bridge == false && r1->pts.size() == 2,
            "road r1 converted");
  const diorama::WorldData& w = *store->world();
  ctx.check(w.pois.size() == 1 && w.pois[0].cat == diorama::PoiCategory::Cafe && w.pois[0].z == 2, "poi converted");
  ctx.check(w.districts.size() == 1 && w.districts[0].water == false, "district converted");
  ctx.check(r.value->warnings.empty(), "sample world has no warnings");
  ctx.check(diorama::shoelaceArea2(b1->footprint) > 0, "sample footprint has positive shoelace area");

  // Duplicate ids + negative winding + inverted bounds produce warnings but still load.
  Value world = diorama::json::parse(sample).value;
  Value& buildings = *world.find("buildings");
  Value dup = buildings.items()[0];
  Value cw = Value::object({{"id", "cw"},
                            {"footprint", Value::array({Value::array({0, 0}), Value::array({1, 1}), Value::array({1, 0})})},
                            {"height", 1}});
  buildings.push(dup);
  buildings.push(cw);
  world.find("bounds")->set("minX", 100);
  diorama::Result<diorama::WorldLoadReport> warned = store->load(world);
  ctx.check(warned.ok() && warned.value->warnings.size() == 3 && warned.value->negativeAreaFootprints == 1,
            "duplicate id, negative winding and inverted bounds warn (" +
                std::to_string(warned.ok() ? warned.value->warnings.size() : 0) + " warnings)");

  // A failed load keeps the previous world.
  diorama::Result<diorama::WorldLoadReport> bad = store->loadJson(R"({"version":2})");
  ctx.check(!bad.ok() && bad.error == "$.version: expected 1", "invalid world rejected: " + bad.error);
  ctx.check(store->loaded() && store->findBuilding("cw") != nullptr, "previous world kept after failed load");
  diorama::Result<diorama::WorldLoadReport> syntax = store->loadJson("{");
  ctx.check(!syntax.ok() && syntax.error.rfind("$: invalid JSON: ", 0) == 0, "syntax error prefix");
  store->clear();
  ctx.check(!store->loaded() && store->world() == nullptr && store->projection() == nullptr, "clear()");
}
