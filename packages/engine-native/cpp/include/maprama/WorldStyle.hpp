// Maprama native core — WorldData + theme -> MapLibre style JSON (v8), M1 flat map + M2a diorama look.
//
// The style carries the world as inline GeoJSON sources (lng/lat through `Projection`), so both
// platform adapters render the exact same map from one string. Sources are built once per world;
// layers are rebuilt from a `MapLook` (resolved theme, time of day) and the building overrides, and the
// session sends only the paint properties that changed (`MapAdapter::setPaintProperties`).
//
// Draw order: background, world area (ground), parks, water, roads by class (casings = sidewalks),
// arterial centre lines, POI / station discs, the captured-building ring, and the 3D buildings as one
// `fill-extrusion` layer (heights in meters, `height · heightScale`), which occludes everything below it.
#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "maprama/MapLook.hpp"
#include "maprama/Projection.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/json.hpp"

namespace maprama {

/// Style source ids (`maprama-*`) and layer ids.
namespace world_style {
inline constexpr const char* kSourceArea = "maprama-area";
inline constexpr const char* kSourceWater = "maprama-water";
inline constexpr const char* kSourceParks = "maprama-parks";
inline constexpr const char* kSourceRoads = "maprama-roads";
inline constexpr const char* kSourceBuildings = "maprama-buildings";
inline constexpr const char* kSourcePois = "maprama-pois";
inline constexpr const char* kSourceStations = "maprama-stations";
/// The 3D building layer queried for `building:press`.
inline constexpr const char* kLayerBuildings = "buildings";
inline constexpr const char* kLayerCapturedRing = "buildings-captured";
/// engine-web minimum building height (world units) and degenerate-footprint threshold (world units²).
inline constexpr double kMinBuildingHeightUnits = 0.2;
inline constexpr double kMinFootprintArea = 0.01;
}  // namespace world_style

/// A building engine-web renders (footprint area >= `kMinFootprintArea`), in world order.
struct RenderedBuilding {
  /// Index into `WorldData::buildings`.
  std::size_t worldIndex = 0;
  /// engine-web `idx` (index among rendered buildings; seeds the urban color scheme).
  std::size_t index = 0;
  /// engine-web `ci`: `hashId(id) % 6` (palette index).
  std::uint32_t ci = 0;
};

std::vector<RenderedBuilding> renderedBuildings(const WorldData& world);

/// Building paint inputs: final colors of overridden buildings and the captured ones.
struct BuildingPaint {
  std::vector<std::pair<std::string, std::uint32_t>> colors;
  std::vector<std::string> captured;
};

/// The `sources` object (inline GeoJSON). Building features carry `id`, `height` (meters), `ci`, `si`.
json::Value buildWorldSources(const WorldData& world, const Projection& projection, const std::vector<RenderedBuilding>& buildings);
/// The `layers` array for a look and building paint.
json::Value buildWorldLayers(const WorldData& world, const MapLook& look, const BuildingPaint& paint);
/// The style root `light` object.
json::Value lightValue(const MapLight& light);
/// `{version: 8, name, sources, layers, light}`.
json::Value composeStyle(json::Value sources, json::Value layers, const MapLight& light);

/// Full style with the default theme (`realistic`, `day`) and no overrides (tests, M1 callers).
json::Value buildWorldStyleValue(const WorldData& world, const Projection& projection);
/// `buildWorldStyleValue` serialised with `json::stringify`.
std::string buildWorldStyle(const WorldData& world, const Projection& projection);
/// Style shown before a world is loaded: only the background layer.
std::string buildEmptyStyle();

}  // namespace maprama
