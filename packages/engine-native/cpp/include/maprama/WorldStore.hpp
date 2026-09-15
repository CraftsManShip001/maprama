// Maprama native core — WorldData v1 storage (world.ts).
//
// Holds the loaded world and its projection. Parsing validates with the exact
// `validateWorldData` rules (same error strings) and then converts to typed
// structs. A failed load keeps the previously loaded world.
#pragma once

#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/Projection.hpp"
#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

struct Road {
  std::string id;
  std::optional<std::string> name;
  RoadClass cls = RoadClass::Local;
  std::optional<bool> bridge;
  /// Polyline `[x, z]` world units, >= 2 vertices.
  std::vector<Vec2> pts;
};

struct BuildingFootprint {
  std::string id;
  /// Ring `[x, z]` world units, not closed, >= 3 vertices. Winding: positive shoelace area over the stored
  /// `[x, z]` values (counter-clockwise in x/z; appears clockwise on a north-up map because z = -north).
  std::vector<Vec2> footprint;
  /// World units, before the theme's `heightScale`.
  double height = 0.0;
  std::optional<double> levels;
  std::optional<BuildingKind> kind;
  std::optional<std::string> name;
};

struct Park {
  std::optional<std::string> name;
  std::vector<Vec2> poly;
};

struct Poi {
  std::string id;
  std::string name;
  PoiCategory cat = PoiCategory::Plaza;
  double x = 0.0;
  double z = 0.0;
};

struct Station {
  std::string id;
  std::string name;
  double x = 0.0;
  double z = 0.0;
};

struct District {
  std::string name;
  double x = 0.0;
  double z = 0.0;
  std::optional<bool> water;
};

struct WorldBounds {
  double minX = 0.0;
  double minZ = 0.0;
  double maxX = 0.0;
  double maxZ = 0.0;
};

/// `WorldData` v1.
struct WorldData {
  int version = 1;
  std::string name;
  LngLat origin;
  double unitMeters = kDefaultUnitMeters;
  WorldBounds bounds;
  std::vector<Road> roads;
  std::vector<BuildingFootprint> buildings;
  std::vector<std::vector<Vec2>> water;
  std::vector<Park> parks;
  std::vector<Poi> pois;
  std::vector<Station> stations;
  std::vector<District> districts;
  std::optional<WorldPoint> plaza;
  std::vector<std::string> attribution;
};

/// Summary of a successful load. `warnings` are non-fatal semantic issues
/// (duplicate ids, inverted bounds, negative footprint winding) that the schema does not reject.
struct WorldLoadReport {
  std::size_t roads = 0;
  std::size_t buildings = 0;
  std::size_t water = 0;
  std::size_t parks = 0;
  std::size_t pois = 0;
  std::size_t stations = 0;
  std::size_t districts = 0;
  /// Building footprints whose shoelace area over `[x, z]` is negative (wrong winding; the extruder flips them).
  std::size_t negativeAreaFootprints = 0;
  std::vector<std::string> warnings;
};

/// Twice the signed shoelace area of a ring over its stored `[x, z]` values (positive = expected winding).
double shoelaceArea2(const std::vector<Vec2>& ring);

class WorldStore {
 public:
  virtual ~WorldStore() = default;

  /// Parses JSON text (`$: invalid JSON: ...` on syntax errors), validates and loads.
  virtual Result<WorldLoadReport> loadJson(std::string_view text) = 0;
  /// Validates (`validateWorldData` rules) and loads an already-parsed value.
  virtual Result<WorldLoadReport> load(const json::Value& worldData) = 0;

  virtual bool loaded() const = 0;
  /// nullptr until a world is loaded.
  virtual const WorldData* world() const = 0;
  /// Projection built from the world's `origin` / `unitMeters`; nullptr until loaded.
  virtual const Projection* projection() const = 0;

  /// First building / road with this id (ids should be unique; duplicates produce a warning).
  virtual const BuildingFootprint* findBuilding(std::string_view id) const = 0;
  virtual const Road* findRoad(std::string_view id) const = 0;

  virtual void clear() = 0;
};

std::unique_ptr<WorldStore> createWorldStore();

}  // namespace maprama
