#include "maprama/WorldStyle.hpp"

#include <cmath>
#include <string>
#include <utility>
#include <vector>

#include "maprama/CameraMath.hpp"

namespace maprama {

namespace {

using json::Value;

// engine-web zoom-out MAP_COLORS (flat map look) plus building / POI colors for the M1 map.
constexpr const char* kBackground = "#E4DFD6";
constexpr const char* kGround = "#EEEAE2";
constexpr const char* kWater = "#9CCBEB";
constexpr const char* kPark = "#C4E2B2";
constexpr const char* kArterial = "#F7C45C";
constexpr const char* kArterialCasing = "#D99A32";
constexpr const char* kLocal = "#FFFFFF";
constexpr const char* kLocalCasing = "#D6D0C4";
constexpr const char* kAlley = "#F3F0EA";
constexpr const char* kBuilding = "#DAD4CA";
constexpr const char* kBuildingOutline = "#B9B0A2";
constexpr const char* kStation = "#2F5BEA";

// engine-web `ROAD_W` (world units) x 1.1 as in the zoom-out map; the arterial casing adds 0.7 units.
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

Value roadLayer(const std::string& id, RoadClass cls, const char* color, double meters, double lat) {
  return Value::object({
      {"id", id},
      {"type", "line"},
      {"source", world_style::kSourceRoads},
      {"filter", Value::array({"==", Value::array({"get", "cls"}), std::string(enumName(cls))})},
      {"layout", Value::object({{"line-cap", "round"}, {"line-join", "round"}})},
      {"paint", Value::object({{"line-color", color}, {"line-width", metersLineWidth(meters, lat)}})},
  });
}

Value backgroundLayer() {
  return Value::object({{"id", "background"}, {"type", "background"}, {"paint", Value::object({{"background-color", kBackground}})}});
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

}  // namespace

Value buildWorldStyleValue(const WorldData& world, const Projection& projection) {
  const double lat = world.origin.lat;
  const double unit = world.unitMeters;
  Value style = styleShell();
  Value& sources = *style.find("sources");
  Value& layers = *style.find("layers");

  // Diorama area (world bounds) drawn in the ground color over the background.
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
    for (const BuildingFootprint& b : world.buildings) {
      Value props = Value::object({{"id", b.id}, {"height", b.height * unit}});
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

  layers.push(backgroundLayer());
  layers.push(Value::object({{"id", "area"}, {"type", "fill"}, {"source", world_style::kSourceArea},
                             {"paint", Value::object({{"fill-color", kGround}})}}));
  layers.push(Value::object({{"id", "parks"}, {"type", "fill"}, {"source", world_style::kSourceParks},
                             {"paint", Value::object({{"fill-color", kPark}})}}));
  layers.push(Value::object({{"id", "water"}, {"type", "fill"}, {"source", world_style::kSourceWater},
                             {"paint", Value::object({{"fill-color", kWater}})}}));
  const double arterial = roadWidthUnits(RoadClass::Arterial) * unit;
  const double local = roadWidthUnits(RoadClass::Local) * unit;
  const double alley = roadWidthUnits(RoadClass::Alley) * unit;
  layers.push(roadLayer("roads-alley", RoadClass::Alley, kAlley, alley, lat));
  layers.push(roadLayer("roads-local-casing", RoadClass::Local, kLocalCasing, local + 0.5 * unit, lat));
  layers.push(roadLayer("roads-local", RoadClass::Local, kLocal, local, lat));
  layers.push(roadLayer("roads-arterial-casing", RoadClass::Arterial, kArterialCasing, arterial + 0.7 * unit, lat));
  layers.push(roadLayer("roads-arterial", RoadClass::Arterial, kArterial, arterial, lat));
  layers.push(Value::object({{"id", "buildings"}, {"type", "fill"}, {"source", world_style::kSourceBuildings},
                             {"paint", Value::object({{"fill-color", kBuilding}, {"fill-outline-color", kBuildingOutline}})}}));
  layers.push(Value::object({
      {"id", "pois"},
      {"type", "circle"},
      {"source", world_style::kSourcePois},
      {"paint", Value::object({
                    {"circle-radius", 4.5},
                    {"circle-color",
                     Value::array({"match", Value::array({"get", "cat"}), "cafe", "#B7773B", "store", "#D0508A", "music",
                                   "#7B4FD6", "school", "#E0A100", "book", "#3E8E7E", "park", "#4F9A46", "subway",
                                   kStation, "#7A8594"})},
                    {"circle-stroke-width", 1.5},
                    {"circle-stroke-color", "#FFFFFF"},
                    // Flat map: discs lie in the ground plane (viewport-aligned billboards lose their near
                    // half to clipping on pitched cameras with the M1 SDKs).
                    {"circle-pitch-alignment", "map"},
                })},
  }));
  layers.push(Value::object({
      {"id", "stations"},
      {"type", "circle"},
      {"source", world_style::kSourceStations},
      {"paint", Value::object({{"circle-radius", 7}, {"circle-color", kStation}, {"circle-stroke-width", 2.5},
                               {"circle-stroke-color", "#FFFFFF"}, {"circle-pitch-alignment", "map"}})},
  }));
  return style;
}

std::string buildWorldStyle(const WorldData& world, const Projection& projection) {
  return json::stringify(buildWorldStyleValue(world, projection));
}

std::string buildEmptyStyle() {
  Value style = styleShell();
  style.find("layers")->push(backgroundLayer());
  return json::stringify(style);
}

}  // namespace maprama
