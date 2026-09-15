// Maprama native core — circular geofences.
//
// Commands: setGeofences.
// Events:   geofence:enter, geofence:exit.
#pragma once

#include <cstddef>
#include <string>
#include <vector>

#include "maprama/MessageSink.hpp"
#include "maprama/types.hpp"

namespace maprama {

class CharacterSystem;

class GeofenceSystem {
 public:
  virtual ~GeofenceSystem() = default;

  /// Replaces all geofences. Characters currently inside a removed geofence get `geofence:exit`
  /// on the next update; membership of unchanged ids is preserved.
  virtual void setGeofences(std::vector<GeofenceSpec> geofences) = 0;

  /// Evaluates membership for every character (haversine distance vs `radiusMeters`) and emits
  /// `geofence:enter` / `geofence:exit` on transitions.
  virtual void update(const CharacterSystem& characters, EventEmitter& events) = 0;

  virtual std::size_t geofenceCount() const = 0;
};

}  // namespace maprama
