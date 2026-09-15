// Maprama native core — location smoothing and road following (port of engine-web `src/game/location.ts`
// and the location part of `src/engine/features.ts`).
//
// - `GpsSmoother`: alpha-beta filter with the prototype's outlier gate (widened by speed, far from both
//   the prediction and the estimate), accuracy rejection and the jump to the fix after
//   `maxConsecutiveRejects` consecutive rejections.
// - `locationTrip` / `planLocationDrive`: a character following the location walks along the road network
//   to the estimate (straight when the estimate is off-road) at `clamp(L / 1.05, 0, 8)` units/s, and
//   teleports when the estimate is more than `kTeleportUnits` away.
// - `buildDemoLoop` / `SimulatedWalker`: the `simulated` source's demo loop and noisy fixes.
// - `LocationService`: source switching and fix processing without the platform GPS (wired by `GameSession`,
//   M3a; the device feed comes from `MapAdapter::startLocationUpdates`).
//
// The arithmetic keeps V8's operation order (no FMA contraction); conformance: `location.json`.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <vector>

#include "maprama/Projection.hpp"
#include "maprama/RoadGraph.hpp"
#include "maprama/TravelLogic.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/types.hpp"

namespace maprama {

/// Ground-truth pace of the `simulated` demo loop in world units per second (`SIMULATED_WALK_SPEED`).
inline constexpr double kSimulatedWalkSpeed = 3.2 * 0.95;
/// Estimates farther than this from any road (world units) are followed off-road (`MAX_SNAP_UNITS`).
inline constexpr double kMaxSnapUnits = 4;
/// Location estimates farther than this (world units) teleport the character (features.ts `TELEPORT_UNITS`).
inline constexpr double kTeleportUnits = 40;

/// engine-web `SmootherOptions` with its defaults.
struct SmootherOptions {
  /// Blend factor of an accepted fix into the prediction.
  double gain = 0.6;
  /// Velocity blend factor.
  double velocityGain = 0.7;
  /// Base outlier gate in world units per second of fix interval (widened by the current speed).
  double outlierUnits = 4.5;
  /// Velocity clamp in world units per second.
  double maxSpeedUnits = 5;
  /// After this many consecutive rejections the estimate jumps to the fix.
  double maxConsecutiveRejects = 3;
  /// Fixes reporting a worse accuracy (world units) are rejected.
  double maxAccuracyUnits = 12.5;
};

/// Input fix in world units; `t` in seconds.
struct WorldFix {
  double x = 0.0;
  double z = 0.0;
  double t = 0.0;
  /// Reported accuracy radius in world units.
  std::optional<double> accuracy;
};

/// Result of `GpsSmoother::push`.
struct SmoothedFix {
  double x = 0.0;
  double z = 0.0;
  /// Running accuracy estimate in world units.
  double accuracy = 0.0;
  /// True when the fix was rejected as an outlier (the estimate follows the prediction).
  bool rejected = false;
  /// Estimated velocity in world units per second.
  double vx = 0.0;
  double vz = 0.0;
};

/// Alpha-beta filter with outlier rejection (engine-web `GpsSmoother`).
class GpsSmoother {
 public:
  explicit GpsSmoother(SmootherOptions options = {}) : o_(options) {}

  void reset();
  SmoothedFix push(const WorldFix& fix);

  std::optional<WorldPoint> est;
  WorldPoint vel;
  /// Running accuracy estimate in world units (starts at 1.2).
  double acc = 1.2;

