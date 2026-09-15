// Drop collection judgement: conformance with engine-web's drops.ts `DropCollector` (drops.json) and
// the collectId rules of its unit tests.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <set>
#include <string>
#include <vector>

#include "game_fixtures.hpp"
#include "maprama/DropLogic.hpp"

namespace {

using maprama::json::Value;
using namespace maprama::test::game;

maprama::DropSpec dropSpec(const Value& d) {
  maprama::DropSpec s;
  s.id = str(d, "id");
  s.type = *maprama::parseEnum<maprama::DropType>(str(d, "type"));
  const Value& c = *d.find("coordinate");
  s.coordinate = maprama::LngLat{num(c, "lng"), num(c, "lat")};
  if (has(d, "rarity")) s.rarity = maprama::parseEnum<maprama::Rarity>(str(d, "rarity"));
  if (has(d, "value")) s.value = num(d, "value");
  if (has(d, "model")) s.model = maprama::ModelSource{str(*d.find("model"), "uri")};
  return s;
}

maprama::DropCollector::IdGenerator generator(const Value& ids) {
  if (str(ids, "kind") == "counter") {
    const std::string prefix = str(ids, "prefix");
    auto n = std::make_shared<long>(0);
    return [prefix, n] { return prefix + std::to_string(++*n); };
  }
  std::vector<std::string> values;
  for (const Value& v : ids.find("values")->items()) values.push_back(v.asString());
  auto n = std::make_shared<std::size_t>(0);
  return [values, n] { return values[std::min((*n)++, values.size() - 1)]; };
}

std::vector<maprama::CharacterPosition> collectors(const Value& list) {
  std::vector<maprama::CharacterPosition> out;
  for (const Value& c : list.items()) out.push_back(maprama::CharacterPosition{str(c, "id"), num(c, "x"), num(c, "z"), c.find("isPlayer")->asBool()});
  return out;
}

bool sameIds(const std::vector<maprama::DropState>& actual, const Value* expected) {
  if (expected == nullptr || actual.size() != expected->items().size()) return false;
  for (std::size_t i = 0; i < actual.size(); ++i) {
    if (actual[i].spec.id != expected->items()[i].asString()) return false;
  }
  return true;
}

std::string idList(const std::vector<maprama::DropState>& drops) {
  std::string s;
  for (const auto& d : drops) s += d.spec.id + ",";
  return s;
}

}  // namespace

