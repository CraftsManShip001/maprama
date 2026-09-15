// M2c custom building layer: mesh generation (roofs, facades, details, outlines, captured flag) on the
// Seongsu sample, the local-units transform and MapLibre light / depth helpers, and the session wiring
// through the fake MapAdapter (map_harness.hpp). Emitted envelopes go to --emit (verify-emitted-events).
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "maprama/BuildingMesh.hpp"
#include "maprama/MapLook.hpp"
#include "maprama/ThemeResolver.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/WorldStyle.hpp"
#include "harness.hpp"
#include "map_harness.hpp"

namespace {

using maprama::json::Value;
using namespace maprama::test::maptest;
using maprama::BuildingLayerData;
using maprama::BuildingMeshInfo;
using maprama::BuildingOverride;
using maprama::RoofShape;

/// The example app's SAMPLE_BUILDING (a 4-vertex rectangle, 5.75 units tall, office).
constexpr const char* kSample = "w407169878";
constexpr double kPi = 3.14159265358979323846;

struct World {
  std::unique_ptr<maprama::WorldStore> store = maprama::createWorldStore();
  std::vector<maprama::RenderedBuilding> rendered;
  const maprama::WorldData& data() const { return *store->world(); }
  const maprama::Projection& projection() const { return *store->projection(); }

  std::size_t renderedIndexOf(const std::string& id) const {
    for (std::size_t i = 0; i < rendered.size(); ++i) {
      if (data().buildings[rendered[i].worldIndex].id == id) return i;
    }
    return rendered.size();
  }

  BuildingLayerData build(const Value& themeSpec, const std::map<std::string, BuildingOverride>& overrides = {}) const {
    const maprama::ResolvedTheme theme = maprama::ThemeResolver::builtIn().resolve(themeSpec);
    return maprama::buildBuildingLayer(data(), projection(), rendered, theme, maprama::mapLookFor(theme), overrides);
  }
};

bool loadWorld(maprama::test::Context& ctx, World& w) {
  const auto loaded = w.store->load(seongsuValue(ctx));
  if (!ctx.check(loaded.ok(), "Seongsu sample loads")) return false;
  w.rendered = maprama::renderedBuildings(w.data());
  return true;
}

const BuildingMeshInfo* infoFor(const BuildingLayerData& d, std::size_t rendered) {
  for (const BuildingMeshInfo& b : d.buildings) {
    if (b.rendered == rendered) return &b;
  }
  return nullptr;
}

/// Local units -> world point (inverse of the mesh placement).
maprama::WorldPoint toWorld(const BuildingLayerData& d, const maprama::Projection& p, const float* pos) {
  const maprama::LngLat ll = maprama::mercatorToLngLat(d.originX + pos[0] / d.unitsPerMercator, d.originY + pos[1] / d.unitsPerMercator);
  return p.toWorld(ll);
}

double maxZ(const BuildingLayerData& d, const BuildingMeshInfo& b) {
  double z = -1e9;
  for (std::uint32_t i = 0; i < b.vertexCount; ++i) z = std::max(z, static_cast<double>(d.vertices[b.firstVertex + i].position[2]));
  return z;
}

/// Edge lengths of the sample's (rectangular) footprint.
std::pair<double, double> rectSides(const std::vector<maprama::Vec2>& fp) {
  const double a = std::hypot(fp[1][0] - fp[0][0], fp[1][1] - fp[0][1]);
  const double b = std::hypot(fp[3][0] - fp[0][0], fp[3][1] - fp[0][1]);
  return {a, b};
}

bool indicesValid(const BuildingLayerData& d) {
  if (d.indices.size() % 3 != 0 || d.lineIndices.size() % 6 != 0) return false;
  for (std::uint32_t i : d.indices) {
    if (i >= d.vertices.size()) return false;
  }
  for (std::uint32_t i : d.lineIndices) {
    if (i >= d.lineVertices.size()) return false;
  }
  return true;
}

std::uint32_t rgbOf(const std::uint8_t* c) { return (std::uint32_t{c[0]} << 16) | (std::uint32_t{c[1]} << 8) | c[2]; }

Value buildingStyle(const std::string& id, Value style) {
  return Value::object({{"type", "setBuildingStyle"}, {"buildingId", id}, {"style", std::move(style)}});
}

}  // namespace

