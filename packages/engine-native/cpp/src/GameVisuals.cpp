#include "maprama/GameVisuals.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <utility>

#include "maprama/CameraMath.hpp"
#include "maprama/MapLook.hpp"
#include "maprama/WorldStyle.hpp"

namespace maprama {

namespace {

using json::Value;

constexpr double kPi = 3.14159265358979323846;

/// engine-web `ROUTE_COLORS` (travel.ts) in `TravelMode` order: [colour, opacity].
constexpr std::array<std::uint32_t, 5> kRouteColors{kAccentColor, 0x12A38A, 0xFF7A59, 0x4DA3FF, 0x2E9E6B};
constexpr std::array<double, 5> kRouteOpacity{1.0, 1.0, 1.0, 0.7, 0.85};
/// engine-web `LocationPuck` colours.
constexpr std::uint32_t kPuckAccuracyColor = 0x3F7BFF;
constexpr std::uint32_t kPuckDotColor = 0x2F6BFF;
/// engine-web character eye colour, used for the heading dot.
constexpr std::uint32_t kHeadingColor = 0x1E1A24;
constexpr const char* kWhite = "#FFFFFF";

Value lngLatArray(const LngLat& ll) { return Value::array({ll.lng, ll.lat}); }

Value feature(Value geometry, Value properties) {
  return Value::object({{"type", "Feature"}, {"properties", std::move(properties)}, {"geometry", std::move(geometry)}});
}

Value pointGeometry(const LngLat& at) { return Value::object({{"type", "Point"}, {"coordinates", lngLatArray(at)}}); }

Value closedRing(const std::vector<LngLat>& ring) {
  Value coords = Value::array();
  for (const LngLat& p : ring) coords.push(lngLatArray(p));
  if (!ring.empty()) coords.push(lngLatArray(ring.front()));
  return coords;
}

Value polygonGeometry(const std::vector<std::vector<LngLat>>& rings) {
  Value coords = Value::array();
  for (const std::vector<LngLat>& ring : rings) coords.push(closedRing(ring));
  return Value::object({{"type", "Polygon"}, {"coordinates", std::move(coords)}});
}

std::vector<LngLat> toLngLat(const std::vector<Vec2>& ring, const Projection& projection) {
  std::vector<LngLat> out;
  out.reserve(ring.size());
  for (const Vec2& p : ring) out.push_back(projection.toLngLat(WorldPoint{p[0], p[1]}));
  return out;
}

/// Disc (hole = 0) or annulus polygon; the hole winds opposite to the outer ring (MapLibre classifies the
/// rings of a polygon by winding relative to its first ring).
Value discGeometry(const Projection& projection, double x, double z, double outer, double hole, int segments) {
  std::vector<std::vector<LngLat>> rings{toLngLat(circleRing(x, z, outer, segments), projection)};
  if (hole > 0) {
    std::vector<LngLat> inner = toLngLat(circleRing(x, z, hole, segments), projection);
    std::reverse(inner.begin(), inner.end());
    rings.push_back(std::move(inner));
  }
  return polygonGeometry(rings);
}

std::string collection(Value features) {
  return json::stringify(Value::object({{"type", "FeatureCollection"}, {"features", std::move(features)}}));
}

Value source() {
  return Value::object({{"type", "geojson"},
                        {"data", Value::object({{"type", "FeatureCollection"}, {"features", Value::array()}})}});
}

Value getProperty(const char* key) { return Value::array({"get", key}); }

Value partFilter(const char* key, const char* part) { return Value::array({"==", getProperty(key), part}); }

/// `["match", ["get", "mode"], "walk", v0, …, v0]` over a per-mode table.
template <class T, class F>
Value modeMatch(const std::array<T, 5>& table, F&& value) {
  Value expr = Value::array({"match", getProperty("mode")});
  for (std::size_t i = 0; i < table.size(); ++i) {
    expr.push(std::string(EnumNames<TravelMode>::values[i]));
    expr.push(value(table[i]));
  }
  expr.push(value(table[0]));
  return expr;
}

Value layer(const char* id, const char* type, const char* src, Value filter, Value paint, Value layout = Value()) {
  Value l = Value::object({{"id", id}, {"type", type}, {"source", src}});
  if (!filter.isNull()) l.set("filter", std::move(filter));
  if (!layout.isNull()) l.set("layout", std::move(layout));
  l.set("paint", std::move(paint));
  return l;
}

std::ptrdiff_t indexOfLayer(const std::vector<Value>& items, const char* id) {
  for (std::size_t i = 0; i < items.size(); ++i) {
    const Value* v = items[i].find("id");
    if (v != nullptr && v->isString() && v->asString() == id) return static_cast<std::ptrdiff_t>(i);
  }
  return -1;
}

}  // namespace

Value groundSizeExpression(double meters, double minPx, double lat, const char* scaleProperty) {
  Value expr = Value::array({"interpolate", Value::array({"exponential", 2}), Value::array({"zoom"})});
  for (int z = 12; z <= 22; ++z) {
    const double px = std::max(minPx, meters / camera_math::mapLibreMetersPerPixel(z, lat));
    expr.push(z);
    if (scaleProperty != nullptr) {
      expr.push(Value::array({"*", getProperty(scaleProperty), px}));
    } else {
      expr.push(px);
    }
  }
  return expr;
}

Value gameSources() {
  Value sources = Value::object();
  for (const char* id : {game_style::kSourceFences, game_style::kSourceRoute, game_style::kSourcePuck, game_style::kSourceDrops,
                         game_style::kSourceCharacters}) {
    sources.set(id, source());
  }
  return sources;
}

void insertGameLayers(Value& layers, double lat, double unitMeters) {
  namespace gs = game_style;
  const Value accent(cssHex(kAccentColor));
  const auto routeColor = [](std::uint32_t c) { return Value(cssHex(c)); };
  const auto routeOpacity = [](double o) { return Value(o); };

  std::vector<Value> ground;
  ground.push_back(layer(gs::kLayerFenceFill, "fill", gs::kSourceFences, partFilter("part", "fill"),
                         Value::object({{"fill-color", accent}, {"fill-opacity", 0.07}})));
  ground.push_back(layer(gs::kLayerFenceRing, "fill", gs::kSourceFences, partFilter("part", "ring"),
                         Value::object({{"fill-color", accent}, {"fill-opacity", 0.85}})));
  ground.push_back(layer(gs::kLayerRouteRings, "fill", gs::kSourceRoute, partFilter("part", "ring"),
                         Value::object({{"fill-color", modeMatch(kRouteColors, routeColor)},
                                        {"fill-opacity", modeMatch(kRouteOpacity, routeOpacity)}})));
  ground.push_back(layer(gs::kLayerRoute, "line", gs::kSourceRoute, partFilter("part", "line"),
                         Value::object({{"line-color", modeMatch(kRouteColors, routeColor)},
                                        {"line-opacity", modeMatch(kRouteOpacity, routeOpacity)},
                                        {"line-width", groundSizeExpression(0.5 * unitMeters, 3.0, lat)}}),
                         Value::object({{"line-cap", "round"}, {"line-join", "round"}})));
  ground.push_back(layer(gs::kLayerPuckAccuracy, "fill", gs::kSourcePuck, partFilter("part", "accuracy"),
                         Value::object({{"fill-color", cssHex(kPuckAccuracyColor)}, {"fill-opacity", 0.14}})));

  std::vector<Value> top;
  top.push_back(layer(gs::kLayerRoutePin, "circle", gs::kSourceRoute, partFilter("part", "pin"),
                      Value::object({{"circle-radius", groundSizeExpression(0.42 * unitMeters, 6.0, lat)},
                                     {"circle-color", accent},
                                     {"circle-stroke-color", kWhite},
                                     {"circle-stroke-width", 2.5},
                                     {"circle-pitch-alignment", "map"}})));
  const Value fade = Value::array({"-", 1, getProperty("pop")});
  top.push_back(layer(gs::kLayerDrops, "circle", gs::kSourceDrops, Value(),
                      Value::object({{"circle-radius", groundSizeExpression(0.5 * unitMeters, 5.0, lat, "size")},
                                     {"circle-color", Value::array({"to-color", getProperty("color")})},
                                     {"circle-opacity", fade},
                                     {"circle-stroke-color", kWhite},
                                     {"circle-stroke-width", 1.5},
                                     {"circle-stroke-opacity", fade},
                                     {"circle-pitch-alignment", "map"}})));
  top.push_back(layer(gs::kLayerPuck, "circle", gs::kSourcePuck, partFilter("part", "dot"),
                      Value::object({{"circle-radius", groundSizeExpression(0.8 * unitMeters, 9.0, lat)},
                                     {"circle-color", cssHex(kPuckDotColor)},
                                     {"circle-stroke-color", kWhite},
                                     {"circle-stroke-width", 3},
                                     {"circle-pitch-alignment", "map"}})));
  top.push_back(layer(gs::kLayerCharacters, "circle", gs::kSourceCharacters, partFilter("kind", "body"),
                      Value::object({{"circle-radius", groundSizeExpression(0.55 * unitMeters, 6.0, lat, "scale")},
                                     {"circle-color", Value::array({"to-color", getProperty("color")})},
                                     {"circle-stroke-color", Value::array({"to-color", getProperty("ring")})},
                                     {"circle-stroke-width",
                                      Value::array({"case", Value::array({"==", getProperty("player"), true}), 2.5, 1.5})},
                                     {"circle-pitch-alignment", "map"}})));
  top.push_back(layer(gs::kLayerCharacterHeading, "circle", gs::kSourceCharacters, partFilter("kind", "heading"),
                      Value::object({{"circle-radius", groundSizeExpression(0.2 * unitMeters, 2.2, lat, "scale")},
                                     {"circle-color", cssHex(kHeadingColor)},
                                     {"circle-pitch-alignment", "map"}})));

  std::vector<Value>& items = layers.items();
  std::ptrdiff_t at = indexOfLayer(items, world_style::kLayerCapturedRing);
  if (at < 0) at = indexOfLayer(items, world_style::kLayerBuildings);
  if (at < 0) at = static_cast<std::ptrdiff_t>(items.size());
  items.insert(items.begin() + at, std::make_move_iterator(ground.begin()), std::make_move_iterator(ground.end()));
  std::ptrdiff_t after = indexOfLayer(items, world_style::kLayerBuildings);
  after = after < 0 ? static_cast<std::ptrdiff_t>(items.size()) : after + 1;
  items.insert(items.begin() + after, std::make_move_iterator(top.begin()), std::make_move_iterator(top.end()));
}

std::vector<Vec2> circleRing(double x, double z, double r, int segments) {
  std::vector<Vec2> ring;
  ring.reserve(static_cast<std::size_t>(segments));
  for (int i = 0; i < segments; ++i) {
    const double a = 2.0 * kPi * static_cast<double>(i) / static_cast<double>(segments);
    ring.push_back(Vec2{x + r * std::cos(a), z + r * std::sin(a)});
  }
  return ring;
}

std::string emptyFeatureCollection() { return collection(Value::array()); }

std::string fencesGeoJson(const std::vector<WorldFence>& fences, const Projection& projection) {
  Value features = Value::array();
  for (const WorldFence& f : fences) {
    if (!(f.r > 0)) continue;
    const double w = std::min(0.35, f.r * 0.2);
    const double inner = std::max(0.01, f.r - w);
    features.push(feature(discGeometry(projection, f.x, f.z, inner, 0, game_style::kFenceSegments),
                          Value::object({{"part", "fill"}, {"id", f.id}})));
    features.push(feature(discGeometry(projection, f.x, f.z, f.r, inner, game_style::kFenceSegments),
                          Value::object({{"part", "ring"}, {"id", f.id}})));
  }
  return collection(std::move(features));
}

std::string routeGeoJson(const std::vector<std::vector<PlannedLeg>>& routes, const Projection& projection) {
  Value features = Value::array();
  for (const std::vector<PlannedLeg>& legs : routes) {
    for (const PlannedLeg& leg : legs) {
      if (leg.pts.size() < 2) continue;
      const std::string mode(enumName(leg.mode));
      Value coords = Value::array();
      for (const WorldPoint& p : leg.pts) coords.push(lngLatArray(projection.toLngLat(p)));
      features.push(feature(Value::object({{"type", "LineString"}, {"coordinates", std::move(coords)}}),
                            Value::object({{"part", "line"}, {"mode", mode}})));
      if (leg.mode == TravelMode::Subway) {
        for (const WorldPoint& p : {leg.pts.front(), leg.pts.back()}) {
          features.push(feature(discGeometry(projection, p.x, p.z, 1.05, 0.7, 32), Value::object({{"part", "ring"}, {"mode", mode}})));
        }
      }
    }
    if (!legs.empty() && !legs.back().pts.empty()) {
      features.push(feature(pointGeometry(projection.toLngLat(legs.back().pts.back())), Value::object({{"part", "pin"}})));
    }
  }
  return collection(std::move(features));
}

std::string dropsGeoJson(const std::vector<DropVisual>& drops) {
  Value features = Value::array();
  for (const DropVisual& d : drops) {
    const double pop = std::clamp(d.pop, 0.0, 1.0);
    features.push(feature(pointGeometry(d.position),
                          Value::object({{"layer", d.layerId},
                                         {"id", d.dropId},
                                         {"color", cssHex(game_style::kRarityColors[static_cast<std::size_t>(d.rarity)])},
                                         {"pop", pop},
                                         {"size", 1.0 + pop * 0.6}})));
  }
  return collection(std::move(features));
}

std::string charactersGeoJson(const std::vector<CharacterVisual>& characters) {
  Value features = Value::array();
  for (const CharacterVisual& c : characters) {
    const std::uint32_t ring = c.mode == TravelMode::Walk ? 0xFFFFFF : kRouteColors[static_cast<std::size_t>(c.mode)];
    features.push(feature(pointGeometry(c.position), Value::object({{"kind", "body"},
                                                                    {"id", c.id},
                                                                    {"color", cssHex(c.color)},
                                                                    {"ring", cssHex(ring)},
                                                                    {"scale", c.scale},
                                                                    {"player", c.isPlayer},
                                                                    {"mode", std::string(enumName(c.mode))}})));
  }
  // Heading dots after every body, so a dot is never hidden under a neighbour's body.
  for (const CharacterVisual& c : characters) {
    features.push(feature(pointGeometry(c.heading), Value::object({{"kind", "heading"}, {"id", c.id}, {"scale", c.scale}})));
  }
  return collection(std::move(features));
}

std::string puckGeoJson(const std::optional<PuckVisual>& puck) {
  Value features = Value::array();
  if (puck) {
    if (puck->accuracy && puck->accuracy->size() >= 3) {
      features.push(feature(polygonGeometry({*puck->accuracy}), Value::object({{"part", "accuracy"}})));
    }
    features.push(feature(pointGeometry(puck->position), Value::object({{"part", "dot"}})));
  }
  return collection(std::move(features));
}

}  // namespace maprama
