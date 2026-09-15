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

#include "maprama/MapAdapter.hpp"
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
/// M4 `mapColors` overlay (engine-web `ZoomOutController.buildOverlay`, `MAP_COLORS`): above the base ground and
/// roads, below the POI / station discs; `fill-opacity` / `line-opacity` follow the zoom-out factor.
inline constexpr const char* kLayerMapGround = "map-ground";
inline constexpr const char* kLayerMapParks = "map-parks";
inline constexpr const char* kLayerMapWater = "map-water";
inline constexpr const char* kLayerMapCasing = "map-roads-arterial-casing";
inline constexpr const char* kLayerMapAlley = "map-roads-alley";
inline constexpr const char* kLayerMapLocal = "map-roads-local";
inline constexpr const char* kLayerMapArterial = "map-roads-arterial";
/// engine-web `MAP_COLORS`.
inline constexpr std::uint32_t kMapArterial = 0xF7C45C, kMapCasing = 0xD99A32, kMapLocal = 0xFFFFFF, kMapAlley = 0xF3F0EA,
                               kMapGround = 0xEEEAE2, kMapPark = 0xC4E2B2, kMapWater = 0x9CCBEB;
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

/// M4 zoom-out paint (`ZoomOutLook`): the building height multiplier (engine-web `scaleY`) and the opacity of the
/// flat map-colour overlay.
struct ZoomOutPaint {
  double heightScale = 1.0;
  double mapOpacity = 0.0;
};

/// The `sources` object (inline GeoJSON). Building features carry `id`, `height` (meters), `ci`, `si`.
json::Value buildWorldSources(const WorldData& world, const Projection& projection, const std::vector<RenderedBuilding>& buildings);
/// The `layers` array for a look, building paint and zoom-out state.
json::Value buildWorldLayers(const WorldData& world, const MapLook& look, const BuildingPaint& paint, const ZoomOutPaint& zoom = {});
/// Patches the zoom-out paint properties (extrusion height, overlay opacities) of `layers` in place and returns the
/// ones that changed, in layer order.
std::vector<PaintPropertyChange> zoomOutPaintChanges(json::Value& layers, const MapLook& look, const ZoomOutPaint& zoom);
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