MAPRAMA_TEST(m2c_building_layer_geometry) {
  World w;
  if (!loadWorld(ctx, w)) return;
  const auto t0 = std::chrono::steady_clock::now();
  const BuildingLayerData d = w.build(Value::object());
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  std::printf("    realistic: %zu buildings, %zu vertices, %zu triangles, %zu line vertices (%.1f ms, sanitizer build)\n",
              d.buildings.size(), d.vertices.size(), d.indices.size() / 3, d.lineVertices.size(), ms);

  ctx.check(d.buildings.size() == w.rendered.size(), "one mesh entry per rendered building");
  ctx.check(!d.vertices.empty() && indicesValid(d), "indices reference existing vertices");
  ctx.check(d.sameContent(w.build(Value::object())), "generation is deterministic");
  ctx.check(d.lineVertices.empty() && d.lineWidth == 0.f, "realistic: no outlines");
  ctx.check(d.windowLights == 0.f, "day: window lights off");
  ctx.near(d.unitsPerMercator, 2 * kPi * 6378137.0 * std::cos(w.data().origin.lat * kPi / 180), 1e-6, "local units = mercator meters at the origin");

  bool allFacades = true, noDetails = true, heightsOk = true, nearFootprint = true;
  std::size_t contiguous = 0;
  for (std::size_t i = 0; i < d.buildings.size(); ++i) {
    const BuildingMeshInfo& b = d.buildings[i];
    allFacades = allFacades && b.facade;
    noDetails = noDetails && !b.details;
    if (i > 0) contiguous += d.buildings[i - 1].firstVertex + d.buildings[i - 1].vertexCount == b.firstVertex ? 1 : 0;
    const auto& bf = w.data().buildings[w.rendered[b.rendered].worldIndex];
    double cx = 0, cz = 0, radius = 0;
    for (const auto& p : bf.footprint) {
      cx += p[0] / bf.footprint.size();
      cz += p[1] / bf.footprint.size();
    }
    for (const auto& p : bf.footprint) radius = std::max(radius, std::hypot(p[0] - cx, p[1] - cz));
    for (std::uint32_t k = 0; k < b.vertexCount; ++k) {
      const auto& v = d.vertices[b.firstVertex + k];
      // Roof furniture (parapet 0.2, HVAC up to 0.55 units) rises above engine-web's roof `top`.
      heightsOk = heightsOk && v.position[2] >= -1e-3 && v.position[2] <= (b.roofTop + 0.6) * w.data().unitMeters;
      const maprama::WorldPoint wp = toWorld(d, w.projection(), v.position);
      nearFootprint = nearFootprint && std::hypot(wp.x - cx, wp.z - cz) <= radius + 0.25;
    }
  }
  ctx.check(allFacades, "realistic: every building has facade walls");
  ctx.check(noDetails, "realistic: no facade details by default");
  ctx.check(contiguous + 1 == d.buildings.size(), "building vertex ranges are contiguous");
  ctx.check(heightsOk, "every vertex between the ground and its roof top (+ roof furniture)");
  ctx.check(nearFootprint, "every vertex within 0.25 units of its footprint");

  // The sample's facade quads sit kFacadeOut outside its footprint corners, and the local transform
  // round-trips through web mercator and the world projection.
  const std::size_t si = w.renderedIndexOf(kSample);
  const BuildingMeshInfo* sample = infoFor(d, si);
  if (ctx.check(sample != nullptr, "sample building meshed")) {
    const auto& fp = w.data().buildings[w.rendered[si].worldIndex].footprint;
    double best = 1e9;
    const maprama::WorldPoint first = toWorld(d, w.projection(), d.vertices[sample->firstVertex].position);
    for (const auto& p : fp) best = std::min(best, std::hypot(first.x - p[0], first.z - p[1]));
    ctx.near(best, 0.006 * std::sqrt(2.0), 2e-3, "first facade vertex = footprint corner offset by 0.006 units (mitered)");
    ctx.check(d.vertices[sample->firstVertex].normal[3] == static_cast<std::int8_t>(maprama::FacadePattern::Ribbon),
              "office in the real set: ribbon windows");
    ctx.check(sample->rectangular && sample->roof == RoofShape::Flat, "sample: rectangle with the default flat roof");
    // Facades 16 + storefront 16 + gravel prism 20 + parapet band 64 + HVAC boxes (24 each).
    ctx.check(sample->vertexCount >= 116 && (sample->vertexCount - 116) % 24 == 0,
              "realistic flat roof: facades, storefront, gravel, parapet, HVAC (" + std::to_string(sample->vertexCount) + ")");
  }
}

