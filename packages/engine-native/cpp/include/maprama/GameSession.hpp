// Maprama native core — M3a game session: characters, location sources, travel + routing, drops and
// geofences, wired from the pure engine-web ports (`TravelLogic`, `LocationFilter`, `DropLogic`,
// `GeofenceLogic`, `RoadGraph`) and drawn with MapLibre style layers (`GameVisuals`).
//
// The behavioural reference is engine-web's `Features` (`src/engine/features.ts`), `CharacterManager`
// (`src/game/characters.ts`), `TravelManager` (`src/game/travel.ts`), `LocationService`
// (`src/game/location.ts`) and the request handlers (`src/engine/engine.ts`, `requests.ts`):
//
//   - deferred state: characters, drop layers and geofences sent before a world is loaded are kept and
//     applied when it loads; a new world cancels running trips (`travel:cancel`), re-projects characters
//     (same geographic position), rebuilds the demo loop and re-projects drop layers and geofences;
//   - commands: `upsertCharacters` (merge, `null` restores a default, at most one player →
//     `invalid_character`), `removeCharacters` (cancels trips), `setLocationSource`, `pushLocation`,
//     `travel` / `cancelTravel` (`not_ready`, `unknown_character`), `setDropLayer` / `removeDropLayer`,
//     `setGeofences`, `setCamera.follow` (through `MapSessionHooks`), the `character:position` /
//     `travel:progress` topics (throttled per subscription and key, engine-web `ThrottledTopic`) and the
//     `route` / `snapToRoad` requests (`not_ready` without a world);
//   - one simulation tick per frame while something moves (engine-web `Features.frame` order: location,
//     characters + arrivals, drops, geofences, camera follow, `character:position`, `travel:progress`),
//     scheduled through `MapAdapter::scheduleFrame`: 16 ms while characters move, drops pop or the camera
//     catches up with a followed character, 250 ms while only the `simulated` walker runs, none otherwise;
//   - the `device` source starts the platform location feed (`MapAdapter::startLocationUpdates`).
//
// Not thread-safe: the Engine calls it with its lock held (DESIGN.md §3).
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "maprama/DropLogic.hpp"
#include "maprama/GameVisuals.hpp"
#include "maprama/GeofenceLogic.hpp"
#include "maprama/LocationFilter.hpp"
#include "maprama/MapAdapter.hpp"
#include "maprama/MapSession.hpp"
#include "maprama/MessageSink.hpp"
#include "maprama/SubscriptionRegistry.hpp"
#include "maprama/TravelLogic.hpp"
#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

class WorldStore;

/// engine-web error codes of the game commands (besides `not_ready`).
inline constexpr std::string_view kUnknownCharacterCode = "unknown_character";
inline constexpr std::string_view kInvalidCharacterCode = "invalid_character";
inline constexpr std::string_view kLocationUnavailableCode = "location_unavailable";

/// Frame interval while something moves, and the tick interval of the idle `simulated` walker.
inline constexpr double kGameFrameMs = 16.0;
inline constexpr double kGameIdleWalkerMs = 250.0;

/// Tick cost counters (diagnostics; the platform logs are the per-frame measurements of DESIGN.md §8).
struct GameFrameStats {
  std::uint64_t ticks = 0;
  double totalTickMs = 0.0;
  double maxTickMs = 0.0;
  std::uint64_t sourceUpdates = 0;
  std::uint64_t sourceBytes = 0;
};

class GameSession final : public MapSessionHooks {
 public:
  GameSession(MessageSink& sink, WorldStore& world, MapSession& map, ClockMs clock, std::function<double()> random,
              std::function<std::string()> collectId);
  ~GameSession() override;

  void bindEmitter(EventEmitter* events) { events_ = events; }

  // ---- platform side -------------------------------------------------------------------------------
  void attachAdapter(std::shared_ptr<MapAdapter> adapter);
  void detachAdapter();
  /// A frame requested through `MapAdapter::scheduleFrame` (frames requested by the map session are ignored).
  void frame();
  void onDeviceLocation(const LocationFix& fix);
  void onDeviceLocationError(const std::string& message);
  /// A user pan stops following (engine-web `CameraController.panBy`).
  void onUserPan();

  // ---- commands (already validated by `decodeCommand`) -------------------------------------------
  /// `init`: remembers `locationSource` (applied when the world loads, like engine-web).
  void init(const json::Value& msg);
  void upsertCharacters(const json::Value& characters);
  void removeCharacters(const json::Value& ids);
  void setLocationSource(const std::string& source);
  void pushLocation(const json::Value& fix);
  void travel(const json::Value& msg);
  void cancelTravel(const std::string& characterId);
  void setDropLayer(const json::Value& msg);
  void removeDropLayer(const std::string& layerId);
  void setGeofences(const json::Value& geofences);
  void subscribe(SubscriptionTopic topic, std::optional<std::string> id, double throttleMs);
  void unsubscribe(SubscriptionTopic topic, const std::optional<std::string>& id);
  /// `route` / `snapToRoad`.
  void request(const std::string& requestId, RequestMethod method, const json::Value& params);
  /// The theme changed (character colours follow the time-of-day tint).
  void themeChanged();
  /// `setUi` changed (`locationPuck`).
  void uiChanged();
  void shutdown();

