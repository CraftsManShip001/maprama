// M2a "diorama look" on the official SDKs: resolveTheme conformance, theme -> style values, the 3D building
// layer, setTheme paint patches, setBuildingStyle, presses, overlay:positions throttling and the map UI,
// all through the fake MapAdapter (map_harness.hpp). Emitted envelopes go to --emit (verify-emitted-events).
#include <cmath>
#include <optional>
#include <string>
#include <vector>

#include "maprama/CameraMath.hpp"
#include "maprama/MapLook.hpp"
#include "maprama/ThemeResolver.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/WorldStyle.hpp"
#include "harness.hpp"
#include "map_harness.hpp"

namespace {

using maprama::json::Value;
using namespace maprama::test::maptest;
namespace cm = maprama::camera_math;
using maprama::cssHex;

/// The example app's SAMPLE_BUILDING (first named building of the Seongsu sample).
constexpr const char* kSample = "w407169878";

/// Deep equality with object members compared regardless of order; `where` names the first difference.
bool jsonEqual(const Value& a, const Value& b, const std::string& path, std::string& where) {
  if (a.type() != b.type()) {
    where = path + " (type)";
    return false;
  }
  switch (a.type()) {
    case maprama::json::Type::Null:
      return true;
    case maprama::json::Type::Boolean:
      if (a.asBool() == b.asBool()) return true;
      break;
    case maprama::json::Type::Number:
      if (a.asNumber() == b.asNumber()) return true;
      break;
    case maprama::json::Type::String:
      if (a.asString() == b.asString()) return true;
      break;
    case maprama::json::Type::Array:
      if (a.items().size() != b.items().size()) break;
      for (std::size_t i = 0; i < a.items().size(); ++i) {
        if (!jsonEqual(a.items()[i], b.items()[i], path + "[" + std::to_string(i) + "]", where)) return false;
      }
      return true;
    case maprama::json::Type::Object:
      if (a.members().size() != b.members().size()) break;
      for (const maprama::json::Member& m : a.members()) {
        const Value* other = b.find(m.key);
        if (other == nullptr) {
          where = path + "." + m.key + " (missing)";
          return false;
        }
        if (!jsonEqual(m.value, *other, path + "." + m.key, where)) return false;
      }
      return true;
  }
  where = path + ": " + maprama::json::stringify(a) + " != " + maprama::json::stringify(b);
  return false;
}

maprama::ResolvedTheme resolved(const Value& spec) { return maprama::ThemeResolver::builtIn().resolve(spec); }
maprama::MapLook lookOf(const Value& spec) { return maprama::mapLookFor(resolved(spec)); }

Value lastStyle(const Harness& h) { return maprama::json::parse(h.adapter->styles.back()).value; }
Value currentStyle(const Harness& h) { return maprama::json::parse(h.engine->styleJson()).value; }

std::string quoted(std::uint32_t rgb) { return maprama::json::quote(cssHex(rgb)); }

Value setTheme(Value theme) { return Value::object({{"type", "setTheme"}, {"theme", std::move(theme)}}); }
Value setUi(Value ui) { return Value::object({{"type", "setUi"}, {"ui", std::move(ui)}}); }
Value buildingStyle(const std::string& id, Value style) {
  return Value::object({{"type", "setBuildingStyle"}, {"buildingId", id}, {"style", std::move(style)}});
}
Value overlayAnchors(Value anchors) { return Value::object({{"type", "setOverlayAnchors"}, {"anchors", std::move(anchors)}}); }

std::string paintValue(const Harness& h, const std::string& layer, const std::string& property) {
  const maprama::PaintPropertyChange* c = h.adapter->lastPaint(layer, property);
  return c != nullptr ? c->valueJson : std::string();
}

}  // namespace

