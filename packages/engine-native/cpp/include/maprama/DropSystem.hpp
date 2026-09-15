// Maprama native core — collectible drops.
//
// Commands: setDropLayer, removeDropLayer.
// Events:   drop:collect.
#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/MessageSink.hpp"
#include "maprama/types.hpp"

namespace maprama {

class CharacterSystem;
class Projection;

struct DropLayer {
  std::string layerId;
  std::vector<DropSpec> drops;
  /// Collected when a collector is within this many meters.
  double collectRadiusMeters = 0.0;
  /// Defaults to the player when absent.
  std::optional<std::vector<std::string>> collectorIds;
};

/// Per-instance GPU data for the instanced drop renderer (one draw call per type x rarity).
struct DropInstance {
  float x = 0.0f;
  float z = 0.0f;
  float bobPhase = 0.0f;
  std::uint8_t type = 0;
  std::uint8_t rarity = 0;
};

class DropSystem {
 public:
  virtual ~DropSystem() = default;

  /// Creates or replaces a layer (all drops of a previous layer with the same id are removed).
  virtual void setLayer(DropLayer layer, const Projection& projection) = 0;
  virtual void removeLayer(std::string_view layerId) = 0;

  /// Checks collectors against drops (uniform grid broad phase, haversine narrow phase) and emits
  /// `drop:collect` with a fresh `collectId` nonce (UUIDv4 from the platform CSPRNG). Collected drops
  /// are removed locally before the event is emitted, so a drop is never reported twice.
  virtual void update(const CharacterSystem& characters, EventEmitter& events) = 0;

  /// Instances to upload this frame (render thread reads a snapshot).
  virtual std::vector<DropInstance> instances() const = 0;
  virtual std::size_t dropCount() const = 0;
};

}  // namespace maprama
