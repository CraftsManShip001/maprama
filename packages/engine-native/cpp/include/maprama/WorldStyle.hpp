// Maprama native core — M1 flat map style: WorldData -> MapLibre style JSON (v8).
//
// The style carries the world as inline GeoJSON sources (lng/lat through `Projection`), so both
// platform adapters render the exact same map from one string and M2's `mbgl` adapter can load the
// same JSON with `style.loadJSON`. Colors follow engine-web's zoom-out "map colors" look
// (`packages/engine-web/src/render/zoom-out.ts` MAP_COLORS); road widths follow `ROAD_W` in meters.
// Themes (`ThemeResolver`) replace the palette at M2.
#pragma once

#include <string>

#include "maprama/Projection.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/json.hpp"

namespace maprama {

/// Style source ids (`maprama-*`) and layer ids, in draw order.
namespace world_style {
inline constexpr const char* kSourceArea = "maprama-area";
inline constexpr const char* kSourceWater = "maprama-water";
inline constexpr const char* kSourceParks = "maprama-parks";
inline constexpr const char* kSourceRoads = "maprama-roads";
inline constexpr const char* kSourceBuildings = "maprama-buildings";
inline constexpr const char* kSourcePois = "maprama-pois";
inline constexpr const char* kSourceStations = "maprama-stations";
}  // namespace world_style

/// Builds the style as a JSON value (tests inspect it).
json::Value buildWorldStyleValue(const WorldData& world, const Projection& projection);
/// `buildWorldStyleValue` serialised with `json::stringify`.
std::string buildWorldStyle(const WorldData& world, const Projection& projection);
/// Style shown before a world is loaded: only the background layer.
std::string buildEmptyStyle();

}  // namespace maprama