MAPRAMA_TEST(game_drop_collection_matches_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "drops.json");
  ctx.check(num(fixture, "MAX_ISSUED_COLLECT_IDS") == static_cast<double>(maprama::kMaxIssuedCollectIds), "MAX_ISSUED_COLLECT_IDS");
  FloatStats stats(ctx);
  long scenarios = 0, ops = 0, collections = 0, errors = 0;
  for (const Value& sc : fixture.find("scenarios")->items()) {
    const std::string name = str(sc, "name");
    const Value& origin = *sc.find("origin");
    const auto proj = *maprama::Projection::create(maprama::ProjectionOptions{maprama::LngLat{num(origin, "lng"), num(origin, "lat")}, num(sc, "unitMeters")}).value;
    maprama::DropCollector collector(generator(*sc.find("ids")));
    const Value& opList = *sc.find("ops");
    const Value& results = *sc.find("results");
    const auto t0 = std::chrono::steady_clock::now();
    for (std::size_t i = 0; i < opList.items().size(); ++i) {
      const Value& op = opList.items()[i];
      const Value& res = results.items()[i];
      const std::string kind = str(op, "op");
      const std::string what = name + " op " + std::to_string(i) + " (" + kind + ")";
      if (kind == "setLayer") {
        std::vector<maprama::DropInput> inputs;
        const Value& world = *op.find("world");
        std::size_t k = 0;
        for (const Value& d : op.find("drops")->items()) {
          maprama::DropSpec spec = dropSpec(d);
          const maprama::WorldPoint own = proj.toWorld(spec.coordinate);
          stats.point(own, world.items()[k], what + " projected drop");
          inputs.push_back(maprama::DropInput{std::move(spec), world.items()[k].items()[0].asNumber(), world.items()[k].items()[1].asNumber()});
          ++k;
        }
        std::optional<std::vector<std::string>> ids;
        if (has(op, "collectorIds")) {
          ids.emplace();
          for (const Value& v : op.find("collectorIds")->items()) ids->push_back(v.asString());
        }
        const maprama::LayerDiff diff = collector.setLayer(str(op, "layerId"), inputs, num(op, "collectRadiusMeters") / proj.unitMeters(), ids);
        const Value& e = *res.find("diff");
        ctx.check(sameIds(diff.added, e.find("added")), what + ": added " + idList(diff.added));
        ctx.check(sameIds(diff.removed, e.find("removed")), what + ": removed " + idList(diff.removed));
        ctx.check(sameIds(diff.moved, e.find("moved")), what + ": moved " + idList(diff.moved));
      } else if (kind == "removeLayer") {
        ctx.check(sameIds(collector.removeLayer(str(op, "layerId")), res.find("removed")), what + ": removed drops");
      } else {
        const maprama::DropCheckResult r = collector.check(collectors(*op.find("collectors")), proj);
        if (has(res, "error")) {
          ++errors;
          ctx.check(r.error.has_value() && *r.error == str(res, "error"), what + ": error expected " + str(res, "error"));
        } else {
          ctx.check(!r.error.has_value(), what + ": no error");
          const Value& events = *res.find("events");
          if (ctx.check(r.collected.size() == events.items().size(), what + ": collection count expected " + std::to_string(events.items().size()) +
                                                                         ", got " + std::to_string(r.collected.size()))) {
            for (std::size_t k = 0; k < r.collected.size(); ++k) {
              const Value& e = events.items()[k];
              const maprama::DropCollection& a = r.collected[k];
              ctx.check(a.layerId == str(e, "layerId") && a.dropId == str(e, "dropId") && a.characterId == str(e, "characterId") &&
                            a.collectId == str(e, "collectId") && a.drop.collected && a.drop.spec.id == a.dropId,
                        what + ": collection " + std::to_string(k) + " expected " + str(e, "dropId") + "/" + str(e, "characterId") + "/" +
                            str(e, "collectId") + ", got " + a.dropId + "/" + a.characterId + "/" + a.collectId);
              stats.lngLat(a.coordinate, *e.find("coordinate"), what + " coordinate");
              ++collections;
            }
          }
        }
      }
      // Per-layer state and history after the op (when the fixture recorded them).
      const Value* statePtr = res.find("state");
      if (statePtr == nullptr) {
        ++ops;
        continue;
      }
      const Value& state = *statePtr;
      const std::vector<std::string> layerIds = collector.layerIds();
      const Value& layers = *state.find("layers");
      if (ctx.check(layerIds.size() == layers.items().size(), what + ": layer count")) {
        for (std::size_t l = 0; l < layerIds.size(); ++l) {
          const Value& el = layers.items()[l];
          ctx.check(layerIds[l] == str(el, "id"), what + ": layer order");
          const std::vector<maprama::DropState> ds = collector.drops(layerIds[l]);
          const Value& edrops = *el.find("drops");
          if (!ctx.check(ds.size() == edrops.items().size(), what + ": drop count in " + layerIds[l])) continue;
          for (std::size_t k = 0; k < ds.size(); ++k) {
            const Value& ed = edrops.items()[k];
            ctx.check(ds[k].spec.id == str(ed, "id") && ds[k].collected == ed.find("collected")->asBool() &&
                          maprama::enumName(ds[k].spec.type) == str(ed, "type") && ds[k].layerId == layerIds[l],
                      what + ": drop state " + ds[k].spec.id);
            stats.number(ds[k].x, ed.find("x"), what + " drop.x");
            stats.number(ds[k].z, ed.find("z"), what + " drop.z");
          }
        }
      }
      std::vector<std::string> expectedHistory;
      for (const Value& h : state.find("history")->items()) expectedHistory.push_back(h.asString());
      std::sort(expectedHistory.begin(), expectedHistory.end());  // JS sorts UTF-16 code units; compare as byte-sorted sets
      const std::vector<std::string> actualHistory(collector.history().begin(), collector.history().end());
      ctx.check(actualHistory == expectedHistory, what + ": history (" + std::to_string(actualHistory.size()) + " keys, expected " +
                                                      std::to_string(expectedHistory.size()) + ")");
      ++ops;
    }
    char line[256];
    std::snprintf(line, sizeof line, "    %s: %zu ops, native %.2f ms, engine-web %.2f ms\n", name.c_str(), opList.items().size(), msSince(t0),
                  num(sc, "webMs"));
    std::cout << line;
    ++scenarios;
  }
  ctx.check(scenarios >= 8 && collections > 50 && errors > 0, "drop scenarios with collections and a generator error");
  stats.report("drops: " + std::to_string(scenarios) + " scenarios, " + std::to_string(ops) + " ops, " + std::to_string(collections) + " collections");
}

