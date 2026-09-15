// M4 zoom-out game view: conformance of `zoomOutTarget` / `ZoomOutController` with engine-web's
// `render/zoom-out.ts` (zoom-out.json, driven through a real ZoomOutController with recording targets).
#include <cmath>
#include <string>

#include "harness.hpp"
#include "game_fixtures.hpp"
#include "map_harness.hpp"
#include "maprama/WorldStyle.hpp"
#include "maprama/ZoomOut.hpp"

namespace {

using maprama::ZoomOutBehavior;
using maprama::ZoomOutController;
using maprama::json::Value;
using maprama::test::game::num;
using maprama::test::game::str;

ZoomOutBehavior behaviorOf(const std::string& name) {
  return maprama::parseEnum<ZoomOutBehavior>(name).value_or(ZoomOutBehavior::None);
}

}  // namespace

MAPRAMA_TEST(m4_zoom_out_target_matches_engine_web) {
  const Value fx = maprama::test::loadFixture(ctx, "zoom-out.json");
  if (!ctx.check(fx.isObject(), "zoom-out.json loads")) return;
  ctx.check(num(*fx.find("constants"), "near") == maprama::kZoomOutNearUnits, "D1 = 55 world units");
  ctx.check(num(*fx.find("constants"), "far") == maprama::kZoomOutFarUnits, "D2 = 110 world units");
  int n = 0;
  for (const Value& c : fx.find("targets")->items()) {
    const double got = maprama::zoomOutTarget(behaviorOf(str(c, "behavior")), num(c, "distance"));
    ctx.near(got, num(c, "t"), 1e-12, "zoomOutTarget(" + str(c, "behavior") + ", " + std::to_string(num(c, "distance")) + ")");
    ++n;
  }
  ctx.check(n == 51, "3 behaviours x 17 distances");
}

MAPRAMA_TEST(m4_zoom_out_controller_matches_engine_web) {
  const Value fx = maprama::test::loadFixture(ctx, "zoom-out.json");
  if (!ctx.check(fx.isObject(), "zoom-out.json loads")) return;
  for (const Value& trace : fx.find("traces")->items()) {
    const std::string name = str(trace, "name");
    const bool reduceMotion = trace.find("reduceMotion")->asBool();
    const double fogNear = num(*trace.find("fog"), "near"), fogFar = num(*trace.find("fog"), "far");
    ZoomOutController c;
    const auto& steps = trace.find("steps")->items();
    const auto& out = trace.find("out")->items();
    if (!ctx.check(steps.size() == out.size() && !steps.empty(), name + ": steps")) continue;
    int bad = 0;
    for (std::size_t i = 0; i < steps.size() && bad < 3; ++i) {
      const auto& s = steps[i].items();
      const Value& o = out[i];
      const bool applied = c.update(s[0].asNumber(), s[1].asNumber(), behaviorOf(s[2].asString()), fogNear, fogFar, reduceMotion);
      const maprama::ZoomOutLook& look = c.look();
      const std::string at = name + " step " + std::to_string(i);
      bool ok = std::fabs(c.t() - num(o, "t")) <= 1e-12;
      ok = ok && std::fabs(look.heightScale - num(o, "scaleY")) <= 1e-12;
      ok = ok && applied == o.find("applied")->asBool();
      if (applied) ok = ok && std::fabs(look.t - num(o, "hazeT")) <= 1e-12 && (look.mapColors > 0) == o.find("hazeMap")->asBool();
      // engine-web's targets keep their last applied values (and start at 0 / 48 / 160 before the first update).
      ok = ok && std::fabs(look.fogNear - num(o, "fogNear")) <= 1e-9 && std::fabs(look.fogFar - num(o, "fogFar")) <= 1e-9;
      ok = ok && std::fabs(look.shadowExtent - num(o, "shadowExtent")) <= 1e-9 && std::fabs(look.shadowFar - num(o, "shadowFar")) <= 1e-9;
      ok = ok && look.clutterVisible == o.find("clutter")->asBool();
      if (!ctx.check(ok, at + ": t / scaleY / applied / fog / shadow / clutter match engine-web")) ++bad;
    }
  }
}

namespace {

using maprama::test::maptest::Harness;

/// The last value sent for a paint property, or "" when it was never sent.
std::string lastPaint(const Harness& h, const std::string& layer, const std::string& property) {
  std::string out;
  for (const auto& batch : h.adapter->paints) {
    for (const maprama::PaintPropertyChange& c : batch) {
      if (c.layerId == layer && c.property == property) out = c.valueJson;
    }
  }
  return out;
}

Value upsertMsg(Value characters) {
  return Value::object({{"type", "upsertCharacters"}, {"characters", std::move(characters)}});
}

}  // namespace

