// Maprama native core — circular geofence membership (port of engine-web `src/game/geofences.ts`,
// `GeofenceTracker`, and the conversion in `Features.applyGeofences`).
//
// Rules (engine-web): a character is inside when its ground distance to the center is strictly less than
// the radius (world units). `set` keeps the inside-state of ids that still exist (no duplicate `enter`);
// removed geofences and removed characters are forgotten silently (no `exit`). Transitions are reported
// in geofence order, then character order. Pure logic; MapSession wiring is M3 phase 2.
#pragma once

#include <map>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/Projection.hpp"
#include "maprama/types.hpp"

namespace maprama {

/// A character's ground position in world units (engine-web `positions` of a frame).
struct CharacterPosition {
  std::string id;
  double x = 0.0;
  double z = 0.0;
  bool isPlayer = false;
};

/// A geofence in world units (engine-web `WorldFence`).
struct WorldFence {
  std::string id;
  double x = 0.0;
  double z = 0.0;
  /// Radius in world units.
  double r = 0.0;
};

/// `geofence:enter` (`enter`) or `geofence:exit`.
struct GeofenceTransition {
  bool enter = true;
  std::string geofenceId;
  std::string characterId;
};

/// `setGeofences` specs → world fences: projected center, `radiusMeters / unitMeters`.
std::vector<WorldFence> worldFences(const std::vector<GeofenceSpec>& specs, const Projection& projection);

/// Tracks which characters are inside which geofences (engine-web `GeofenceTracker`).
class GeofenceTracker {
 public:
  /// Replaces the geofences; membership of ids that still exist is kept.
  void set(std::vector<WorldFence> fences);
  const std::vector<WorldFence>& list() const { return fences_; }

  /// Evaluates positions; returns transitions in geofence order, then character order.
  std::vector<GeofenceTransition> update(const std::vector<CharacterPosition>& characters);

  bool isInside(std::string_view geofenceId, std::string_view characterId) const;

 private:
  std::vector<WorldFence> fences_;
  /// Inside-set per geofence id (duplicate ids share one set, like engine-web's Map).
  std::map<std::string, std::set<std::string>, std::less<>> inside_;
};

}  // namespace maprama
