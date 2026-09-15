#include "maprama/LocationFilter.hpp"

#include <cmath>
#include <limits>
#include <utility>

// The filter must reproduce V8's double arithmetic: no fused multiply-add.
#if defined(__clang__)
#pragma clang fp contract(off)
#endif

namespace maprama {

namespace {

constexpr double kPi = 3.141592653589793;

/// `Math.max(a, b)` / `Math.min(a, b)` (NaN propagates).
double jsMax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  return b > a ? b : a;
}
double jsMin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  return b < a ? b : a;
}

}  // namespace

void GpsSmoother::reset() {
  est.reset();
  vel = WorldPoint{0, 0};
  acc = 1.2;
  lastT_.reset();
  rejects_ = 0;
}

SmoothedFix GpsSmoother::push(const WorldFix& fix) {
  const SmootherOptions& o = o_;
  const double dt = !lastT_ ? 1 : js_math::clamp(fix.t - *lastT_, 0.05, 5);
  lastT_ = fix.t;
  bool rejected = false;
  if (!est) {
    est = WorldPoint{fix.x, fix.z};
    vel = WorldPoint{0, 0};
  } else {
    const double px = est->x + vel.x * dt, pz = est->z + vel.z * dt;
    const double ix = fix.x - px, iz = fix.z - pz, inn = js_math::hypot(ix, iz);
    const double gate = (o.outlierUnits + js_math::hypot(vel.x, vel.z)) * jsMax(1, dt);
    const bool far = jsMin(inn, js_math::hypot(fix.x - est->x, fix.z - est->z)) > gate;
    rejected = far || (fix.accuracy && *fix.accuracy > o.maxAccuracyUnits);
    if (rejected && ++rejects_ >= o.maxConsecutiveRejects) {
      // the "outliers" agree with each other: the device really moved
      est = WorldPoint{fix.x, fix.z};
      vel = WorldPoint{0, 0};
      acc = jsMax(acc, fix.accuracy ? *fix.accuracy : inn / 2);
      rejects_ = 0;
      rejected = false;
    } else if (!rejected) {
      rejects_ = 0;
      const double nx = px + ix * o.gain, nz = pz + iz * o.gain;
      vel.x += ((nx - est->x) / dt - vel.x) * o.velocityGain;
      vel.z += ((nz - est->z) / dt - vel.z) * o.velocityGain;
      const double vm = js_math::hypot(vel.x, vel.z);
      if (vm > o.maxSpeedUnits) {
        vel.x *= o.maxSpeedUnits / vm;
        vel.z *= o.maxSpeedUnits / vm;
      }
      est = WorldPoint{nx, nz};
      acc += ((fix.accuracy ? *fix.accuracy : inn) - acc) * 0.25;
    } else {
      est = WorldPoint{px, pz};
    }
  }
  return SmoothedFix{est->x, est->z, acc, rejected, vel.x, vel.z};
}

WorldFix worldFixFromLocation(const LocationFix& fix, const Projection& projection) {
  const WorldPoint p = projection.toWorld(LngLat{fix.lng, fix.lat});
  WorldFix wf{p.x, p.z, fix.timestamp / 1000, std::nullopt};
  if (fix.accuracyMeters) wf.accuracy = *fix.accuracyMeters / projection.unitMeters();
  return wf;
}

double gauss(const std::function<double()>& rng) {
  double u = 0, v = 0;
  while (!(u != 0.0)) u = rng();
  while (!(v != 0.0)) v = rng();
  return std::sqrt(-2 * std::log(u)) * std::cos(2 * kPi * v);
}

WorldPoint dataWorldStart(const WorldData& world) {
  if (world.plaza) return WorldPoint{world.plaza->x, world.plaza->z};
  return WorldPoint{(world.bounds.minX + world.bounds.maxX) / 2, (world.bounds.minZ + world.bounds.maxZ) / 2};
}

std::vector<WorldPoint> buildDemoLoop(const RoadGraph& graph, const std::vector<Vec2>& loopWays, const WorldPoint& start) {
  std::vector<WorldPoint> ways;
  ways.reserve(loopWays.size());
  for (const Vec2& w : loopWays) ways.push_back(WorldPoint{w[0], w[1]});
  if (ways.size() < 2) {
    const double r = 18;
    ways = {WorldPoint{start.x - r, start.z - r}, WorldPoint{start.x + r, start.z - r}, WorldPoint{start.x + r, start.z + r},
            WorldPoint{start.x - r, start.z + r}};
  }
  std::vector<WorldPoint> pts;
  for (std::size_t i = 0; i < ways.size(); ++i) {
    const WorldPoint& a = ways[i];
    const WorldPoint& b = ways[(i + 1) % ways.size()];
    const std::optional<GraphSnap> sa = snapToGraph(graph, a.x, a.z);
    const std::optional<GraphSnap> sb = snapToGraph(graph, b.x, b.z);
    const std::vector<WorldPoint> seg = sa && sb ? routeOnGraph(graph, *sa, *sb) : std::vector<WorldPoint>{a, b};
    for (std::size_t k = 0; k < seg.size(); ++k) {
      if (!(k == 0 && !pts.empty())) pts.push_back(WorldPoint{seg[k].x, seg[k].z});
    }
  }
  // `pts.filter((p, i) => i === 0 || hypot(p - pts[i - 1]) > 0.05)`: compares with the unfiltered predecessor.
  std::vector<WorldPoint> out;
  for (std::size_t i = 0; i < pts.size(); ++i) {
    if (i == 0 || js_math::hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z) > 0.05) out.push_back(pts[i]);
  }
  if (out.size() < 2) return {start, WorldPoint{start.x + 1, start.z}};
  return out;
}

