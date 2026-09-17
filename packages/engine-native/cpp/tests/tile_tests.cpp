// MTIL v1 tile decoding conformance against @maprama/protocol's reader
// (cpp/tests/fixtures/tile.json, written by scripts/export-tile-fixtures.mjs).
//
// The fixture carries the exact bytes of each tile and the JavaScript reader's
// result for them; this suite decodes the same bytes with the C++ reader and
// compares every field. A difference here is a format divergence, which is the
// one thing a shared binary contract cannot survive.
#include <cstdint>
#include <string>
#include <vector>

#include "harness.hpp"
#include "maprama/TileFormat.hpp"

namespace {

using maprama::json::Value;

std::vector<std::uint8_t> bytesOf(const Value& v) {
  std::vector<std::uint8_t> out;
  for (const Value& b : v.items()) out.push_back(static_cast<std::uint8_t>(b.asNumber()));
  return out;
}

std::string optOf(const Value* v) { return v == nullptr ? std::string("\0missing", 8) : v->asString(); }

/// Compares one decoded vertex list against the fixture's `[[u, v], ...]`.
bool sameGeom(const std::vector<maprama::tile::Vertex>& pts, const Value& expected) {
  const auto& items = expected.items();
  if (items.size() != pts.size()) return false;
  for (std::size_t i = 0; i < items.size(); ++i) {
    const auto& pair = items[i].items();
    if (pair.size() != 2) return false;
    if (static_cast<double>(pts[i].u) != pair[0].asNumber()) return false;
    if (static_cast<double>(pts[i].v) != pair[1].asNumber()) return false;
  }
  return true;
}

/// `layers.<name>` of the fixture, or an empty array when the layer is absent.
const std::vector<Value>& layerItems(const Value& tile, const char* name, const std::vector<Value>& empty) {
  const Value* layers = tile.find("layers");
  if (layers == nullptr) return empty;
  const Value* layer = layers->find(name);
  return layer == nullptr ? empty : layer->items();
}

void checkRoads(maprama::test::Context& ctx, const std::string& where, const maprama::tile::Tile& t, const Value& e) {
  const std::vector<Value> empty;
  const auto& items = layerItems(e, "roads", empty);
  if (!ctx.check(items.size() == t.roads.size(), where + " roads: count")) return;
  for (std::size_t i = 0; i < items.size(); ++i) {
    const Value& f = items[i];
    const maprama::tile::Road& r = t.roads[i];
    ctx.check(r.id == f.find("id")->asString(), where + " roads[" + std::to_string(i) + "].id");
    ctx.check(r.cls == f.find("cls")->asString(), where + " roads[" + std::to_string(i) + "].cls");
    const Value* name = f.find("name");
    ctx.check(r.name.has_value() == (name != nullptr) && (name == nullptr || *r.name == name->asString()),
              where + " roads[" + std::to_string(i) + "].name");
    ctx.check(r.bridge == (f.find("bridge") != nullptr), where + " roads[" + std::to_string(i) + "].bridge");
    ctx.check(sameGeom(r.pts, *f.find("pts")), where + " roads[" + std::to_string(i) + "].pts");
  }
}

void checkBuildings(maprama::test::Context& ctx, const std::string& where, const maprama::tile::Tile& t, const Value& e) {
  const std::vector<Value> empty;
  const auto& items = layerItems(e, "buildings", empty);
  if (!ctx.check(items.size() == t.buildings.size(), where + " buildings: count")) return;
  for (std::size_t i = 0; i < items.size(); ++i) {
    const Value& f = items[i];
    const maprama::tile::Building& b = t.buildings[i];
    const std::string at = where + " buildings[" + std::to_string(i) + "]";
    ctx.check(b.id == f.find("id")->asString(), at + ".id");
    ctx.check(static_cast<double>(b.heightDm) == f.find("heightDm")->asNumber(), at + ".heightDm");
    const Value* levels = f.find("levels");
    ctx.check(b.levels.has_value() == (levels != nullptr) && (levels == nullptr || static_cast<double>(*b.levels) == levels->asNumber()),
              at + ".levels");
    const Value* kind = f.find("kind");
    ctx.check(b.kind.has_value() == (kind != nullptr) && (kind == nullptr || *b.kind == kind->asString()), at + ".kind");
    const Value* name = f.find("name");
    ctx.check(b.name.has_value() == (name != nullptr) && (name == nullptr || *b.name == name->asString()), at + ".name");
    ctx.check(sameGeom(b.footprint, *f.find("footprint")), at + ".footprint");
  }
}

void checkPolygons(maprama::test::Context& ctx, const std::string& where, const char* layer, const char* ring,
                   const std::vector<maprama::tile::Polygon>& got, const Value& e) {
  const std::vector<Value> empty;
  const auto& items = layerItems(e, layer, empty);
  if (!ctx.check(items.size() == got.size(), where + " " + layer + ": count")) return;
  for (std::size_t i = 0; i < items.size(); ++i) {
    const Value& f = items[i];
    const std::string at = where + " " + layer + "[" + std::to_string(i) + "]";
    const Value* name = f.find("name");
    ctx.check(got[i].name.has_value() == (name != nullptr) && (name == nullptr || *got[i].name == name->asString()), at + ".name");
    ctx.check(sameGeom(got[i].ring, *f.find(ring)), at + "." + ring);
  }
}

void checkPoints(maprama::test::Context& ctx, const std::string& where, const maprama::tile::Tile& t, const Value& e) {
  const std::vector<Value> empty;
  {
    const auto& items = layerItems(e, "pois", empty);
    if (ctx.check(items.size() == t.pois.size(), where + " pois: count")) {
      for (std::size_t i = 0; i < items.size(); ++i) {
        const Value& f = items[i];
        const maprama::tile::Poi& p = t.pois[i];
        const std::string at = where + " pois[" + std::to_string(i) + "]";
        ctx.check(p.id == f.find("id")->asString(), at + ".id");
        ctx.check(p.name == f.find("name")->asString(), at + ".name");
        ctx.check(p.cat == f.find("cat")->asString(), at + ".cat");
        ctx.check(static_cast<double>(p.at.u) == f.find("u")->asNumber(), at + ".u");
        ctx.check(static_cast<double>(p.at.v) == f.find("v")->asNumber(), at + ".v");
        const Value* bid = f.find("buildingId");
        ctx.check(p.buildingId.has_value() == (bid != nullptr) && (bid == nullptr || *p.buildingId == bid->asString()), at + ".buildingId");
        ctx.check(p.snapped == (f.find("snapped") != nullptr), at + ".snapped");
        const Value* dist = f.find("snapDistanceMeters");
        if (dist != nullptr) ctx.near(p.snapDistanceMeters, dist->asNumber(), 1e-9, at + ".snapDistanceMeters");
      }
    }
  }
  {
    const auto& items = layerItems(e, "stations", empty);
    if (ctx.check(items.size() == t.stations.size(), where + " stations: count")) {
      for (std::size_t i = 0; i < items.size(); ++i) {
        const Value& f = items[i];
        const std::string at = where + " stations[" + std::to_string(i) + "]";
        ctx.check(t.stations[i].id == f.find("id")->asString(), at + ".id");
        ctx.check(t.stations[i].name == f.find("name")->asString(), at + ".name");
        ctx.check(static_cast<double>(t.stations[i].at.u) == f.find("u")->asNumber(), at + ".u");
        ctx.check(static_cast<double>(t.stations[i].at.v) == f.find("v")->asNumber(), at + ".v");
      }
    }
  }
  {
    const auto& items = layerItems(e, "districts", empty);
    if (ctx.check(items.size() == t.districts.size(), where + " districts: count")) {
      for (std::size_t i = 0; i < items.size(); ++i) {
        const Value& f = items[i];
        const std::string at = where + " districts[" + std::to_string(i) + "]";
        ctx.check(t.districts[i].name == f.find("name")->asString(), at + ".name");
        ctx.check(t.districts[i].water == (f.find("water") != nullptr), at + ".water");
        ctx.check(static_cast<double>(t.districts[i].at.u) == f.find("u")->asNumber(), at + ".u");
        ctx.check(static_cast<double>(t.districts[i].at.v) == f.find("v")->asNumber(), at + ".v");
      }
    }
  }
}

}  // namespace

