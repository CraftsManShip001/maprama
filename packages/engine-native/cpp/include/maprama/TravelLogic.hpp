// Maprama native core — travel planning and path following (port of engine-web `src/game/follower.ts`,
// the pure parts of `src/game/travel.ts` and the `snapToRoad` handler of `src/engine/requests.ts`).
//
// Pure logic: no rendering, no platform code (wired by `GameSession`, M3a). The double arithmetic
// keeps V8's operation order (no FMA contraction, `js_math::hypot` / `clamp`), so plans, follower traces
// and ETAs match engine-web; the conformance suite compares them against `travel-plan.json` and
// `travel-trace.json` exported from engine-web's TypeScript sources.
//
// Units: world units (x east, z south) unless a name says meters; speeds in world units per second.
#pragma once

#include <array>
#include <cstddef>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/Projection.hpp"
#include "maprama/RoadGraph.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/types.hpp"

namespace maprama {

struct ProceduralWorld;

/// Trips shorter than this (world units) fly as a walk instead (engine-web `PLANE_MIN_UNITS`).
inline constexpr double kPlaneMinUnits = 12;
/// Maximum plane altitude in world units (`PLANE_MAX_ALTITUDE`).
inline constexpr double kPlaneMaxAltitude = 16;
/// Pop-in wait (seconds) when a trip starts in a vehicle (`MODE_SWITCH_WAIT_START`).
inline constexpr double kModeSwitchWaitStart = 0.4;
/// Pop-in wait (seconds) when a leg switches vehicles (`MODE_SWITCH_WAIT`).
inline constexpr double kModeSwitchWait = 0.45;

/// Per-mode values indexed by `static_cast<std::size_t>(TravelMode)`.
using ModeSpeeds = std::array<double, 5>;

/// Real-world speed of a mode in km/h (engine-web `KMH`: walk 4.8, bike 15, car 30, plane 180, subway 60).
double travelKmh(TravelMode mode);

/// Playback speed per mode in world units per wall-clock second: `KMH[mode] × (timeScale / 3.6 / unitMeters)`.
ModeSpeeds playbackSpeeds(double unitMeters = kDefaultUnitMeters, double timeScale = 1);

/// Ground height characters stand on (`groundYFor`): 0.05 on the procedural grid, 0.09 elsewhere
/// (`std::nullopt` = a `data` world).
double groundYFor(std::optional<ProceduralLayout> layout);

/// The parts of a world the planner needs (engine-web `PlanWorld`).
struct PlanWorld {
  RoadGraph graph;
  std::vector<Station> stations;
};

/// Road graph and stations of a loaded WorldData (engine-web `loadWorldData`: roads → `buildGraph`).
PlanWorld planWorldFromData(const WorldData& world);
/// Road graph and stations of a generated procedural world.
PlanWorld planWorldFromProcedural(const ProceduralWorld& world);

/// One leg of a trip in world units (engine-web `Leg`).
struct PlannedLeg {
  TravelMode mode = TravelMode::Walk;
  std::vector<WorldPoint> pts;
  /// Boarding and exit stations of a subway leg.
  std::optional<std::array<Station, 2>> stations;
};

/// Road path from `a` to `b`: `a`, the snapped network route, `b` (straight without a network), deduped at 0.01.
std::vector<WorldPoint> roadPath(const PlanWorld& world, const WorldPoint& a, const WorldPoint& b);

/// Index of the nearest station (first on ties), or -1 without stations.
int nearestStation(const std::vector<Station>& stations, const WorldPoint& p);

/// Collapses consecutive duplicate modes; an empty list becomes `{walk}`.
std::vector<TravelMode> normalizeModes(const std::vector<TravelMode>& modes);

/// Splits a polyline into `n` consecutive parts of equal length (engine-web `splitByLength`).
std::vector<std::vector<WorldPoint>> splitByLength(const std::vector<WorldPoint>& pts, std::size_t n);

/// engine-web `planLegs`: plans the legs of a trip for an ordered mode list (see follower.ts for the rules:
/// road modes share the road route, `plane` replaces the whole chain with a straight flight unless the
/// trip is shorter than `kPlaneMinUnits`, `subway` rides between the stations nearest to both ends and
/// falls back to walking without two distinct stations). Empty legs are dropped and consecutive road
/// legs of the same mode merged; a trip to the start point has no legs.
std::vector<PlannedLeg> planLegs(const PlanWorld& world, const WorldPoint& from, const WorldPoint& to,
                                 const std::vector<TravelMode>& modes);

/// Plane altitude over the ground at progress `t` (0..1) of a flight of `length` units.
double planeAltitude(double t, double length);

/// Seconds needed for `meters` in `mode` at real-world speed.
double etaSeconds(double meters, TravelMode mode);

/// Remaining distance of one leg (world units).
struct LegRemaining {
  TravelMode mode = TravelMode::Walk;
  double d = 0.0;
};

/// Wall-clock seconds to cover the remaining legs at `timeScale` (real-world ETA / timeScale).
double remainingEtaSeconds(const std::vector<LegRemaining>& remaining, double unitMeters, double timeScale = 1);

/// `request{route}` (engine-web `routeResult`): planned legs with meters, lng/lat paths and the real-world
/// ETA (independent of any travel `timeScale`).
RouteResult routeResult(const PlanWorld& world, const Projection& projection, const LngLat& from, const LngLat& to,
                        const std::vector<TravelMode>& modes);

/// `request{snapToRoad}` (engine-web `requests.ts`): nearest road point, `std::nullopt` without roads or
/// when farther than `maxDistanceMeters`.
std::optional<SnapToRoadResult> snapToRoad(const PlanWorld& world, const Projection& projection, const LngLat& coordinate,
                                           std::optional<double> maxDistanceMeters);

/// `travel:start` legs: mode and length in meters of each planned leg.
std::vector<TravelLeg> travelLegs(const std::vector<PlannedLeg>& legs, const Projection& projection);

/// The pose a `Follower` moves (engine-web `FollowerBody`, the character).
struct FollowerBody {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  /// Current speed in world units per second.
  double speed = 0.0;
  /// Desired yaw (`atan2(dx, dz)`).
  double targetYaw = 0.0;
  /// Plane nose pitch (radians) during plane legs.
  double planePitch = 0.0;
  /// Visible vehicle.
  TravelMode mode = TravelMode::Walk;