MAPRAMA_TEST(m2c_roofs_gable_dome) {
  World w;
  if (!loadWorld(ctx, w)) return;
  const std::size_t si = w.renderedIndexOf(kSample);
  const auto& fp = w.data().buildings[w.rendered[si].worldIndex].footprint;
  const auto [a, b] = rectSides(fp);
  const double H = 5.75, unit = w.data().unitMeters;

  std::map<std::string, BuildingOverride> gable;
  gable[kSample].roof = RoofShape::Gable;
  const BuildingLayerData g = w.build(Value::object(), gable);
  const BuildingMeshInfo* gi = infoFor(g, si);
  const double ridge = H + (std::min(a, b) + 0.3) * 0.42;
  if (ctx.check(gi != nullptr && gi->roof == RoofShape::Gable, "gable drawn on the rectangular sample")) {
    ctx.near(gi->roofTop, ridge, 1e-9, "gable ridge = H + (short side + 0.3) · 0.42");
    ctx.near(maxZ(g, *gi), ridge * unit, 1e-3, "highest vertex = ridge (meters)");
    ctx.check(gi->vertexCount == 32 + 14, "gable: facades 16 + storefront 16 + 2 slopes + 2 gable ends (" + std::to_string(gi->vertexCount) + ")");
  }

  std::map<std::string, BuildingOverride> dome;
  dome[kSample].roof = RoofShape::Dome;
  const BuildingLayerData dd = w.build(Value::object(), dome);
  const BuildingMeshInfo* di = infoFor(dd, si);
  const double apex = H + 0.3 + std::min(a, b) * 0.42;
  if (ctx.check(di != nullptr && di->roof == RoofShape::Dome, "dome drawn on the rectangular sample")) {
    ctx.near(di->roofTop, apex, 1e-9, "dome apex = H + 0.3 + short side · 0.42");
    ctx.near(maxZ(dd, *di), apex * unit, 1e-3, "highest vertex = dome apex (meters)");
    ctx.check(di->vertexCount == 32 + 75 + 275, "dome: drum 75 + hemisphere 275 vertices (" + std::to_string(di->vertexCount) + ")");
  }

  // engine-web's rules: no gable / dome on polygons, `flatRoofs` presets only honour an explicit roof.
  std::size_t polygon = w.rendered.size();
  for (std::size_t i = 0; i < w.rendered.size(); ++i) {
    if (!infoFor(g, i)->rectangular) {
      polygon = i;
      break;
    }
  }
  if (ctx.check(polygon < w.rendered.size(), "the sample has non-rectangular footprints")) {
    std::map<std::string, BuildingOverride> pg;
    pg[w.data().buildings[w.rendered[polygon].worldIndex].id].roof = RoofShape::Gable;
    ctx.check(infoFor(w.build(Value::object(), pg), polygon)->roof == RoofShape::Flat, "gable on a polygon falls back to flat");
  }
  const BuildingLayerData urban = w.build(Value::object({{"base", "urban"}}), gable);
  ctx.check(infoFor(urban, si)->roof == RoofShape::Gable, "flatRoofs preset keeps an explicit roof");
  ctx.near(infoFor(urban, si)->wallTop, H * 1.6, 1e-9, "urban heightScale 1.6 raises the walls");
  const BuildingLayerData realisticDefault = w.build(Value::object());
  std::size_t gables = 0;
  for (const BuildingMeshInfo& bi : realisticDefault.buildings) gables += bi.roof == RoofShape::Gable ? 1 : 0;
  ctx.check(gables == 0, "data worlds: flat roofs unless styled (engine-web)");
}