MAPRAMA_TEST(m4_zoom_out_map_colors_style_and_layer) {
  using namespace maprama::test::maptest;
  using maprama::world_style::kLayerBuildings;
  using maprama::world_style::kLayerMapArterial;
  using maprama::world_style::kLayerMapGround;
  Harness h;
  h.send(initMsg(dataWorld(ctx), Value::object({{"distance", 320}, {"pitch", 50}}),
                 Value::object({{"base", "modern"}, {"zoomOut", "mapColors"}})));
  if (!ctx.check(h.engine->worldStore().world() != nullptr, "world loaded")) return;
  const Value style = maprama::json::parse(h.engine->styleJson()).value;
  ctx.check(hasLayer(style, kLayerMapGround) && hasLayer(style, kLayerMapArterial), "map-colour overlay layers exist");
  ctx.check(paintOf(style, kLayerMapGround, "fill-opacity") == "0", "overlay invisible at a near camera");
  ctx.check(!h.sink->loggedContaining("zoomOut", maprama::LogLevel::Warn), "no zoomOut warn log (M4 renders it)");

  // Zoom out beyond D2 (150 world units = 1,200 m) and let the factor ease.
  h.send(setCameraMsg(Value::object({{"distance", 1200}})));
  h.run(1500);
  ctx.check(lastPaint(h, kLayerMapGround, "fill-opacity").rfind("0.9", 0) == 0,
            "overlay faded in to ~0.92 (" + lastPaint(h, kLayerMapGround, "fill-opacity") + ")");
  const std::string height = lastPaint(h, kLayerBuildings, "fill-extrusion-height");
  ctx.check(height.find("0.4") != std::string::npos, "buildings shrink to 40 % height (" + height + ")");
  if (ctx.check(!h.adapter->zooms.empty(), "building layer zoom sent")) {
    const maprama::BuildingLayerZoom z = h.adapter->zooms.back();
    ctx.near(z.heightScale, 0.4, 0.02, "custom layer height scale");
    ctx.check(z.lowDetail, "far: the custom layer draws its low-detail range");
  }

  // Back to a near camera: full height, full detail, overlay gone.
  h.send(setCameraMsg(Value::object({{"distance", 320}})));
  h.run(2000);
  ctx.check(lastPaint(h, kLayerMapGround, "fill-opacity").rfind("0.0", 0) == 0 ||
                lastPaint(h, kLayerMapGround, "fill-opacity") == "0",
            "overlay faded out (" + lastPaint(h, kLayerMapGround, "fill-opacity") + ")");
  const maprama::BuildingLayerZoom back = h.adapter->zooms.back();
  ctx.near(back.heightScale, 1.0, 0.02, "height scale back to 1");
  ctx.check(!back.lowDetail, "near: full detail again");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m4_zoom_out_icon_discs_beyond_the_band) {
  using namespace maprama::test::maptest;
  Harness h;
  h.send(initMsg(dataWorld(ctx), Value::object({{"distance", 320}, {"pitch", 50}}),
                 Value::object({{"base", "modern"}, {"zoomOut", "keepGameView"}})));
  const maprama::WorldData* w = h.engine->worldStore().world();
  if (!ctx.check(w != nullptr, "world loaded")) return;
  const maprama::LngLat c = w->origin;
  h.send(upsertMsg(Value::array({Value::object({{"id", "me"}, {"isPlayer", true}, {"position", lngLat(c.lng, c.lat)}}),
                                 Value::object({{"id", "npc"}, {"position", lngLat(c.lng + 0.0002, c.lat)}})})));
  h.send(Value::object({{"type", "setDropLayer"},
                        {"layerId", "coins"},
                        {"drops", Value::array({Value::object({{"id", "d1"}, {"type", "coin"}, {"coordinate", lngLat(c.lng, c.lat + 0.0002)}}),
                                                Value::object({{"id", "d2"}, {"type", "cd"}, {"coordinate", lngLat(c.lng, c.lat + 0.0003)}})})},
                        {"collectRadiusMeters", 1}}));
  h.run(600);
  const auto near = h.adapter->modelFrames.back();
  if (!ctx.check(near != nullptr, "model frame at a near camera")) return;
  ctx.check(!near->sprites && near->characters == 2 && near->drops == 2, "near: 3D models");
  const std::size_t modelDraws = near->draws.size();
  ctx.check(modelDraws >= 3, "near: one draw per body plus the instanced drop items (" + std::to_string(modelDraws) + ")");

  h.send(setCameraMsg(Value::object({{"distance", 1200}})));
  h.run(600);
  const auto far = h.adapter->modelFrames.back();
  ctx.check(far->sprites, "beyond D2: icon discs");
  ctx.check(far->draws.size() == 1, "every icon in one instanced draw (" + std::to_string(far->draws.size()) + ")");
  ctx.check(far->instances.size() == 4, "four icons (2 characters, 2 drops)");
  ctx.check(far->characters == 2 && far->drops == 2, "the visuals still describe every character and drop");

  // Hysteresis: 106 units (848 m) keeps the discs, 800 m brings the models back.
  h.send(setCameraMsg(Value::object({{"distance", 848}})));
  h.run(200);
  ctx.check(h.adapter->modelFrames.back()->sprites, "hysteresis keeps the discs just below D2");
  h.send(setCameraMsg(Value::object({{"distance", 800}})));
  h.run(200);
  ctx.check(!h.adapter->modelFrames.back()->sprites, "below 0.95 D2: 3D models again");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m4_idle_frames_only_while_models_are_in_view) {
  using namespace maprama::test::maptest;
  Harness h;
  h.send(initMsg(dataWorld(ctx), Value::object({{"distance", 320}, {"pitch", 50}})));
  const maprama::WorldData* w = h.engine->worldStore().world();
  if (!ctx.check(w != nullptr, "world loaded")) return;
  const maprama::LngLat c = w->origin;
  // A character far outside the view (≈4 km away): no visible idle motion, so no animation frames.
  h.send(upsertMsg(Value::array({Value::object({{"id", "far"}, {"position", lngLat(c.lng + 0.05, c.lat - 0.05)}})})));
  h.run(600);
  std::size_t before = h.adapter->frames.size();
  h.run(640);  // 40 frames
  const std::size_t idleOutOfView = h.adapter->frames.size() - before;
  ctx.check(idleOutOfView <= 2, "idle character out of view: no 16 ms frames (" + std::to_string(idleOutOfView) + ")");

  // The same character under the camera animates every frame (engine-web renders continuously).
  h.send(upsertMsg(Value::array({Value::object({{"id", "far"}, {"position", lngLat(c.lng, c.lat)}})})));
  h.run(200);
  before = h.adapter->frames.size();
  h.run(640);
  const std::size_t idleInView = h.adapter->frames.size() - before;
  ctx.check(idleInView >= 30, "idle character in view: one frame per tick (" + std::to_string(idleInView) + ")");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m4_zoom_out_settling_and_sprites) {
  ZoomOutController c;
  const ZoomOutBehavior keep = ZoomOutBehavior::KeepGameView;
  ctx.check(c.settling(40, keep), "never applied: settling");
  c.update(0.016, 40, keep);
  ctx.check(!c.settling(40, keep), "near and applied: settled");
  ctx.check(c.settling(150, keep), "zoomed out: settling");
  int frames = 0;
  while (c.settling(150, keep) && frames < 1000) {
    c.update(1.0 / 60, 150, keep);
    ++frames;
  }
  ctx.check(frames > 30 && frames < 120, "eases in 0.5-2 s (" + std::to_string(frames) + " frames)");
  ctx.check(c.look().lowDetail() && c.look().heightScale == 1.0, "keepGameView far: low detail, full height");
  ctx.check(c.settling(150, ZoomOutBehavior::MapColors), "behaviour change: settling");
  c.update(0.016, 150, ZoomOutBehavior::MapColors);
  ctx.check(c.look().heightScale < 0.45 && c.look().mapVisible, "mapColors far: 40 % height, overlay visible");

  ctx.check(!c.sprites(), "sprites start off");
  ctx.check(!c.updateSprites(109, keep) && !c.sprites(), "below D2: 3D models");
  ctx.check(c.updateSprites(110, keep) && c.sprites(), "at D2: icon discs");
  ctx.check(!c.updateSprites(106, keep) && c.sprites(), "hysteresis keeps the discs just below D2");
  ctx.check(c.updateSprites(104, keep) && !c.sprites(), "below 0.95 D2: 3D models again");
  c.updateSprites(150, keep);
  ctx.check(c.updateSprites(150, ZoomOutBehavior::None) && !c.sprites(), "none: never icon discs");
}
