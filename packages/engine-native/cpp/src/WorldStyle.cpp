#include "maprama/WorldStyle.hpp"

#include <cmath>
#include <string>
#include <utility>
#include <vector>

#include "maprama/CameraMath.hpp"
#include "maprama/ThemeResolver.hpp"

namespace maprama {

namespace {

using json::Value;

/// Background of the empty style (before a world is loaded).
constexpr const char* kEmptyBackground = "#E4DFD6";
/// Ring drawn around captured buildings (dp).
constexpr double kCapturedRingWidth = 3.0;

// engine-web `ROAD_W` (world units) x 1.1 as in the zoom-out map; casings (sidewalks) add 0.5 / 0.7 units.
double roadWidthUnits(RoadClass cls) {
  switch (cls) {
    case RoadClass::Arterial:
      return 3.0 * 1.1;
    case RoadClass::Local:
      return 2.0 * 1.1;
    case RoadClass::Alley:
      return 1.3 * 1.1;
  }
  return 2.0;
}

Value lngLatArray(const Projection& projection, const Vec2& p) {
  const LngLat ll = projection.toLngLat(WorldPoint{p[0], p[1]});
  return Value::array({ll.lng, ll.lat});
}

Value ring(const Projection& projection, const std::vector<Vec2>& points) {
  Value coords = Value::array();
  for (const Vec2& p : points) coords.push(lngLatArray(projection, p));
  if (!points.empty()) coords.push(lngLatArray(projection, points.front()));  // GeoJSON rings are closed
  return coords;
}

Value feature(Value geometry, Value properties) {
  return Value::object({{"type", "Feature"}, {"properties", std::move(properties)}, {"geometry", std::move(geometry)}});
}

Value polygon(const Projection& projection, const std::vector<Vec2>& points) {
  return Value::object({{"type", "Polygon"}, {"coordinates", Value::array({ring(projection, points)})}});
}

Value point(const Projection& projection, double x, double z) {
  return Value::object({{"type", "Point"}, {"coordinates", lngLatArray(projection, Vec2{x, z})}});
}

Value source(Value features, const std::string& attribution = {}) {
  Value s = Value::object({{"type", "geojson"},
                           {"data", Value::object({{"type", "FeatureCollection"}, {"features", std::move(features)}})}});
  if (!attribution.empty()) s.set("attribution", attribution);
  return s;
}

/// `line-width` (dp) that stays `meters` wide on the ground: exponential base-2 interpolation between
/// two zoom stops is exact because the width in pixels doubles per zoom level.
Value metersLineWidth(double meters, double lat) {
  const double z0 = 10.0;
  const double z1 = 22.0;
  return Value::array({"interpolate",
                       Value::array({"exponential", 2}),
                       Value::array({"zoom"}),
                       z0,
                       meters / camera_math::mapLibreMetersPerPixel(z0, lat),
                       z1,
                       meters / camera_math::mapLibreMetersPerPixel(z1, lat)});
}

Value color(std::uint32_t rgb) { return Value(cssHex(rgb)); }

Value roadLayer(const std::string& id, RoadClass cls, std::uint32_t rgb, double meters, double lat) {
  return Value::object({
      {"id", id},
      {"type", "line"},
      {"source", world_style::kSourceRoads},
      {"filter", Value::array({"==", Value::array({"get", "cls"}), std::string(enumName(cls))})},
      {"layout", Value::object({{"line-cap", "round"}, {"line-join", "round"}})},
      {"paint", Value::object({{"line-color", color(rgb)}, {"line-width", metersLineWidth(meters, lat)}})},
  });
}

Value fillLayer(const char* id, const char* src, std::uint32_t rgb) {
  return Value::object({{"id", id}, {"type", "fill"}, {"source", src}, {"paint", Value::object({{"fill-color", color(rgb)}})}});
}

Value backgroundLayer(const std::string& rgb) {
  return Value::object({{"id", "background"}, {"type", "background"}, {"paint", Value::object({{"background-color", rgb}})}});
}

Value styleShell() {
  return Value::object({{"version", 8}, {"name", "maprama-world"}, {"sources", Value::object()}, {"layers", Value::array()}});
}

std::string joinAttribution(const std::vector<std::string>& attribution) {
  std::string out;
  for (const std::string& a : attribution) {
    if (!out.empty()) out += " | ";
    out += a;
  }
  return out;
}

/// `["match", ["get", key], 0, c0, 1, c1, …, c0]` over a color table.
template <std::size_t N>
Value indexedColor(const char* key, const std::array<std::uint32_t, N>& colors) {
  Value expr = Value::array({"match", Value::array({"get", key})});
  for (std::size_t i = 0; i < N; ++i) {
    expr.push(static_cast<double>(i));
    expr.push(color(colors[i]));
  }
  expr.push(color(colors[0]));
  return expr;
}

// `match` branches use one literal label per building id (never label arrays): the iOS SDK round-trips
// paint values through NSExpression, which does not preserve array labels reliably.

/// Building color: overrides by id (in the caller's order), else the theme color.
Value buildingColor(const MapLook& look, const BuildingPaint& paint) {
  Value themed = look.schemeTints ? indexedColor("si", *look.schemeTints) : indexedColor("ci", look.palette);
  if (paint.colors.empty()) return themed;
  Value expr = Value::array({"match", Value::array({"get", "id"})});
  for (const auto& [id, rgb] : paint.colors) {
    expr.push(id);
    expr.push(color(rgb));
  }
  expr.push(std::move(themed));
  return expr;
}

Value capturedOpacity(const BuildingPaint& paint) {
  if (paint.captured.empty()) return Value(0);
  Value expr = Value::array({"match", Value::array({"get", "id"})});
  for (const std::string& id : paint.captured) {
    expr.push(id);
    expr.push(1);
  }
  expr.push(0);
  return expr;
}

}  // namespace

std::vector<RenderedBuilding> renderedBuildings(const WorldData& world) {
  std::vector<RenderedBuilding> out;
  out.reserve(world.buildings.size());
  for (std::size_t i = 0; i < world.buildings.size(); ++i) {
    const BuildingFootprint& b = world.buildings[i];
    if (std::fabs(shoelaceArea2(b.footprint)) / 2.0 < world_style::kMinFootprintArea) continue;
    out.push_back(RenderedBuilding{i, out.size(), hashId(b.id) % 6u});
  }
  return out;
}

Value buildWorldSources(const WorldData& world, const Projection& projection, const std::vector<RenderedBuilding>& buildings) {
  const double unit = world.unitMeters;
  Value sources = Value::object();
  {
    const WorldBounds& b = world.bounds;
    std::vector<Vec2> area{{b.minX, b.minZ}, {b.maxX, b.minZ}, {b.maxX, b.maxZ}, {b.minX, b.maxZ}};
    Value features = Value::array({feature(polygon(projection, area), Value::object({{"name", world.name}}))});
    sources.set(world_style::kSourceArea, source(std::move(features), joinAttribution(world.attribution)));
  }
  {
    Value features = Value::array();
    for (const std::vector<Vec2>& w : world.water) features.push(feature(polygon(projection, w), Value::object()));
    sources.set(world_style::kSourceWater, source(std::move(features)));
  }
  {
    Value features = Value::array();
    for (const Park& p : world.parks) {
      Value props = Value::object();
      if (p.name) props.set("name", *p.name);
      features.push(feature(polygon(projection, p.poly), std::move(props)));
    }
    sources.set(world_style::kSourceParks, source(std::move(features)));
  }
  {
    Value features = Value::array();
    for (const Road& r : world.roads) {
      Value coords = Value::array();
      for (const Vec2& p : r.pts) coords.push(lngLatArray(projection, p));
      Value props = Value::object({{"id", r.id}, {"cls", std::string(enumName(r.cls))}});
      if (r.name) props.set("name", *r.name);
      features.push(feature(Value::object({{"type", "LineString"}, {"coordinates", std::move(coords)}}), std::move(props)));
    }
    sources.set(world_style::kSourceRoads, source(std::move(features)));
  }
  {
    Value features = Value::array();
    for (const RenderedBuilding& rb : buildings) {
      const BuildingFootprint& b = world.buildings[rb.worldIndex];
      // engine-web: height = max(0.2, height) world units; the theme's heightScale is applied by the layer.
      const double meters = std::max(world_style::kMinBuildingHeightUnits, b.height) * unit;
      Value props = Value::object({{"id", b.id},
                                   {"height", meters},
                                   {"ci", static_cast<double>(rb.ci)},
                                   {"si", static_cast<double>(rb.index % 5)}});
      if (b.levels) props.set("levels", *b.levels);
      if (b.kind) props.set("kind", std::string(enumName(*b.kind)));
      if (b.name) props.set("name", *b.name);
      features.push(feature(polygon(projection, b.footprint), std::move(props)));
    }
    sources.set(world_style::kSourceBuildings, source(std::move(features)));
  }
  {
    Value features = Value::array();
    for (const Poi& p : world.pois) {
      features.push(feature(point(projection, p.x, p.z),
                            Value::object({{"id", p.id}, {"name", p.name}, {"cat", std::string(enumName(p.cat))}})));
    }
    sources.set(world_style::kSourcePois, source(std::move(features)));
  }
  {
    Value features = Value::array();
    for (const Station& s : world.stations) {
      features.push(feature(point(projection, s.x, s.z), Value::object({{"id", s.id}, {"name", s.name}})));
    }
    sources.set(world_style::kSourceStations, source(std::move(features)));
  }
  return sources;
}

Value buildWorldLayers(const WorldData& world, const MapLook& look, const BuildingPaint& paint, const ZoomOutPaint& zoom) {
  const double lat = world.origin.lat;
  const double unit = world.unitMeters;
  Value layers = Value::array();
  layers.push(backgroundLayer(cssHex(look.background)));
  layers.push(fillLayer("area", world_style::kSourceArea, look.ground));
  layers.push(fillLayer("parks", world_style::kSourceParks, look.park));
  layers.push(fillLayer("water", world_style::kSourceWater, look.water));

  const double arterial = roadWidthUnits(RoadClass::Arterial) * unit;
  const double local = roadWidthUnits(RoadClass::Local) * unit;
  const double alley = roadWidthUnits(RoadClass::Alley) * unit;
  layers.push(roadLayer("roads-alley", RoadClass::Alley, look.alley, alley, lat));
  layers.push(roadLayer("roads-local-casing", RoadClass::Local, look.pad, local + 0.5 * unit, lat));
  layers.push(roadLayer("roads-local", RoadClass::Local, look.road, local, lat));
  layers.push(roadLayer("roads-arterial-casing", RoadClass::Arterial, look.pad, arterial + 0.7 * unit, lat));
  layers.push(roadLayer("roads-arterial", RoadClass::Arterial, look.road, arterial, lat));
  {
    Value centre = roadLayer("roads-arterial-centerline", RoadClass::Arterial, look.centerLine, 0.12 * unit, lat);
    centre.find("layout")->set("line-cap", "butt");
    Value& p = *centre.find("paint");
    p.set("line-dasharray", Value::array({3, 3}));
    p.set("line-opacity", look.laneMarkings ? 1 : 0);
    layers.push(std::move(centre));
  }

  // M4 `mapColors` (engine-web `ZoomOutController.buildOverlay`): flat map colours over the ground (the world pad),
  // parks, water and the roads (`ROAD_W · 1.1`, arterial casing + 0.7), faded in to 92 % with the zoom-out factor.
  {
    using namespace world_style;
    const auto overlayFill = [&](const char* id, const char* src, std::uint32_t rgb) {
      Value l = fillLayer(id, src, rgb);
      l.find("paint")->set("fill-opacity", zoom.mapOpacity);
      return l;
    };
    const auto overlayRoad = [&](const char* id, RoadClass cls, std::uint32_t rgb, double meters) {
      Value l = roadLayer(id, cls, rgb, meters, lat);
      l.find("paint")->set("line-opacity", zoom.mapOpacity);
      return l;
    };
    layers.push(overlayFill(kLayerMapGround, kSourceArea, kMapGround));
    layers.push(overlayFill(kLayerMapParks, kSourceParks, kMapPark));
    layers.push(overlayFill(kLayerMapWater, kSourceWater, kMapWater));
    layers.push(overlayRoad(kLayerMapCasing, RoadClass::Arterial, kMapCasing, arterial + 0.7 * unit));
    layers.push(overlayRoad(kLayerMapAlley, RoadClass::Alley, kMapAlley, alley));
    layers.push(overlayRoad(kLayerMapLocal, RoadClass::Local, kMapLocal, local));
    layers.push(overlayRoad(kLayerMapArterial, RoadClass::Arterial, kMapArterial, arterial));
  }

  Value poiColor = Value::array({"match", Value::array({"get", "cat"})});
  for (std::size_t i = 0; i < look.poi.size(); ++i) {
    poiColor.push(std::string(EnumNames<PoiCategory>::values[i]));
    poiColor.push(color(look.poi[i]));
  }
  poiColor.push(color(look.poi[static_cast<std::size_t>(PoiCategory::Plaza)]));
  layers.push(Value::object({
      {"id", "pois"},
      {"type", "circle"},
      {"source", world_style::kSourcePois},
      {"paint", Value::object({
                    {"circle-radius", 4.5},
                    {"circle-color", std::move(poiColor)},
                    {"circle-stroke-width", 1.5},
                    {"circle-stroke-color", color(look.marker)},
                    // Discs lie in the ground plane (viewport-aligned billboards lose their near half to
                    // clipping on pitched cameras with the official SDKs); buildings occlude them.
                    {"circle-pitch-alignment", "map"},
                })},
  }));
  layers.push(Value::object({
      {"id", "stations"},
      {"type", "circle"},
      {"source", world_style::kSourceStations},
      {"paint", Value::object({{"circle-radius", 7}, {"circle-color", color(look.station)}, {"circle-stroke-width", 2.5},
                               {"circle-stroke-color", color(look.marker)}, {"circle-pitch-alignment", "map"}})},
  }));
  layers.push(Value::object({
      {"id", world_style::kLayerCapturedRing},
      {"type", "line"},
      {"source", world_style::kSourceBuildings},
      {"layout", Value::object({{"line-join", "round"}})},
      {"paint", Value::object({{"line-color", color(look.capturedRing)},
                               {"line-width", kCapturedRingWidth},
                               {"line-opacity", capturedOpacity(paint)}})},
  }));
  layers.push(Value::object({
      {"id", world_style::kLayerBuildings},
      {"type", "fill-extrusion"},
      {"source", world_style::kSourceBuildings},
      {"paint", Value::object({
                    {"fill-extrusion-color", buildingColor(look, paint)},
                    {"fill-extrusion-height", Value::array({"*", Value::array({"get", "height"}), look.heightScale * zoom.heightScale})},
                    {"fill-extrusion-base", 0},
                    {"fill-extrusion-vertical-gradient", true},
                })},
  }));
  return layers;
}

std::vector<PaintPropertyChange> zoomOutPaintChanges(Value& layers, const MapLook& look, const ZoomOutPaint& zoom) {
  using namespace world_style;
  std::vector<PaintPropertyChange> out;
  if (!layers.isArray()) return out;
  const auto patch = [&](Value& layer, const char* property, Value value) {
    Value* paint = layer.find("paint");
    if (paint == nullptr) return;
    std::string next = json::stringify(value);
    const Value* old = paint->find(property);
    if (old != nullptr && json::stringify(*old) == next) return;
    paint->set(property, std::move(value));
    out.push_back(PaintPropertyChange{layer.find("id")->asString(), property, std::move(next)});
  };
  for (Value& layer : layers.items()) {
    const Value* idValue = layer.find("id");
    if (idValue == nullptr || !idValue->isString()) continue;
    const std::string id = idValue->asString();
    if (id == kLayerBuildings) {
      patch(layer, "fill-extrusion-height", Value::array({"*", Value::array({"get", "height"}), look.heightScale * zoom.heightScale}));
    } else if (id == kLayerMapGround || id == kLayerMapParks || id == kLayerMapWater) {
      patch(layer, "fill-opacity", Value(zoom.mapOpacity));
    } else if (id == kLayerMapCasing || id == kLayerMapAlley || id == kLayerMapLocal || id == kLayerMapArterial) {
      patch(layer, "line-opacity", Value(zoom.mapOpacity));
    }
  }
  return out;
}

Value lightValue(const MapLight& light) {
  return Value::object({{"anchor", "map"},
                        {"position", Value::array({light.radial, light.azimuthal, light.polar})},
                        {"color", cssHex(light.color)},
                        {"intensity", light.intensity}});
}

Value composeStyle(Value sources, Value layers, const MapLight& light) {
  Value style = styleShell();
  style.set("sources", std::move(sources));
  style.set("layers", std::move(layers));
  style.set("light", lightValue(light));
  return style;
}

Value buildWorldStyleValue(const WorldData& world, const Projection& projection) {
  const ResolvedTheme theme = ThemeResolver::builtIn().resolve(Value::object());
  const MapLook look = mapLookFor(theme);
  return composeStyle(buildWorldSources(world, projection, renderedBuildings(world)), buildWorldLayers(world, look, {}), look.light);
}

std::string buildWorldStyle(const WorldData& world, const Projection& projection) {
  return json::stringify(buildWorldStyleValue(world, projection));
}

std::string buildEmptyStyle() {
  Value style = styleShell();
  style.find("layers")->push(backgroundLayer(kEmptyBackground));
  return json::stringify(style);
}

}  // namespace maprama