MAPRAMA_TEST(m2c_facades_outlines_by_theme) {
  World w;
  if (!loadWorld(ctx, w)) return;
  const std::size_t si = w.renderedIndexOf(kSample);

  const BuildingLayerData toy = w.build(Value::object({{"base", "toy"}}));
  const BuildingMeshInfo* ti = infoFor(toy, si);
  ctx.check(toy.lineWidth == 2.f && !toy.lineVertices.empty() && indicesValid(toy), "toy: ink outlines");
  if (ctx.check(ti != nullptr, "toy sample")) {
    ctx.check(ti->vertexCount == 16 + 20, "toy: facade quads + overhanging cap slab (" + std::to_string(ti->vertexCount) + ")");
    // Cap slab top / bottom rings 8 + ground ring 4 + corners 4 segments, 4 vertices each.
    ctx.check(ti->lineVertexCount == 16 * 4, "toy: 16 outline segments (" + std::to_string(ti->lineVertexCount) + ")");
    ctx.check(toy.vertices[ti->firstVertex].normal[3] == static_cast<std::int8_t>(maprama::FacadePattern::Punched), "toy windows: punched");
    const std::uint32_t ink = maprama::applyTint(0x2A2540, maprama::mapLookFor(maprama::ThemeResolver::builtIn().resolve(Value::object({{"base", "toy"}}))).tint);
    ctx.check(rgbOf(toy.lineVertices[ti->firstLineVertex].color) == ink, "outline colour = INK");
  }

  const BuildingLayerData minimal = w.build(Value::object({{"base", "minimal"}}));
  ctx.check(infoFor(minimal, si)->vertexCount == 20 && !infoFor(minimal, si)->facade && minimal.lineVertices.empty(),
            "minimal: no facades, cap slab only, no outlines");

  std::map<std::string, BuildingOverride> noFacade;
  noFacade[kSample].facade = false;
  const BuildingLayerData noFacadeLayer = w.build(Value::object(), noFacade);
  const BuildingMeshInfo* nf = infoFor(noFacadeLayer, si);
  ctx.check(!nf->facade && nf->vertexCount >= 84 && (nf->vertexCount - 84) % 24 == 0,
            "facade: false drops the facade walls and the storefront (" + std::to_string(nf->vertexCount) + ")");

  const BuildingLayerData urban = w.build(Value::object({{"base", "urban"}}));
  const BuildingLayerData urbanPlain = w.build(Value::object({{"base", "urban"}, {"buildings", Value::object({{"details", false}})}}));
  ctx.check(infoFor(urban, si)->details && !infoFor(urbanPlain, si)->details, "urban: facade details by default");
  ctx.check(urban.vertices.size() > urbanPlain.vertices.size() + 1000, "details add slab edges / fins / balconies");
  ctx.check(indicesValid(urban), "urban indices valid");

  const BuildingLayerData night = w.build(Value::object({{"timeOfDay", "night"}}));
  ctx.check(night.windowLights > 0.f, "night: window lights on");
  ctx.check(night.vertices.size() == w.build(Value::object()).vertices.size() && !night.sameContent(w.build(Value::object())),
            "night: same geometry, tinted colours");
}

MAPRAMA_TEST(m2c_captured_flag) {
  World w;
  if (!loadWorld(ctx, w)) return;
  const std::size_t si = w.renderedIndexOf(kSample);
  std::map<std::string, BuildingOverride> cap;
  cap[kSample].captured = true;
  const BuildingLayerData plain = w.build(Value::object());
  const BuildingLayerData d = w.build(Value::object(), cap);
  const BuildingMeshInfo* p = infoFor(plain, si);
  const BuildingMeshInfo* c = infoFor(d, si);
  ctx.check(c->flag && !p->flag, "captured building carries the flag");
  ctx.check(c->vertexCount == p->vertexCount + 21 + 24, "flag = 6-sided pole (21) + flag box (24)");
  ctx.near(maxZ(d, *c), (c->roofTop + 2.4) * w.data().unitMeters, 1e-3, "pole top 2.4 units above the roof");
  const maprama::MapLook look = maprama::mapLookFor(maprama::ThemeResolver::builtIn().resolve(Value::object()));
  bool accent = false;
  for (std::uint32_t k = 0; k < c->vertexCount; ++k) accent = accent || rgbOf(d.vertices[c->firstVertex + k].color) == look.capturedRing;
  ctx.check(accent, "flag in the accent colour");
  // Facade walls take the captured colour (theme colour + 35 % glow), like the extrusion.
  BuildingOverride o;
  o.captured = true;
  const maprama::RenderedBuilding& rb = w.rendered[si];
  const std::uint32_t wall = rgbOf(d.vertices[c->firstVertex].color);
  const std::uint32_t themed = rgbOf(plain.vertices[p->firstVertex].color);
  ctx.check(wall != themed && maprama::buildingOverrideColor(look, rb.ci, rb.index, o) != maprama::buildingThemeColor(look, rb.ci, rb.index),
            "captured facade colour differs from the theme colour");
}

