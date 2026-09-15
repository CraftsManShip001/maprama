// Maprama native core — procedural worlds (port of engine-web `src/world/town.ts`, `grid.ts`, `shapes.ts`
// and the `polygon.ts` helpers they use).
//
// `buildTownWorld` / `buildGridWorld` reproduce engine-web's generators for the same seed: the mulberry32
// PRNG is ported exactly, every random draw happens in the same order, and the double arithmetic keeps
// V8's operation order (no FMA contraction, `js_math` round/hypot). The C++ conformance suite compares
// the output against worlds exported from engine-web's built generators (`procedural.json`, DESIGN.md
// §6.8). `proceduralWorldData` converts a generated world into WorldData v1 so it follows the exact same
// load → style path as `data` worlds (MapSession `init`).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/RoadGraph.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

/// Massing variants of rectangular lots (engine-web `MassShape`).
enum class MassShape : std::uint8_t { Box, Podium, Setback, L, Twin };
std::string_view massShapeName(MassShape shape);

/// One generated building (engine-web `BuildingModel` for rectangular lots).
struct ProceduralBuilding {
  std::string id;
  int idx = 0;
  /// Rectangle centre.
  double x = 0.0;
  double z = 0.0;
  /// Rotation around y (`Object3D.rotation.y`), radians.
  double yaw = 0.0;
  /// Rectangle size (local x / local z).
  double w = 0.0;
  double d = 0.0;
  /// `rectCorners(x, z, yaw, w, d)`: 4 vertices, positive shoelace area.
  std::vector<Vec2> footprint;
  /// Height in world units (before the theme's height scale).
  double h = 0.0;
  BuildingKind kind = BuildingKind::Office;
  RoofShape roof = RoofShape::Flat;
  /// Palette index 0..5.
  int ci = 0;
  bool sign = false;
  bool antenna = false;
  bool garden = false;
  MassShape autoShape = MassShape::Box;
  bool landmark = false;
};

/// A ground ribbon (polyline with width): the town river and its banks.
struct ProceduralRibbon {
  std::vector<Vec2> pts;
  double width = 0.0;
};

/// Raised block pad of the grid layout.
struct ProceduralGridBlock {
  enum class Kind : std::uint8_t { City, Plaza, Park };
  double cx = 0.0;
  double cz = 0.0;
  Kind kind = Kind::City;
  int bi = 0;
  int bj = 0;
};
std::string_view gridBlockKindName(ProceduralGridBlock::Kind kind);

struct ProceduralTree {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double s = 1.0;
  bool noOutline = false;
};

struct ProceduralPlaza {
  double x = 0.0;
  double z = 0.0;
  double radius = 0.0;
};

/// A generated world (the fields of engine-web's `WorldModel` the generators fill).
struct ProceduralWorld {
  ProceduralLayout layout = ProceduralLayout::Town;
  std::string name;
  LngLat origin;
  double unitMeters = 8.0;
  WorldBounds bounds;
  /// `graph.roads` are the generated road polylines (engine-web draws `graph.edges`).
  RoadGraph graph;
  std::vector<ProceduralBuilding> buildings;
  std::vector<ProceduralRibbon> waterRibbons;
  std::vector<ProceduralRibbon> banks;
  /// Paved landuse polygons.
  std::vector<std::vector<Vec2>> pads;
  std::vector<Park> parks;
  std::optional<ProceduralPlaza> plaza;
  std::vector<ProceduralGridBlock> gridBlocks;
  std::vector<ProceduralTree> sceneryTrees;
  /// `grass` (grid) or `lawn` (town).
  std::string ground;
  double buildingBaseY = 0.0;
  std::vector<Poi> pois;
  std::vector<Station> stations;
  std::vector<District> districts;
  /// Default camera / player start (engine-web `loadWorld` targets it).
  WorldPoint start;
  std::vector<Vec2> spawn;
  std::vector<Vec2> loopWays;
};

/// engine-web `PROCEDURAL_ORIGIN` (Seoul City Hall).
inline constexpr LngLat kProceduralOrigin{126.978, 37.5665};

/// Town river centreline z at x (engine-web `riverZ`).
double townRiverZ(double x);

/// engine-web `buildTownWorld(seed)`: organic streets around a river, bridges, parks, plaza, frontage
/// buildings plus block infill.
ProceduralWorld buildTownWorld(double seed = 0);
/// engine-web `buildGridWorld(seed)`: 9x9 street grid, 8x8 blocks, plaza with the landmark, two parks.
ProceduralWorld buildGridWorld(double seed = 0);
ProceduralWorld buildProceduralWorld(ProceduralLayout layout, double seed = 0);

/// Converts a generated world into a WorldData v1 value (passes `validateWorldData`):
/// roads = the generated polylines, buildings = lot footprints with height and kind, water = the river
/// ribbon as a polygon (+ grid park ponds), parks = the river banks, the named town parks and the grid
/// park blocks, and the POIs / stations / districts / plaza unchanged. Look-only attributes (roof, palette,
/// decorations, massing, scenery trees, pads, grid block pads) stay on `ProceduralWorld` for M2c.
json::Value proceduralWorldData(const ProceduralWorld& world);

}  // namespace maprama