MAPRAMA_TEST(game_drop_collect_ids) {
  const auto proj = *maprama::Projection::create(maprama::ProjectionOptions{maprama::LngLat{127, 37.5}, 8.0}).value;
  const std::vector<maprama::CharacterPosition> me{{"me", 0, 0, true}};
  const auto coin = [](const std::string& id) {
    maprama::DropSpec s;
    s.id = id;
    return maprama::DropInput{s, 0, 0};
  };
  // engine-web drops.test.ts: remembers only the last MAX_ISSUED_COLLECT_IDS collectIds.
  long n = 0;
  bool repeatFirst = false;
  maprama::DropCollector c([&] { return repeatFirst ? std::string("id-0") : "id-" + std::to_string(n++); });
  const std::size_t total = maprama::kMaxIssuedCollectIds + 1;
  std::vector<maprama::DropInput> many;
  for (std::size_t i = 0; i < total; ++i) many.push_back(coin("d" + std::to_string(i)));
  c.setLayer("many", many, 1, std::nullopt);
  const maprama::DropCheckResult first = c.check(me, proj);
  std::set<std::string> unique;
  for (const auto& r : first.collected) unique.insert(r.collectId);
  ctx.check(first.collected.size() == total && unique.size() == total, "10001 unique collectIds");
  repeatFirst = true;
  c.setLayer("one", {coin("x")}, 1, std::nullopt);
  const maprama::DropCheckResult again = c.check(me, proj);
  ctx.check(again.collected.size() == 1 && again.collected[0].collectId == "id-0", "the evicted oldest id may be issued again");
  maprama::DropCollector stuck([] { return std::string("dup"); });
  stuck.setLayer("l", {coin("p"), coin("q")}, 1, std::nullopt);
  const maprama::DropCheckResult dup = stuck.check(me, proj);
  ctx.check(dup.error.has_value() && dup.collected.empty(), "a generator stuck on one id fails");

  // Default generator: RFC 4122 v4 UUIDs.
  std::set<std::string> ids;
  bool formatOk = true;
  for (int i = 0; i < 200; ++i) {
    const std::string id = maprama::randomCollectId();
    ids.insert(id);
    formatOk = formatOk && id.size() == 36 && id[8] == '-' && id[13] == '-' && id[18] == '-' && id[23] == '-' && id[14] == '4' &&
               std::string("89ab").find(id[19]) != std::string::npos &&
               std::all_of(id.begin(), id.end(), [](char ch) { return ch == '-' || (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'); });
  }
  ctx.check(formatOk && ids.size() == 200, "randomCollectId: unique v4 UUIDs");

  // `setDropLayer` conversion (engine-web applyDropLayer): projected drops, radius meters / unitMeters.
  maprama::DropCollector byLayer;
  maprama::DropLayer layer;
  layer.layerId = "coins";
  maprama::DropSpec spec;
  spec.id = "a";
  spec.coordinate = proj.toLngLat({3, 0});
  layer.drops.push_back(spec);
  layer.collectRadiusMeters = 16;
  byLayer.setLayer(layer, proj);
  ctx.check(byLayer.check({{"me", 0.9, 0, true}}, proj).collected.empty(), "outside 2 units");
  const maprama::DropCheckResult hit = byLayer.check({{"me", 1.01, 0, true}}, proj);
  ctx.check(hit.collected.size() == 1 && hit.collected[0].collectId.size() == 36, "inside 2 units, UUID collectId");
}