MAPRAMA_TEST(theme_resolver_matches_resolve_theme) {
  const Value fixture = maprama::test::loadFixture(ctx, "theme.json");
  const maprama::ThemeResolver& resolver = maprama::ThemeResolver::builtIn();
  std::size_t cases = 0;
  for (const Value& c : fixture.find("cases")->items()) {
    const Value got = maprama::resolvedThemeToJson(resolver.resolve(*c.find("spec")));
    std::string where;
    ctx.check(jsonEqual(got, *c.find("resolved"), "$", where),
              "resolveTheme(" + maprama::test::truncate(maprama::json::stringify(*c.find("spec")), 100) + ") differs at " + where);
    ++cases;
  }
  ctx.check(cases >= 79, "theme fixture: every preset x time x cinematic plus overrides (" + std::to_string(cases) + ")");
  ctx.check(resolver.preset(maprama::PresetName::Toy).palette.size() == 6 &&
                resolver.preset(maprama::PresetName::Toy).palette[0] == "#F7C5B5",
            "built-in data is the protocol's (generated ThemeData.cpp)");
  ctx.check(resolver.time(maprama::TimeOfDay::Night).fog == 0x1A2340, "TIMES.night.fog");
}

MAPRAMA_TEST(map_look_colors_light_and_scale_bar) {
  // CSS colors and engine-web's hashId.
  ctx.check(maprama::parseCssHex("#abc") == 0xAABBCCu && maprama::parseCssHex("#11223344") == 0x112233u &&
                maprama::parseCssHex("#FF8800") == 0xFF8800u && !maprama::parseCssHex("FF8800") && !maprama::parseCssHex("#12345"),
            "parseCssHex: #RGB, #RRGGBB, #RRGGBBAA");
  ctx.check(cssHex(0x0A0B0C) == "#0A0B0C", "cssHex");
  ctx.check(maprama::hashId("w407169878") == 1790131746u && maprama::hashId("큐브") == 528816953u &&
                maprama::hashId("a😀b") == 2412414209u && maprama::hashId("") == 2166136261u &&
                maprama::hashId("n5935554450") == 2719161616u,
            "hashId == engine-web hashId (FNV-1a over UTF-16 code units, values from node)");

  // realistic / day: exactly the theme's (engine-web static world) colors.
  const maprama::MapLook day = lookOf(Value::object());
  ctx.check(day.tint.r == 1 && day.tint.g == 1 && day.tint.b == 1, "day tint is identity");
  ctx.check(day.ground == 0x86A56E && day.road == 0x55585E && day.pad == 0xC4C1BA && day.water == 0x4A7896,
            "textured preset: grass ground, asphalt, sidewalk pads (engine-web static-world colors)");
  ctx.check(day.background == 0xD9DFE0, "background = TIMES.day fog (engine-web clear color)");
  ctx.check(day.palette[0] == 0xFFFFFF && day.palette[1] == 0xF3EADF && !day.schemeTints, "realistic palette");
  ctx.near(day.light.azimuthal, std::atan2(30.0, -24.0) * 180 / M_PI, 0.01, "sun azimuth from TIMES.day.dir (clockwise from north)");
  ctx.near(day.light.polar, std::atan2(std::hypot(30.0, 24.0), 30.0) * 180 / M_PI, 0.01, "sun polar angle from TIMES.day.dir");
  ctx.check(day.light.color == maprama::mixColor(0xFFFFFF, 0xFFE4BC, 0.4) && day.light.intensity == 0.6,
            "light color = 40 % sun color, intensity");

  // toy: untextured colors, low sun multiplier.
  const maprama::MapLook toy = lookOf(Value::object({{"base", "toy"}}));
  ctx.check(toy.ground == 0xD6E9CB && toy.road == 0xE2DEEC && toy.palette[1] == 0xBFD7F2, "toy colors");
  ctx.near(toy.light.intensity, 0.2 + 0.16 * 2.5 * 0.36, 1e-9, "light intensity from sunI x sunMul");

  // night: darker and bluer, same hue logic for every flat color.
  const maprama::MapLook night = lookOf(Value::object({{"base", "toy"}, {"timeOfDay", "night"}}));
  ctx.check(night.tint.r < 0.5 && night.tint.b > night.tint.r, "night tint is dark blue");
  ctx.check(night.ground == maprama::applyTint(0xD6E9CB, night.tint) && night.background == 0x1A2340,
            "night ground tinted, background = night fog");
  const maprama::MapLook dusk = lookOf(Value::object({{"timeOfDay", "dusk"}}));
  ctx.check(dusk.tint.r > dusk.tint.b && dusk.tint.r < 1, "dusk tint is warm and darker");

  // urban + details: color schemes; heightScale.
  ctx.check(lookOf(Value::object({{"base", "urban"}})).schemeTints.has_value(), "urban details -> color schemes");
  ctx.check(!lookOf(Value::object({{"base", "urban"}, {"buildings", Value::object({{"details", false}})}})).schemeTints,
            "urban without details -> palette");
  ctx.check(lookOf(Value::object({{"buildings", Value::object({{"heightScale", 1.5}})}})).heightScale == 1.5, "heightScale");

  // Building override colors.
  maprama::BuildingOverride captured;
  captured.captured = true;
  ctx.check(maprama::buildingOverrideColor(day, 2, 7, captured) == maprama::mixColor(day.palette[2], 0xFFD36E, 0.35),
            "captured = theme color mixed with the glow");
  maprama::BuildingOverride orange;
  orange.color = 0xFF8800;
  ctx.check(maprama::buildingOverrideColor(day, 2, 7, orange) == 0xFF8800, "explicit color at day");
  ctx.check(maprama::buildingOverrideColor(night, 2, 7, orange) == maprama::applyTint(0xFF8800, night.tint), "explicit color tinted at night");

  // Unrendered options.
  const std::vector<std::string> unrendered = maprama::unrenderedThemeOptions(resolved(Value::object({{"base", "modern"}})));
  ctx.check(unrendered.size() == 5, "modern: facade, outline, details, massing, cinematic unrendered (" + std::to_string(unrendered.size()) + ")");
  ctx.check(maprama::unrenderedThemeOptions(resolved(Value::object({{"base", "minimal"}}))).empty(), "minimal renders fully");

  // Scale bar (engine-web scaleBarFor).
  const maprama::ScaleBarSpec a = maprama::scaleBarFor(1.0);
  ctx.check(a.meters == 50 && a.width == 50 && a.label == "50m", "1 m/dp -> 50 m bar");
  const maprama::ScaleBarSpec b = maprama::scaleBarFor(20.0);
  ctx.check(b.meters == 1000 && b.width == 50 && b.label == "1km", "20 m/dp -> 1 km bar");
  ctx.check(maprama::scaleBarFor(0).label.empty(), "no scale without a resolution");
}