  /// Switches the visible vehicle; true when the mode changed (engine-web `Character.setMode`).
  bool setMode(TravelMode next) {
    if (mode == next) return false;
    mode = next;
    return true;
  }
};

/// Moves a body along trip legs (engine-web `Follower`).
class Follower {
 public:
  explicit Follower(double ground = 0.0) : groundY(ground) {}

  FollowerBody body;
  std::vector<PlannedLeg> legs;
  std::size_t li = 0;
  std::size_t si = 0;
  double wait = 0.0;
  std::optional<double> speedOverride;
  ModeSpeeds speeds = playbackSpeeds();
  double groundY = 0.0;

  bool active() const { return !legs.empty(); }
  /// Mode of the current leg, `std::nullopt` when idle.
  std::optional<TravelMode> mode() const;

  /// Starts a trip (or stops with `{}`); `speedOverride` replaces the per-mode speed.
  void setTrip(std::vector<PlannedLeg> trip, std::optional<double> speedOverride = std::nullopt,
               const ModeSpeeds& tripSpeeds = playbackSpeeds());

  /// Advances by `dt` seconds. Returns true when the last leg was completed in this step (engine-web
  /// calls `onArrive` at that point).
  bool step(double dt);
  bool step(double dt, const ModeSpeeds& stepSpeeds);

  /// engine-web `CharacterManager.step`: `step(dt)`, then back to walking once idle and not waiting.
  bool stepCharacter(double dt);

  /// Remaining distance per leg from the current position (engine-web `remainingByLeg`).
  std::vector<LegRemaining> remainingByLeg() const;

 private:
  void settleY(double dt);
};

/// A travel event produced by `TravelTrips` (`travel:start|progress|arrive|cancel`).
struct TravelEvent {
  enum class Type { Start, Progress, Arrive, Cancel };
  Type type = Type::Start;
  std::string requestId;
  std::string characterId;
  /// `travel:start` only.
  std::vector<TravelLeg> legs;
  /// `travel:progress` only.
  double remainingMeters = 0.0;
  double etaSeconds = 0.0;
  TravelMode mode = TravelMode::Walk;
};
std::string_view travelEventTypeName(TravelEvent::Type type);

/// Resolves a character id to its follower (nullptr when the character is gone).
using FollowerLookup = std::function<Follower*(std::string_view characterId)>;

/// Running trips per character (the non-visual part of engine-web `TravelManager`).
class TravelTrips {
 public:
  bool isTraveling(std::string_view characterId) const;

  /// `travel`: cancels a running trip of the character (`travel:cancel`), plans from the follower's
  /// position to `to` (world units), emits `travel:start` and starts the follower at
  /// `playbackSpeeds(unitMeters, timeScale)`; a trip without legs arrives at once (`travel:arrive`).
  std::vector<PlannedLeg> start(const PlanWorld& world, const Projection& projection, std::string requestId,
                                std::string characterId, Follower& follower, const WorldPoint& to,
                                const std::vector<TravelMode>& modes, double timeScale, std::vector<TravelEvent>& out);

  /// `cancelTravel`: stops the follower and emits `travel:cancel`; false when no trip was running.
  bool cancel(std::string_view characterId, Follower& follower, std::vector<TravelEvent>& out);
  /// Cancels every trip (world change); `lookup` may return nullptr for removed characters.
  void cancelAll(const FollowerLookup& lookup, std::vector<TravelEvent>& out);

  /// Call when `Follower::step` reported an arrival: finishes the character's trip (`travel:arrive`).
  bool arrived(std::string_view characterId, std::vector<TravelEvent>& out);

  /// `travel:progress` for every trip in start order (`etaSeconds` in wall-clock seconds at the trip's
  /// `timeScale`). Throttling is the subscription registry's job.
  void progress(const Projection& projection, const FollowerLookup& lookup, std::vector<TravelEvent>& out) const;

  std::size_t size() const { return trips_.size(); }

 private:
  struct Trip {
    std::string requestId;
    std::string characterId;
    std::vector<PlannedLeg> legs;
    double timeScale = 1.0;
  };
  std::vector<Trip> trips_;
};

}  // namespace maprama