SimulatedWalker::SimulatedWalker(std::vector<WorldPoint> loop, std::function<double()> rng, double speed)
    : loop_(std::move(loop)), rng_(std::move(rng)), speed_(speed) {
  if (!loop_.empty()) truth = loop_[0];
}

std::optional<SimulatedFix> SimulatedWalker::step(double dt) {
  const std::size_t n = loop_.size();
  if (n == 0) return std::nullopt;
  const WorldPoint& a = loop_[seg];
  const WorldPoint& b = loop_[(seg + 1) % n];
  t += (speed_ * dt) / jsMax(0.2, js_math::hypot(b.x - a.x, b.z - a.z));
  while (t >= 1) {
    t -= 1;
    seg = (seg + 1) % n;
  }
  const WorldPoint& a2 = loop_[seg];
  const WorldPoint& b2 = loop_[(seg + 1) % n];
  truth = WorldPoint{a2.x + (b2.x - a2.x) * t, a2.z + (b2.z - a2.z) * t};
  timer_ -= dt;
  if (timer_ > 0) return std::nullopt;
  timer_ = 1;
  const bool outlier = rng_() < 0.1;
  const double sd = outlier ? 5.5 : 0.9;
  const double x = truth.x + gauss(rng_) * sd;
  const double z = truth.z + gauss(rng_) * sd;
  return SimulatedFix{x, z, outlier};
}

LocationTrip locationTrip(const RoadGraph& graph, const WorldPoint& from, const WorldPoint& est, double maxSnap) {
  const std::optional<GraphSnap> se = snapToGraph(graph, est.x, est.z);
  std::vector<WorldPoint> pts;
  if (se && se->dist <= maxSnap) {
    const std::optional<GraphSnap> sf = snapToGraph(graph, from.x, from.z);
    pts = sf ? routeOnGraph(graph, *sf, *se) : std::vector<WorldPoint>{from, WorldPoint{se->x, se->z}};
    if (sf && sf->dist > 0.05) pts.insert(pts.begin(), WorldPoint{from.x, from.z});
  } else {
    // engine-web: `roadPath` over an empty graph = `dedupe([from, est])`
    pts.push_back(WorldPoint{from.x, from.z});
    if (js_math::hypot(from.x - est.x, from.z - est.z) > 0.01) pts.push_back(WorldPoint{est.x, est.z});
  }
  const double length = polylineLength(pts);
  return LocationTrip{std::move(pts), length < 0.25 ? 0 : js_math::clamp(length / 1.05, 0, 8)};
}

LocationDrive planLocationDrive(const RoadGraph& graph, const WorldPoint& from, const WorldPoint& estimate) {
  LocationDrive drive;
  if (js_math::hypot(estimate.x - from.x, estimate.z - from.z) > kTeleportUnits) {
    drive.teleport = true;
    drive.to = WorldPoint{estimate.x, estimate.z};
    return drive;
  }
  drive.trip = locationTrip(graph, from, estimate);
  return drive;
}

void applyLocationDrive(Follower& follower, const LocationDrive& drive) {
  if (drive.teleport) {
    follower.setTrip({});
    follower.body.x = drive.to.x;
    follower.body.z = drive.to.z;
    return;
  }
  std::vector<PlannedLeg> legs;
  if (drive.trip.pts.size() > 1) legs.push_back(PlannedLeg{TravelMode::Walk, drive.trip.pts, std::nullopt});
  follower.setTrip(std::move(legs), drive.trip.speed);
}

bool LocationService::setKind(LocationSourceKind kind) {
  if (kind == kind_) return false;
  kind_ = kind;
  smoother_.reset();
  last_.reset();
  if (kind == LocationSourceKind::Simulated && walker_) walker_->kick();
  return true;
}

void LocationService::worldChanged(std::vector<WorldPoint> demoLoop) {
  walker_.emplace(std::move(demoLoop), rng_);
  smoother_.reset();
  last_.reset();
}

std::optional<ProcessedFix> LocationService::push(const LocationFix& fix, const Projection& projection) {
  if (kind_ != LocationSourceKind::External) return std::nullopt;
  return process(worldFixFromLocation(fix, projection), fix.headingDeg);
}

std::optional<ProcessedFix> LocationService::onDevice(const LocationFix& fix, const Projection& projection) {
  if (kind_ != LocationSourceKind::Device) return std::nullopt;
  return process(worldFixFromLocation(fix, projection), fix.headingDeg);
}

std::optional<ProcessedFix> LocationService::step(double dt, double nowSeconds) {
  if (kind_ != LocationSourceKind::Simulated || !walker_) return std::nullopt;
  const std::optional<SimulatedFix> f = walker_->step(dt);
  if (!f) return std::nullopt;
  return process(WorldFix{f->x, f->z, nowSeconds, std::nullopt}, std::nullopt);
}

ProcessedFix LocationService::process(const WorldFix& fix, std::optional<double> headingDeg) {
  ProcessedFix out{smoother_.push(fix), WorldPoint{fix.x, fix.z}, headingDeg};
  last_ = out;
  return out;
}

}  // namespace maprama