  // ---- MapSessionHooks ---------------------------------------------------------------------------
  void extendSources(json::Value& sources) override;
  void extendLayers(json::Value& layers, const MapLook& look) override;
  void styleSent() override;
  void worldLoaded(const json::Value& initMsg, const ProceduralWorld* procedural) override;
  bool setFollow(const std::optional<std::string>& characterId) override;

  // ---- state (tests, diagnostics) ----------------------------------------------------------------
  struct CharacterSnapshot {
    std::string id;
    WorldPoint position;
    double y = 0.0;
    double headingDeg = 0.0;
    /// World units per second.
    double speed = 0.0;
    TravelMode mode = TravelMode::Walk;
    bool traveling = false;
    bool isPlayer = false;
  };
  std::vector<CharacterSnapshot> characters() const;
  std::size_t pendingCharacters() const { return pendingChars_.size(); }
  const std::optional<std::string>& followingId() const { return followId_; }
  LocationSourceKind locationSource() const { return location_.kind(); }
  bool deviceLocationRunning() const { return deviceRunning_; }
  bool frameScheduled() const;
  const GameFrameStats& stats() const { return stats_; }
  /// Uncollected drops of a layer (world units).
  std::vector<DropState> drops(const std::string& layerId) const { return collector_.drops(layerId); }
  std::size_t dropMarkers() const { return dropVisuals_.size(); }
  const std::vector<WorldFence>& fences() const { return fences_.list(); }

 private:
  struct Character;
  enum Dirty : unsigned { kFences = 1, kRoute = 2, kPuck = 4, kDrops = 8, kCharacters = 16, kAll = 31 };

  Character* find(const std::string& id) const;
  Follower* followerOf(std::string_view id) const;
  void applyUpsert(const std::vector<json::Value>& specs);
  WorldPoint spawnPoint(const Character& ch) const;
  void applyLocationKind(LocationSourceKind kind);
  void startDevice();
  void stopDevice();
  void onLocationFix(const ProcessedFix& fix);
  void driveToFix(Character& ch, const WorldPoint& estimate);
  void applyDropLayer(const DropLayer& layer);
  void applyGeofences();
  void processTravelEvents(const std::vector<TravelEvent>& events);
  void tick(double nowMs);
  void stepFollow(double dt);
  void emitPositions(double nowMs);
  void emitProgress(double nowMs);
  void flushVisuals();
  void scheduleNext(double nowMs);
  void wake();
  void requestFrame(double nowMs, double delayMs);
  bool moving() const;
  std::uint32_t bodyColor(const Character& ch) const;
  void emit(json::Value event);
  void emitError(std::string_view code, std::string message);
  void respondOk(const std::string& requestId, json::Value result);
  void respondError(const std::string& requestId, std::string_view code, std::string message);
  void warnOnce(const std::string& key, const std::string& message);
  void recordTick(double tickMs);

  MessageSink& sink_;
  WorldStore& world_;
  MapSession& map_;
  ClockMs clock_;
  EventEmitter* events_ = nullptr;
  std::shared_ptr<MapAdapter> adapter_;

  bool worldReady_ = false;
  std::optional<Projection> proj_;
  PlanWorld plan_;
  double groundY_;
  /// engine-web `CharacterManager.spawnPoint` base: the plaza (else the origin) of a data world, the
  /// generator's start of a procedural one.
  WorldPoint spawnBase_{};

  std::vector<std::unique_ptr<Character>> chars_;
  /// Upserts received before the first world (engine-web `pendingChars`, merged by id).
  std::vector<json::Value> pendingChars_;

  LocationService location_;
  /// `init.locationSource` / `setLocationSource` (engine-web `Engine.locationSource`).
  LocationSourceKind locationSource_ = LocationSourceKind::Simulated;
  bool deviceRunning_ = false;

  TravelTrips trips_;
  /// Route overlays of the player's running trips (engine-web draws them for `isPlayer` characters only).
  std::map<std::string, std::vector<PlannedLeg>> routes_;

  DropCollector collector_;
  /// `setDropLayer` commands by layer id, insertion-ordered (a JS Map).
  std::vector<std::pair<std::string, DropLayer>> dropLayers_;
  /// Drop markers by `layerId \0 dropId` (collected ones stay while they pop).
  std::map<std::string, DropVisual> dropVisuals_;
  std::map<std::string, double> popStartMs_;

  std::vector<GeofenceSpec> geofenceSpecs_;
  GeofenceTracker fences_;

  SubscriptionRegistry subscriptions_;
  /// engine-web `lastPosition`: the last `character:position` key sent per character.
  std::map<std::string, std::string> lastPosition_;
  /// Smallest wait (ms) until a throttled, changed `character:position` becomes due.
  double subscriptionWaitMs_;

  std::optional<std::string> followId_;
  bool followMoving_ = false;

  unsigned dirty_ = kAll;
  double scheduledAtMs_;
  double lastTickMs_;
  std::set<std::string> warned_;

  GameFrameStats stats_;
  double statsWindowStartMs_ = -1.0;
  GameFrameStats statsWindow_;
};

}  // namespace maprama