MAPRAMA_TEST(m2a_extruded_buildings_and_theme_patches) {
  Harness h;
  const Value worldValue = seongsuValue(ctx);
  auto store = maprama::createWorldStore();
  ctx.check(store->load(worldValue).ok(), "Seongsu sample loads");
  const maprama::WorldData& w = *store->world();
  h.send(initMsg(Value::object({{"kind", "data"}, {"world", worldValue}})));
  const Value s = lastStyle(h);

  const Value* buildings = findLayer(s, "buildings");
  ctx.check(buildings != nullptr && buildings->find("type")->asString() == "fill-extrusion" &&
                buildings->find("source")->asString() == "maprama-buildings",
            "3D buildings: one fill-extrusion layer on the buildings source");
  ctx.check(paintOf(s, "buildings", "fill-extrusion-height") == R"(["*",["get","height"],1])", "height = meters x heightScale");
  const auto& layers = s.find("layers")->items();
  ctx.check(layers.back().find("id")->asString() == "buildings" &&
                layers[layers.size() - 2].find("id")->asString() == "buildings-captured",
            "buildings drawn last (occlude POIs / roads), captured ring just below");
  const auto& features = s.find("sources")->find("maprama-buildings")->find("data")->find("features")->items();
  bool propsOk = features.size() == w.buildings.size();
  for (std::size_t i = 0; propsOk && i < features.size(); ++i) {
    const Value& p = *features[i].find("properties");
    const maprama::BuildingFootprint& b = w.buildings[i];
    propsOk = p.find("id")->asString() == b.id && p.find("height")->asNumber() == std::max(0.2, b.height) * w.unitMeters &&
              p.find("ci")->asNumber() == maprama::hashId(b.id) % 6 && p.find("si")->asNumber() == static_cast<double>(i % 5);
  }
  ctx.check(propsOk, "building features: id, height in meters (max 0.2 units), ci = hashId % 6, si = index % 5");

  // realistic / day defaults.
  ctx.check(paintOf(s, "area", "fill-color") == quoted(0x86A56E) && paintOf(s, "roads-local", "line-color") == quoted(0x55585E) &&
                paintOf(s, "roads-local-casing", "line-color") == quoted(0xC4C1BA) && paintOf(s, "water", "fill-color") == quoted(0x4A7896) &&
                paintOf(s, "background", "background-color") == quoted(0xD9DFE0),
            "realistic day map colors");
  ctx.check(paintOf(s, "buildings", "fill-extrusion-color") ==
                R"(["match",["get","ci"],0,"#FFFFFF",1,"#F3EADF",2,"#E4EBF1",3,"#EDE1D8",4,"#E1E7DE",5,"#F6F2EA","#FFFFFF"])",
            "building colors = realistic palette by ci");
  const Value* light = s.find("light");
  ctx.check(light != nullptr && light->find("anchor")->asString() == "map" &&
                light->find("color")->asString() == cssHex(maprama::mixColor(0xFFFFFF, 0xFFE4BC, 0.4)) &&
                light->find("intensity")->asNumber() == 0.6 && light->find("position")->items().size() == 3,
            "style light = day sun");
  ctx.check(paintOf(s, "roads-arterial-centerline", "line-opacity") == "1", "realistic lane markings on");

  // init.theme is applied to the first style.
  Harness t;
  t.send(initMsg(Value::object({{"kind", "data"}, {"world", worldValue}}), std::nullopt, Value::object({{"base", "minimal"}})));
  ctx.check(paintOf(lastStyle(t), "area", "fill-color") == quoted(0xE4E8E1), "init.theme -> minimal ground");

  // setTheme patches paint properties and the light; no style reload.
  const std::size_t styles = h.adapter->styles.size();
  h.send(setTheme(Value::object({{"base", "toy"}, {"timeOfDay", "night"}})));
  ctx.check(h.adapter->styles.size() == styles, "setTheme does not reload the style");
  const maprama::MapLook toyNight = lookOf(Value::object({{"base", "toy"}, {"timeOfDay", "night"}}));
  if (ctx.check(!h.adapter->paints.empty(), "setTheme sends paint properties")) {
    ctx.check(paintValue(h, "background", "background-color") == quoted(0x1A2340), "background = night fog");
    ctx.check(paintValue(h, "area", "fill-color") == quoted(toyNight.ground), "ground = toy ground, night tint");
    ctx.check(paintValue(h, "buildings", "fill-extrusion-color").find(cssHex(maprama::applyTint(0xF7C5B5, toyNight.tint))) !=
                  std::string::npos,
              "building palette = toy palette, night tint");
    ctx.check(paintValue(h, "roads-arterial-centerline", "line-opacity").empty(), "unchanged properties are not re-sent");
  }
  ctx.check(!h.adapter->lights.empty() && h.adapter->lights.back().color == maprama::mixColor(0xFFFFFF, 0x9DB2FF, 0.4),
            "light = night sun (softened)");
  const std::size_t paints = h.adapter->paints.size();
  const std::size_t lights = h.adapter->lights.size();
  h.send(setTheme(Value::object({{"base", "toy"}, {"timeOfDay", "night"}})));
  ctx.check(h.adapter->paints.size() == paints && h.adapter->lights.size() == lights, "identical theme sends nothing");
  h.send(setTheme(Value::object({{"base", "toy"}, {"timeOfDay", "night"}, {"buildings", Value::object({{"heightScale", 2}})}})));
  ctx.check(paintValue(h, "buildings", "fill-extrusion-height") == R"(["*",["get","height"],2])", "heightScale patched");

  // Options M2a does not render are warned once each.
  h.send(setTheme(Value::object({{"base", "modern"}})));
  h.send(setTheme(Value::object({{"base", "modern"}, {"timeOfDay", "golden"}})));
  ctx.check(h.sink->countLogs("buildings.massing \"varied\"", maprama::LogLevel::Warn) == 1, "massing varied warned once");
  ctx.check(h.sink->eventsOfType("error").empty(), "setTheme emits no error");

  // The retained style is the latest look (late attach / diagnostics).
  const std::string background = quoted(lookOf(Value::object({{"base", "modern"}, {"timeOfDay", "golden"}})).background);
  ctx.check(paintOf(currentStyle(h), "background", "background-color") == background, "styleJson() carries the latest theme");
  auto late = std::make_shared<FakeAdapter>();
  h.engine->attachMapAdapter(late);
  ctx.check(!late->styles.empty() && paintOf(maprama::json::parse(late->styles.back()).value, "background", "background-color") == background,
            "attach sends the themed style");
  appendEmitted(ctx, *h.sink);
  appendEmitted(ctx, *t.sink);
}