 private:
  std::optional<double> lastT_;
  double rejects_ = 0;
  SmootherOptions o_;
};

/// `pushLocation` / device fix → world fix (`timestamp / 1000` seconds, accuracy in world units).
WorldFix worldFixFromLocation(const LocationFix& fix, const Projection& projection);

/// Standard normal sample (Box-Muller, engine-web `gauss`).
double gauss(const std::function<double()>& rng);

/// Start point of a `data` world (engine-web `loadWorldData`: the plaza, else the bounds center).
WorldPoint dataWorldStart(const WorldData& world);

/// The demo loop (engine-web `buildDemoLoop`): `loopWays` joined by road routes; worlds without
/// `loopWays` loop through four road points 18 units around `start`.
std::vector<WorldPoint> buildDemoLoop(const RoadGraph& graph, const std::vector<Vec2>& loopWays, const WorldPoint& start);

/// A noisy fix of the demo walker.
struct SimulatedFix {
  double x = 0.0;
  double z = 0.0;
  bool outlier = false;
};

/// Walks the demo loop and produces noisy fixes once per second (engine-web `SimulatedWalker`).
class SimulatedWalker {
 public:
  SimulatedWalker(std::vector<WorldPoint> loop, std::function<double()> rng, double speed = kSimulatedWalkSpeed);

  /// Advances the ground truth; returns a noisy fix when one is due.
  std::optional<SimulatedFix> step(double dt);
  /// Makes the next `step` produce a fix immediately.
  void kick() { timer_ = 0; }

  const std::vector<WorldPoint>& loop() const { return loop_; }
  std::size_t seg = 0;
  double t = 0.0;
  WorldPoint truth;

 private:
  std::vector<WorldPoint> loop_;
  std::function<double()> rng_;
  double speed_;
  double timer_ = 0.0;
};

/// Walk trip from a character to a location estimate (engine-web `locationTrip`).
struct LocationTrip {
  std::vector<WorldPoint> pts;
  /// Speed override in world units per second (0 when closer than 0.25).
  double speed = 0.0;
};
LocationTrip locationTrip(const RoadGraph& graph, const WorldPoint& from, const WorldPoint& est, double maxSnap = kMaxSnapUnits);

/// What `Features.driveToFix` does for a character following the location (not while it travels).
struct LocationDrive {
  /// Estimate farther than `kTeleportUnits`: stop and jump to `to`.
  bool teleport = false;
  WorldPoint to;
  /// Otherwise: the walk trip (`pts.size() < 2` = stop).
  LocationTrip trip;
};
LocationDrive planLocationDrive(const RoadGraph& graph, const WorldPoint& from, const WorldPoint& estimate);
/// Applies a drive to the character's follower (engine-web `setTrip` / teleport).
void applyLocationDrive(Follower& follower, const LocationDrive& drive);

/// A processed fix (smoothed estimate, raw world fix, heading when the fix had one).
struct ProcessedFix {
  SmoothedFix fix;
  WorldPoint raw;
  std::optional<double> headingDeg;
};

/// Location source state without the platform GPS (engine-web `LocationService`).
class LocationService {
 public:
  explicit LocationService(std::function<double()> rng) : rng_(std::move(rng)) {}

  LocationSourceKind kind() const { return kind_; }
  /// Switches the source; a change resets the smoother and the last fix (`simulated` kicks the walker).
  /// Returns false when nothing changed. Starting / stopping the device GPS is the adapter's job.
  bool setKind(LocationSourceKind kind);
  /// New world: new demo loop, smoother reset.
  void worldChanged(std::vector<WorldPoint> demoLoop);

  /// `pushLocation`: processed only with the `external` source (`std::nullopt` otherwise).
  std::optional<ProcessedFix> push(const LocationFix& fix, const Projection& projection);
  /// A platform GPS fix: processed only with the `device` source.
  std::optional<ProcessedFix> onDevice(const LocationFix& fix, const Projection& projection);
  /// `simulated` source: advances the walker; `nowSeconds` stamps its fixes.
  std::optional<ProcessedFix> step(double dt, double nowSeconds);

  const std::optional<ProcessedFix>& last() const { return last_; }
  GpsSmoother& smoother() { return smoother_; }
  const std::optional<SimulatedWalker>& walker() const { return walker_; }

 private:
  ProcessedFix process(const WorldFix& fix, std::optional<double> headingDeg);

  LocationSourceKind kind_ = LocationSourceKind::Simulated;
  GpsSmoother smoother_;
  std::optional<SimulatedWalker> walker_;
  std::optional<ProcessedFix> last_;
  std::function<double()> rng_;
};

}  // namespace maprama
