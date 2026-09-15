// Maprama native core — characters and location sources.
//
// Commands: upsertCharacters, removeCharacters, setLocationSource, pushLocation.
// Events:   character:position (subscription topic), error{model_load_failed}.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/MessageSink.hpp"
#include "maprama/types.hpp"

namespace maprama {

/// Simulation state of one character (authoritative on the core thread).
struct CharacterState {
  std::string id;
  LngLat coordinate;
  /// Degrees clockwise from north.
  double headingDeg = 0.0;
  double speedMps = 0.0;
  bool isPlayer = false;
  /// Currently playing conventional clip.
  AnimationName animation = AnimationName::Idle;
  /// True while a travel owns the character's position.
  bool traveling = false;
};

class CharacterSystem {
 public:
  virtual ~CharacterSystem() = default;

  /// Adds or updates by id; unset fields keep their current value, `null` restores a field's default
  /// (`model: null` the default avatar, `name: null` the id as tag text, `scale: null` 1, ...).
  /// Model loads are async (cgltf on a worker).
  virtual void upsert(const std::vector<CharacterSpec>& characters, EventEmitter& events) = 0;
  virtual void remove(const std::vector<std::string>& ids) = 0;

  /// `device`: platform GPS feed (Kalman smoothing + road matching); `external`: pushLocation; `simulated`: demo loop.
  virtual void setLocationSource(LocationSourceKind source) = 0;
  /// Effective only with the `external` source.
  virtual void pushLocation(const LocationFix& fix) = 0;
  /// Platform GPS callback for the `device` source.
  virtual void onDeviceLocation(const LocationFix& fix) = 0;

  /// Advances interpolation / animation state machines. Emits nothing directly;
  /// throttled `character:position` is produced by the subscription registry.
  virtual void update(double dtSeconds) = 0;

  virtual std::optional<CharacterState> state(std::string_view id) const = 0;
  virtual std::vector<CharacterState> states() const = 0;
  virtual std::optional<std::string> playerId() const = 0;

  /// Travel planner drives position while traveling.
  virtual void setDrivenPose(std::string_view id, const LngLat& coordinate, double headingDeg, double speedMps,
                             AnimationName animation) = 0;
};

}  // namespace maprama
