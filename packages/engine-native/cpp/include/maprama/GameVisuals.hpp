// Maprama native core — M3a game visuals as MapLibre style layers over GeoJSON sources.
//
// engine-web draws characters, the route overlay, drops, geofences and the location puck as three.js meshes
// (`src/game/*.ts`, `src/ui/puck.ts`). Until the custom render layer carries 3D characters and drop models
// (M3b), the native engine draws the same information with style layers on five GeoJSON sources whose data
// the `GameSession` replaces through `MapAdapter::setSourceData` whenever it changes:
//
//   source                      layers (draw order)                       engine-web counterpart
//   maprama-game-fences         game-fences-fill, game-fences-ring        GeofenceVisuals fill (7 %) + ring (85 %)
//   maprama-game-route          game-route-rings, game-route,             RouteOverlay (player trips only):
//                               game-route-pin                            lines by mode, subway rings, pin
//   maprama-game-puck           game-puck-accuracy, game-puck             LocationPuck (accuracy disc, dot)
//   maprama-game-drops          game-drops                                DropVisuals (rarity colour, pop)
//   maprama-game-characters     game-characters, game-characters-heading  Character (body colour, heading)
//
// Ground-level layers (fences, route lines, accuracy disc) are inserted below the 3D buildings so buildings
// occlude them; the markers (pin, drops, puck, characters) are drawn above the buildings, like engine-web's
// silhouettes that keep characters visible behind buildings. Every size is a world size in meters at the
// target (exponential base-2 zoom stops, like the road widths) with a minimum on-screen size so markers stay
// readable at the far camera distances. Pure: no adapter, tested directly.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "maprama/GeofenceLogic.hpp"
#include "maprama/Projection.hpp"
#include "maprama/TravelLogic.hpp"
#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

namespace game_style {
inline constexpr const char* kSourceFences = "maprama-game-fences";
inline constexpr const char* kSourceRoute = "maprama-game-route";
inline constexpr const char* kSourcePuck = "maprama-game-puck";
inline constexpr const char* kSourceDrops = "maprama-game-drops";
inline constexpr const char* kSourceCharacters = "maprama-game-characters";

inline constexpr const char* kLayerFenceFill = "game-fences-fill";
inline constexpr const char* kLayerFenceRing = "game-fences-ring";
inline constexpr const char* kLayerRouteRings = "game-route-rings";
inline constexpr const char* kLayerRoute = "game-route";
inline constexpr const char* kLayerPuckAccuracy = "game-puck-accuracy";
inline constexpr const char* kLayerRoutePin = "game-route-pin";
inline constexpr const char* kLayerDrops = "game-drops";
inline constexpr const char* kLayerPuck = "game-puck";
inline constexpr const char* kLayerCharacters = "game-characters";
inline constexpr const char* kLayerCharacterHeading = "game-characters-heading";

/// engine-web `PLAYER_COLOR` / `NPC_COLORS` (characters.ts).
inline constexpr std::uint32_t kPlayerColor = 0x3F63D6;
inline constexpr std::array<std::uint32_t, 6> kNpcColors{0x4E9C84, 0xC25B70, 0xD3A03E, 0x6F63B8, 0x3F86BE, 0xA8653A};
/// engine-web `RARITY_COLORS` (`Rarity` order: common, rare, legendary).
inline constexpr std::array<std::uint32_t, 3> kRarityColors{0x6FB7FF, 0xB07CFF, 0xFFC24A};
/// Duration of the drop collect "pop" (radius grows by 60 % while the drop fades out).
inline constexpr double kCollectPopMs = 300.0;
/// engine-web geofence ring / fill segments.
inline constexpr int kFenceSegments = 80;
/// Distance of the heading dot from the character centre (world units, times the character scale).
inline constexpr double kHeadingOffsetUnits = 0.75;
}  // namespace game_style

/// One character marker.
struct CharacterVisual {
  std::string id;
  LngLat position;
  /// Heading dot position (ahead of the character in its facing direction).
  LngLat heading;
  /// Body colour (already tinted for the time of day).
  std::uint32_t color = 0;
  double scale = 1.0;
  bool isPlayer = false;
  /// Current vehicle (the ring shows the route colour of a vehicle mode).
  TravelMode mode = TravelMode::Walk;
};

/// One drop marker; `pop` in [0, 1) while the collect animation runs.
struct DropVisual {
  std::string layerId;
  std::string dropId;
  LngLat position;
  Rarity rarity = Rarity::Common;
  double pop = 0.0;
};

/// The location puck under the player; `accuracy` is the accuracy disc ring (lng/lat), if shown.
struct PuckVisual {
  LngLat position;
  std::optional<std::vector<LngLat>> accuracy;
};

/// The five game sources with empty FeatureCollections (their data follows through `setSourceData`).
json::Value gameSources();

/// Inserts the game layers into a world layer list (`buildWorldLayers` output): ground layers before the
/// captured-building ring, markers after the 3D buildings (appended when those layers are missing).
void insertGameLayers(json::Value& layers, double originLat, double unitMeters);

/// Open ring of `segments` points on a circle (world units), counter-clockwise in x/z from +x.
std::vector<Vec2> circleRing(double x, double z, double r, int segments);

/// `{"type":"FeatureCollection","features":[]}`.
std::string emptyFeatureCollection();

/// Geofences: a fill disc (radius r − w) and a ring (r − w … r) per fence, w = min(0.35, 0.2 r) (engine-web).
std::string fencesGeoJson(const std::vector<WorldFence>& fences, const Projection& projection);
/// Route overlays: one line per leg (`mode`), subway station rings (0.7 … 1.05 units) and the destination pin.
std::string routeGeoJson(const std::vector<std::vector<PlannedLeg>>& routes, const Projection& projection);
std::string dropsGeoJson(const std::vector<DropVisual>& drops);
std::string charactersGeoJson(const std::vector<CharacterVisual>& characters);
std::string puckGeoJson(const std::optional<PuckVisual>& puck);

/// A zoom-dependent size in dp that is `meters` wide on the ground at `lat`, never below `minPx`
/// (exponential base-2 stops at every integer zoom 12 … 22). `scaleProperty` multiplies by a feature property.
json::Value groundSizeExpression(double meters, double minPx, double lat, const char* scaleProperty = nullptr);

}  // namespace maprama