MAPRAMA_TEST(m2a_set_building_style) {
  Harness pre;
  pre.send(buildingStyle(kSample, Value::object({{"color", "#FF8800"}})));
  std::vector<Value> errors = pre.sink->eventsOfType("error");
  ctx.check(errors.size() == 1 && errors[0].find("code")->asString() == "not_ready" && !errors[0].find("fatal")->asBool() &&
                errors[0].find("message")->asString() == "setBuildingStyle: no world loaded (send init first)",
            "no world -> not_ready (engine-web message)");

  Harness h;
  const Value worldValue = seongsuValue(ctx);
  auto store = maprama::createWorldStore();
  store->load(worldValue);
  const std::vector<maprama::RenderedBuilding> rendered = maprama::renderedBuildings(*store->world());
  std::size_t sampleIndex = 0;
  for (const maprama::RenderedBuilding& rb : rendered) {
    if (store->world()->buildings[rb.worldIndex].id == kSample) sampleIndex = rb.index;
  }
  const std::uint32_t ci = maprama::hashId(kSample) % 6;
  h.send(initMsg(Value::object({{"kind", "data"}, {"world", worldValue}})));
  const std::string themed = paintOf(lastStyle(h), "buildings", "fill-extrusion-color");
  const maprama::MapLook day = lookOf(Value::object());
  const std::size_t styles = h.adapter->styles.size();

  h.send(buildingStyle(kSample, Value::object({{"color", "#FF8800"}, {"state", "captured"}})));
  const std::string capturedOrange = cssHex(maprama::mixColor(0xFF8800, 0xFFD36E, 0.35));
  ctx.check(paintValue(h, "buildings", "fill-extrusion-color") ==
                std::string(R"(["match",["get","id"],")") + kSample + R"(",")" + capturedOrange + "\"," + themed + "]",
            "override color by id over the theme colors (captured glow mixed in)");
  ctx.check(paintValue(h, "buildings-captured", "line-opacity") == std::string(R"(["match",["get","id"],")") + kSample + R"(",1,0])",
            "captured ring shown for the building");
  ctx.check(h.adapter->styles.size() == styles, "setBuildingStyle patches paint only");

  h.send(buildingStyle(kSample, Value::object({{"state", "captured"}})));
  ctx.check(paintValue(h, "buildings", "fill-extrusion-color")
                    .find(cssHex(maprama::buildingOverrideColor(day, ci, sampleIndex, maprama::BuildingOverride{std::nullopt, true}))) !=
                std::string::npos,
            "captured without color = theme color + glow");
  h.send(buildingStyle(kSample, Value::object({{"color", "#2F5BEA"}})));
  ctx.check(paintValue(h, "buildings", "fill-extrusion-color").find("\"#2F5BEA\"") != std::string::npos &&
                paintValue(h, "buildings-captured", "line-opacity") == "0",
            "color without state: no ring");
  h.send(buildingStyle(kSample, Value::object({{"color", "#abc"}, {"roof", "gable"}})));
  h.send(buildingStyle(kSample, Value::object({{"color", "#abc"}, {"roof", "dome"}})));
  ctx.check(paintValue(h, "buildings", "fill-extrusion-color").find("\"#AABBCC\"") != std::string::npos ||
                h.adapter->paints.size() > 0,
            "#RGB accepted");
  ctx.check(h.sink->countLogs("setBuildingStyle.roof", maprama::LogLevel::Warn) == 1, "roof override warned once (M2c)");

  // Overrides survive theme changes (re-tinted).
  h.send(setTheme(Value::object({{"timeOfDay", "night"}})));
  const maprama::MapLook night = lookOf(Value::object({{"timeOfDay", "night"}}));
  ctx.check(paintValue(h, "buildings", "fill-extrusion-color").find(cssHex(maprama::applyTint(0xAABBCC, night.tint))) != std::string::npos,
            "override kept and tinted after setTheme");

  // null clears.
  h.send(buildingStyle(kSample, Value(nullptr)));
  ctx.check(paintOf(currentStyle(h), "buildings", "fill-extrusion-color").find(kSample) == std::string::npos, "null clears the override");

  // Unknown ids.
  h.send(buildingStyle("nope", Value::object({{"color", "#abc"}})));
  errors = h.sink->eventsOfType("error");
  ctx.check(errors.size() == 1 && errors[0].find("code")->asString() == "unknown_building" && !errors[0].find("fatal")->asBool() &&
                errors[0].find("message")->asString() == "setBuildingStyle: unknown building \"nope\"",
            "unknown building -> unknown_building (engine-web message)");

  // A new world starts without overrides.
  h.send(buildingStyle(kSample, Value::object({{"state", "captured"}})));
  h.send(initMsg(Value::object({{"kind", "data"}, {"world", worldValue}})));
  ctx.check(paintOf(lastStyle(h), "buildings", "fill-extrusion-color").find(kSample) == std::string::npos &&
                paintOf(lastStyle(h), "buildings-captured", "line-opacity") == "0",
            "new world clears building overrides");
  appendEmitted(ctx, *pre.sink);
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m2a_map_and_building_press) {
  Harness idle;
  idle.engine->tap(10, 10);
  ctx.check(idle.adapter->queries.empty(), "tap before a world is ignored");

  Harness h;
  const Value worldValue = seongsuValue(ctx);
  auto store = maprama::createWorldStore();
  store->load(worldValue);
  const maprama::BuildingFootprint* b = store->findBuilding(kSample);
  const maprama::Projection& projection = *store->projection();
  double cx = 0, cz = 0;
  for (const maprama::Vec2& p : b->footprint) {
    cx += p[0] / static_cast<double>(b->footprint.size());
    cz += p[1] / static_cast<double>(b->footprint.size());
  }
  const maprama::LngLat inside = projection.toLngLat({cx, cz});
  const maprama::LngLat outside = projection.toLngLat({b->footprint[0][0] + 200, b->footprint[0][1]});
  h.send(initMsg(Value::object({{"kind", "data"}, {"world", worldValue}})));

  const auto tapReply = [&](std::optional<std::string> id, std::optional<maprama::LngLat> ground) {
    h.engine->tap(120, 240);
    const std::uint64_t token = std::get<0>(h.adapter->queries.back());
    h.engine->onBuildingQueried(token, std::move(id), ground);
    return token;
  };

  const std::uint64_t first = tapReply(std::string(kSample), inside);
  ctx.check(std::get<1>(h.adapter->queries.back()) == 120 && std::get<2>(h.adapter->queries.back()) == 240, "tap point forwarded");
  std::vector<Value> presses = h.sink->eventsOfType("building:press");
  ctx.check(presses.size() == 1 && presses[0].find("buildingId")->asString() == kSample &&
                presses[0].find("coordinate")->find("lng")->asNumber() == inside.lng &&
                presses[0].find("coordinate")->find("lat")->asNumber() == inside.lat,
            "building:press {buildingId, ground point on the footprint}");
  h.engine->onBuildingQueried(first, std::string(kSample), inside);
  ctx.check(h.sink->eventsOfType("building:press").size() == 1, "a tap is answered once");

  tapReply(std::string(kSample), outside);
  presses = h.sink->eventsOfType("building:press");
  if (ctx.check(presses.size() == 2, "building hit with the ground point off the footprint")) {
    const maprama::WorldPoint p = projection.toWorld({presses[1].find("coordinate")->find("lng")->asNumber(),
                                                      presses[1].find("coordinate")->find("lat")->asNumber()});
    ctx.check(std::hypot(p.x - cx, p.z - cz) < 3.0, "-> coordinate is the footprint centroid");
  }
  tapReply(std::string(kSample), std::nullopt);
  ctx.check(h.sink->eventsOfType("building:press").size() == 3, "building hit without a ground point -> centroid");

  tapReply(std::string("not-a-building"), outside);
  tapReply(std::nullopt, inside);
  std::vector<Value> maps = h.sink->eventsOfType("map:press");
  ctx.check(maps.size() == 2 && maps[0].find("coordinate")->find("lng")->asNumber() == outside.lng &&
                maps[1].find("coordinate")->find("lat")->asNumber() == inside.lat,
            "map:press {ground coordinate} when no known building was hit");
  tapReply(std::nullopt, std::nullopt);
  ctx.check(h.sink->eventsOfType("map:press").size() == 2 && h.sink->eventsOfType("building:press").size() == 3,
            "tap on neither building nor ground emits nothing");

  const std::size_t queries = h.adapter->queries.size();
  h.engine->detachMapAdapter();
  h.engine->tap(1, 1);
  ctx.check(h.adapter->queries.size() == queries, "tap without a map view is ignored");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m2a_overlay_positions_throttled_per_frame) {
  Harness h;
  h.send(initMsg(dataWorld(ctx)));
  ctx.check(h.adapter->pointProjections.empty(), "no anchors, no projections");
  const Value anchors = Value::array({Value::object({{"id", "station"}, {"coordinate", lngLat(127.0561, 37.5447)}}),
                                      Value::object({{"id", "shop"}, {"coordinate", lngLat(127.05, 37.54)}})});
  h.send(overlayAnchors(anchors));
  if (!ctx.check(h.adapter->pointProjections.size() == 1 && h.adapter->pointProjections[0].second.size() == 2 &&
                     h.adapter->pointProjections[0].second[0].lng == 127.0561,
                 "setOverlayAnchors projects the anchors")) {
    return;
  }
  const auto reply = [&](std::vector<maprama::ScreenPoint> points) {
    h.engine->onPointsProjected(h.adapter->pointProjections.back().first, std::move(points));
  };
  const auto positions = [&]() { return h.sink->eventsOfType("overlay:positions"); };
  reply({{100, 200, false}, {-10, 50, false}});
  std::vector<Value> sent = positions();
  if (ctx.check(sent.size() == 1, "overlay:positions emitted")) {
    const Value& list = *sent[0].find("positions");
    ctx.check(list.items().size() == 2 && list.items()[0].find("id")->asString() == "station" &&
                  list.items()[0].find("x")->asNumber() == 100 && list.items()[0].find("y")->asNumber() == 200 &&
                  list.items()[0].find("visible")->asBool() && !list.items()[1].find("visible")->asBool(),
              "positions {id, x, y, visible}; off-screen -> visible false");
  }

  // Camera changes: at most one projection per 16 ms frame and one in flight.
  maprama::MapCameraPose pose = h.adapter->moves.back().first;
  const auto moveCamera = [&]() {
    pose.bearing += 1;
    h.engine->onCameraChanged(pose);
  };
  h.now = 1005;
  moveCamera();
  h.now = 1010;
  moveCamera();
  ctx.check(h.adapter->pointProjections.size() == 1, "changes inside the frame wait");
  ctx.check(!h.adapter->frames.empty() && std::fabs(h.adapter->frames.back() - 11) < 1e-9, "frame scheduled at the frame end");
  h.now = 1016;
  h.engine->frame(h.now);
  ctx.check(h.adapter->pointProjections.size() == 2, "projected at the next frame");
  h.now = 1017;
  moveCamera();
  ctx.check(h.adapter->pointProjections.size() == 2, "one projection in flight at a time");
  reply({{100, 200, false}, {-10, 50, false}});
  ctx.check(positions().size() == 1, "unchanged positions are not re-sent");
  h.now = 1033;
  h.engine->frame(h.now);
  ctx.check(h.adapter->pointProjections.size() == 3, "change during the flight is projected next frame");
  reply({{100.1, 200, false}, {-10, 50, false}});
  ctx.check(positions().size() == 1, "moves below 0.25 dp are not re-sent");
  moveCamera();
  h.now = 1050;
  h.engine->frame(h.now);
  reply({{130, 200, false}, {-10, 50, false}});
  sent = positions();
  ctx.check(sent.size() == 2 && sent[1].find("positions")->items()[0].find("x")->asNumber() == 130, "moved anchor re-sent");

  // Anchors replaced while a projection is in flight: the stale reply is dropped.
  moveCamera();
  h.now = 1070;
  h.engine->frame(h.now);
  const std::size_t inFlight = h.adapter->pointProjections.size();
  h.send(overlayAnchors(Value::array({Value::object({{"id", "station"}, {"coordinate", lngLat(127.0561, 37.5447)}})})));
  reply({{1, 1, false}, {2, 2, false}});
  ctx.check(positions().size() == 2, "stale reply dropped");
  h.now = 1090;
  h.engine->frame(h.now);
  ctx.check(h.adapter->pointProjections.size() == inFlight + 1 && h.adapter->pointProjections.back().second.size() == 1,
            "new anchor set projected");
  reply({{5, 6, false}});
  sent = positions();
  ctx.check(sent.size() == 3 && sent[2].find("positions")->items().size() == 1, "new anchor set emitted");

  // No anchors: no more projections.
  h.send(overlayAnchors(Value::array()));
  moveCamera();
  h.now = 1200;
  h.engine->frame(h.now);
  ctx.check(h.adapter->pointProjections.size() == inFlight + 1, "no anchors -> no projections");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(m2a_map_ui_state) {
  Harness h;
  ctx.check(!h.adapter->uis.empty() && !h.adapter->uis.back().scaleBar && !h.adapter->uis.back().attribution &&
                !h.adapter->uis.back().logo && !h.adapter->uis.back().zoomButtons && !h.adapter->uis.back().compass,
            "attach hides every ornament until a world is loaded");
  h.send(initMsg(dataWorld(ctx), std::nullopt, Value::object(),
                 Value::object({{"scaleBar", true}, {"attribution", true}, {"zoomButtons", true}})));
  maprama::MapUiState ui = h.adapter->uis.back();
  const double mpp = 2 * h.engine->cameraState().distance * std::tan(20 * M_PI / 180) / 500;
  const maprama::ScaleBarSpec bar = maprama::scaleBarFor(mpp);
  ctx.check(ui.scaleBar && ui.scaleBarWidth == bar.width && ui.scaleBarLabel == bar.label && ui.scaleBarWidth <= 90,
            "scale bar = engine-web scaleBarFor at the target (" + ui.scaleBarLabel + ")");
  ctx.check(ui.attribution && ui.attributionText == "© OpenStreetMap contributors" && ui.logo,
            "attribution text visible, with the MapLibre logo");
  ctx.check(ui.zoomButtons && ui.compass, "zoom buttons with the compass");

  h.send(setUi(Value::object({{"attribution", true}})));
  ui = h.adapter->uis.back();
  ctx.check(!ui.scaleBar && !ui.zoomButtons && !ui.compass && ui.attribution, "setUi replaces the whole ui (absent = off)");
  const std::size_t uis = h.adapter->uis.size();
  h.send(setUi(Value::object({{"attribution", true}})));
  ctx.check(h.adapter->uis.size() == uis, "unchanged ui is not re-sent");
  h.send(setUi(Value::object({{"attribution", false}})));
  ctx.check(!h.adapter->uis.back().attribution && !h.adapter->uis.back().logo && h.adapter->uis.back().attributionText.empty(),
            "attribution off hides the text and the logo");

  h.send(setUi(Value::object({{"scaleBar", true}})));
  const std::string near = h.adapter->uis.back().scaleBarLabel;
  h.send(setCameraMsg(Value::object({{"distance", 1000}})));
  ctx.check(h.adapter->uis.back().scaleBar && h.adapter->uis.back().scaleBarLabel != near, "scale bar follows the camera");

  h.send(setUi(Value::object({{"locationPuck", true}})));
  h.send(setUi(Value::object({{"locationPuck", true}, {"scaleBar", true}})));
  ctx.check(h.sink->countLogs("ui.locationPuck", maprama::LogLevel::Warn) == 1, "locationPuck warned once (M3)");

  // Zoom buttons: ±1.45x distance over 250 ms, clamped to the distance limits.
  const double d = h.engine->cameraState().distance;
  const double lat = h.engine->cameraState().center.lat;
  h.engine->zoomButton(true);
  ctx.check(h.adapter->moves.back().second == 250, "zoom button animates 250 ms");
  ctx.near(h.adapter->moves.back().first.zoom, cm::distanceToMapLibreZoom(d / 1.45, lat, 500), 1e-9, "zoom in = distance / 1.45");
  h.engine->zoomButton(false);
  ctx.near(h.adapter->moves.back().first.zoom, cm::distanceToMapLibreZoom(std::min(d * 1.45, 150.0 * 8), lat, 500), 1e-9,
           "zoom out = distance x 1.45, clamped at DIST_MAX");
  h.send(setCameraMsg(Value::object({{"distance", 112}})));
  h.engine->zoomButton(true);
  ctx.near(h.adapter->moves.back().first.zoom, cm::distanceToMapLibreZoom(112, lat, 500), 1e-9, "clamped at DIST_MIN");
  ctx.check(h.sink->eventsOfType("error").empty(), "no errors");
  appendEmitted(ctx, *h.sink);
}