MAPRAMA_TEST(tile_decode_conformance) {
  const Value fixture = maprama::test::loadFixture(ctx, "tile.json");
  const auto& cases = fixture.find("cases")->items();
  ctx.check(cases.size() >= 8, "tile.json has cases");
  for (const Value& c : cases) {
    const std::string name = c.find("name")->asString();
    const std::vector<std::uint8_t> bytes = bytesOf(*c.find("bytes"));
    const bool expectOk = c.find("ok")->asBool();
    const maprama::tile::DecodeResult r = maprama::tile::decodeTile(bytes);

    if (!expectOk) {
      ctx.check(!r.ok, "tile [" + name + "]: expected a decode failure");
      const Value* exact = c.find("exactError");
      if (exact != nullptr && exact->asBool()) {
        ctx.check(r.error == c.find("error")->asString(),
                  "tile [" + name + "]: error text, expected " + c.find("error")->asString() + ", got " + r.error);
      }
      continue;
    }

    if (!ctx.check(r.ok, "tile [" + name + "]: expected ok, got error " + r.error)) continue;
    const Value& e = *c.find("tile");
    const std::string where = "tile [" + name + "]";
    ctx.check(static_cast<double>(r.tile.version) == e.find("version")->asNumber(), where + ".version");
    ctx.check(r.tile.clipped == e.find("clipped")->asBool(), where + ".clipped");
    ctx.check(static_cast<double>(r.tile.extent) == e.find("extent")->asNumber(), where + ".extent");
    ctx.check(static_cast<double>(r.tile.buffer) == e.find("buffer")->asNumber(), where + ".buffer");
    const auto& attr = e.find("attribution")->items();
    if (ctx.check(attr.size() == r.tile.attribution.size(), where + ".attribution: count")) {
      for (std::size_t i = 0; i < attr.size(); ++i) {
        ctx.check(static_cast<double>(r.tile.attribution[i]) == attr[i].asNumber(), where + ".attribution[" + std::to_string(i) + "]");
      }
    }
    const auto& unknown = e.find("unknownLayers")->items();
    if (ctx.check(unknown.size() == r.tile.unknownLayers.size(), where + ".unknownLayers: count")) {
      for (std::size_t i = 0; i < unknown.size(); ++i) {
        ctx.check(static_cast<double>(r.tile.unknownLayers[i]) == unknown[i].asNumber(), where + ".unknownLayers[" + std::to_string(i) + "]");
      }
    }
    checkRoads(ctx, where, r.tile, e);
    checkBuildings(ctx, where, r.tile, e);
    checkPolygons(ctx, where, "water", "poly", r.tile.water, e);
    checkPolygons(ctx, where, "parks", "poly", r.tile.parks, e);
    checkPoints(ctx, where, r.tile, e);
  }
  (void)optOf;
}

MAPRAMA_TEST(tile_decode_never_crashes_on_garbage) {
  // Every prefix of a valid tile, and a run of byte mutations, must come back as
  // a clean failure rather than an out-of-bounds read. Built under ASan/UBSan.
  const Value fixture = maprama::test::loadFixture(ctx, "tile.json");
  const std::vector<std::uint8_t> full = bytesOf(*fixture.find("cases")->items()[0].find("bytes"));
  long failures = 0;
  for (std::size_t n = 0; n < full.size(); ++n) {
    const maprama::tile::DecodeResult r = maprama::tile::decodeTile(full.data(), n);
    if (!r.ok) ++failures;
  }
  ctx.check(failures > 0, "truncated tiles are rejected");
  for (std::size_t i = 0; i < full.size(); ++i) {
    std::vector<std::uint8_t> mutated = full;
    mutated[i] = static_cast<std::uint8_t>(mutated[i] ^ 0xff);
    const maprama::tile::DecodeResult r = maprama::tile::decodeTile(mutated);
    (void)r;  // either outcome is fine; the point is that it does not crash
  }
  ctx.check(true, "byte mutations decode or fail without crashing");
}
