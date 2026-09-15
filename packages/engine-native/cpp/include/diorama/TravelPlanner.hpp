// Diorama native core — routing and travel.
//
// Commands: travel, cancelTravel, request{route}, request{snapToRoad}.
// Events:   travel:start, travel:progress (subscription topic), travel:arrive, travel:cancel.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "diorama/MessageSink.hpp"
#include "diorama/types.hpp"

namespace diorama {

class CharacterSystem;
class WorldStore;

struct TravelRequest {
  /// Host-generated id correlating travel events.
  std::string requestId;
  std::string characterId;
  LngLat to;
  /// Ordered, at least one. `subway` expands to walk -> subway -> walk between nearest stations.
  std::vector<TravelMode> modes;
};

struct TravelProgress {
  std::string requestId;
  std::string characterId;
  double remainingMeters = 0.0;
  double etaSeconds = 0.0;
  TravelMode mode = TravelMode::Walk;
};

class TravelPlanner {
 public:
  virtual ~TravelPlanner() = default;

  /// Rebuilds the road graph (A* over WorldData roads, station graph for subway).
  virtual void setWorld(const WorldStore& world) = 0;

  /// `request{route}`: plans without moving anything.
  virtual Result<RouteResult> route(const LngLat& from, const LngLat& to, const std::vector<TravelMode>& modes) const = 0;

  /// `request{snapToRoad}`: nullopt when no road is within `maxDistanceMeters`.
  virtual std::optional<SnapToRoadResult> snapToRoad(const LngLat& coordinate,
                                                     std::optional<double> maxDistanceMeters) const = 0;

  /// Starts travel. A travel already running for the character is cancelled first (`travel:cancel`),
  /// then `travel:start` with the expanded legs is emitted.
  virtual void start(const TravelRequest& request, const CharacterSystem& characters, EventEmitter& events) = 0;

  /// `cancelTravel`: emits `travel:cancel` when a travel was running.
  virtual void cancel(std::string_view characterId, EventEmitter& events) = 0;

  /// Moves travelling characters along their paths; emits `travel:arrive`.
  virtual void update(double dtSeconds, CharacterSystem& characters, EventEmitter& events) = 0;

  /// Current progress per active travel (source of the `travel:progress` topic).
  virtual std::vector<TravelProgress> active() const = 0;
};

}  // namespace diorama