MAPRAMA_TEST(m2c_matrix_light_depth) {
  World w;
  if (!loadWorld(ctx, w)) return;
  const BuildingLayerData d = w.build(Value::object());
  // With an identity projection the matrix maps local units to MapLibre world pixels.
  std::array<double, 16> identity{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  const double zoom = 17.25;
  const std::array<float, 16> m = maprama::buildingLayerMatrix(identity, zoom, d);
  const auto& v = d.vertices[d.buildings[0].firstVertex];
  const double px = m[0] * v.position[0] + m[4] * v.position[1] + m[8] * v.position[2] + m[12];
  const double py = m[1] * v.position[0] + m[5] * v.position[1] + m[9] * v.position[2] + m[13];
  const double ws = 512.0 * std::pow(2.0, zoom);
  const maprama::LngLat ll = maprama::mercatorToLngLat(px / ws, py / ws);
  const maprama::WorldPoint expected = toWorld(d, w.projection(), v.position);
  const maprama::WorldPoint got = w.projection().toWorld(ll);
  // Float matrix at zoom 17: world pixels ~ 3e7 lose ~2 px of float precision — only the projection
  // matrix product (clip space) needs to be precise, so compare loosely here.
  ctx.check(std::hypot(got.x - expected.x, got.z - expected.z) < 0.5, "matrix maps local units to world pixels");
  ctx.near(m[10], 1.0, 1e-9, "z stays in meters");

  const maprama::BuildingLayerLight l = maprama::buildingLayerLight(maprama::MapLight{1.15, 210, 30, 0xFFFFFF, 0.5});
  ctx.near(l.position[0], 1.15 * std::cos(300 * kPi / 180) * std::sin(30 * kPi / 180), 1e-6, "light x (Position::calculateCartesian)");
  ctx.near(l.position[1], 1.15 * std::sin(300 * kPi / 180) * std::sin(30 * kPi / 180), 1e-6, "light y");
  ctx.near(l.position[2], 1.15 * std::cos(30 * kPi / 180), 1e-6, "light z");

  const double eps = 1.0 / 65536.0;
  const double R = 1 - (14 + 2) * 3 * eps;  // 14 layer groups
  ctx.near(maprama::glExtrusionDepthRange(R + (1 + 1) * 3 * eps, 1), R, 1e-12, "GL 3D depth range from the sublayer depth");
}

MAPRAMA_TEST(m2c_session_sends_building_layer) {
  Harness h;
  h.send(initMsg(dataWorld(ctx)));
  const std::size_t styles = h.adapter->styles.size();
  ctx.check(!h.adapter->buildingLayers.empty() && h.adapter->buildingLayers.back() != nullptr, "init sends the building layer");
  if (h.adapter->buildingLayers.empty()) return;
  const auto first = h.adapter->buildingLayers.back();
  const std::vector<maprama::RenderedBuilding> rendered = maprama::renderedBuildings(*h.engine->worldStore().world());
  std::size_t si = 0;
  while (si < rendered.size() && h.engine->worldStore().world()->buildings[rendered[si].worldIndex].id != kSample) ++si;

  const std::size_t paints = h.adapter->paints.size();
  h.send(buildingStyle(kSample, Value::object({{"roof", "gable"}})));
  const auto gable = h.adapter->buildingLayers.back();
  ctx.check(gable != first && gable->version > first->version, "roof override sends a new layer version");
  ctx.check(infoFor(*gable, si)->roof == RoofShape::Gable, "session layer has the gable");
  ctx.check(h.adapter->styles.size() == styles && h.adapter->paints.size() == paints, "roof changes no style / paint");
  ctx.check(h.sink->countLogs("setBuildingStyle.roof", maprama::LogLevel::Warn) == 0, "roof not warned");

  h.send(buildingStyle(kSample, Value::object({{"roof", "gable"}})));
  ctx.check(h.adapter->buildingLayers.back() == gable, "unchanged content is not re-sent");

  h.send(buildingStyle(kSample, Value::object({{"roof", "dome"}, {"facade", false}, {"decorations", Value::array({"antenna"})}})));
  const auto dome = h.adapter->buildingLayers.back();
  ctx.check(infoFor(*dome, si)->roof == RoofShape::Dome && !infoFor(*dome, si)->facade, "dome + facade off applied");
  ctx.check(h.sink->countLogs("setBuildingStyle.decorations", maprama::LogLevel::Warn) == 1, "decorations still warned once");

  h.send(Value::object({{"type", "setTheme"}, {"theme", Value::object({{"base", "toy"}})}}));
  ctx.check(h.adapter->buildingLayers.back()->lineWidth == 2.f, "setTheme toy: outlines in the new layer");
  ctx.check(h.sink->countLogs("theme option", maprama::LogLevel::Warn) == 0, "toy options all rendered (no warning)");

  h.send(buildingStyle(kSample, Value(nullptr)));
  ctx.check(infoFor(*h.adapter->buildingLayers.back(), si)->roof == RoofShape::Flat, "null clears the roof");

  // A newly attached adapter gets the current layer right after the style.
  auto other = std::make_shared<FakeAdapter>();
  h.engine->attachMapAdapter(other);
  ctx.check(other->styles.size() == 1 && other->buildingLayers.size() == 1 &&
                other->buildingLayers.back() == h.adapter->buildingLayers.back(),
            "attach: style then the current building layer");
  appendEmitted(ctx, *h.sink);
}
