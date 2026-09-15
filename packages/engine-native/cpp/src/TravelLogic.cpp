#include "maprama/TravelLogic.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

#include "maprama/ProceduralWorld.hpp"

// Plans and follower traces must reproduce V8's double arithmetic: no fused multiply-add.
#if defined(__clang__)
#pragma clang fp contract(off)
#endif

namespace maprama {

namespace {

/// `Math.PI`.
constexpr double kPi = 3.141592653589793;

constexpr std::array<double, 5> kKmh{4.8, 15, 30, 180, 60};

std::size_t modeIndex(TravelMode mode) { return static_cast<std::size_t>(mode); }

/// engine-web `dist(a, b)`.
double dist(const WorldPoint& a, const WorldPoint& b) { return js_math::hypot(b.x - a.x, b.z - a.z); }

/// `Math.min(a, b)` (NaN propagates).
double jsMin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  return b < a ? b : a;
}

/// engine-web `dedupe`: drops points within 0.01 of the last kept point.
std::vector<WorldPoint> dedupe(const std::vector<WorldPoint>& pts) {
  std::vector<WorldPoint> out;
  out.reserve(pts.size());
  for (const WorldPoint& p : pts) {
    if (out.empty() || dist(p, out.back()) > 0.01) out.push_back(WorldPoint{p.x, p.z});
  }
  return out;
}

std::vector<PlannedLeg> planRoadModes(const PlanWorld& world, const WorldPoint& from, const WorldPoint& to,
                                      const std::vector<TravelMode>& chain) {
  std::vector<WorldPoint> pts = roadPath(world, from, to);
  if (chain.size() == 1) return {PlannedLeg{chain[0], std::move(pts), std::nullopt}};
  const bool lead = chain.front() == TravelMode::Walk;
  const bool trail = chain.back() == TravelMode::Walk;
  const std::size_t mBegin = lead ? 1 : 0;
  const std::size_t mEnd = trail ? chain.size() - 1 : chain.size();
  std::vector<TravelMode> middle;
  for (std::size_t i = mBegin; i < mEnd; ++i) middle.push_back(chain[i]);
  // prototype "mixed": too short a route to switch modes → walk it
  if (middle.empty() || pts.size() < (lead ? 1u : 0u) + (trail ? 1u : 0u) + 2u) {
    return {PlannedLeg{TravelMode::Walk, std::move(pts), std::nullopt}};
  }
  std::vector<PlannedLeg> legs;
  const std::size_t start = lead ? 1 : 0;
  const std::size_t end = trail ? pts.size() - 2 : pts.size() - 1;
  if (lead) legs.push_back(PlannedLeg{TravelMode::Walk, {pts[0], pts[1]}, std::nullopt});
  const std::vector<WorldPoint> inner(pts.begin() + static_cast<std::ptrdiff_t>(start),
                                      pts.begin() + static_cast<std::ptrdiff_t>(end + 1));
  std::vector<std::vector<WorldPoint>> parts = splitByLength(inner, middle.size());
  for (std::size_t i = 0; i < parts.size(); ++i) legs.push_back(PlannedLeg{middle[i], std::move(parts[i]), std::nullopt});
  if (trail) legs.push_back(PlannedLeg{TravelMode::Walk, {pts[pts.size() - 2], pts[pts.size() - 1]}, std::nullopt});
  return legs;
}

std::vector<PlannedLeg> planChain(const PlanWorld& world, const WorldPoint& from, const WorldPoint& to,
                                  const std::vector<TravelMode>& chain) {
  std::size_t k = 0;
  while (k < chain.size() && chain[k] != TravelMode::Subway && chain[k] != TravelMode::Plane) ++k;
  if (k == chain.size()) return planRoadModes(world, from, to, chain);
  const std::vector<TravelMode> before(chain.begin(), chain.begin() + static_cast<std::ptrdiff_t>(k));
  const std::vector<TravelMode> after(chain.begin() + static_cast<std::ptrdiff_t>(k + 1), chain.end());
  const auto replaced = [&](TravelMode m) {
    std::vector<TravelMode> next = before;
    next.push_back(m);
    next.insert(next.end(), after.begin(), after.end());
    return normalizeModes(next);
  };
  if (chain[k] == TravelMode::Plane) {
    if (dist(from, to) < kPlaneMinUnits) return planChain(world, from, to, replaced(TravelMode::Walk));
    return {PlannedLeg{TravelMode::Plane, {WorldPoint{from.x, from.z}, WorldPoint{to.x, to.z}}, std::nullopt}};
  }
  const int sa = nearestStation(world.stations, from);
  const int sb = nearestStation(world.stations, to);
  if (sa < 0 || sb < 0 || sa == sb) return planChain(world, from, to, replaced(TravelMode::Walk));
  const Station& stationA = world.stations[static_cast<std::size_t>(sa)];
  const Station& stationB = world.stations[static_cast<std::size_t>(sb)];
  const std::optional<GraphSnap> snapA = snapToGraph(world.graph, stationA.x, stationA.z);
  const std::optional<GraphSnap> snapB = snapToGraph(world.graph, stationB.x, stationB.z);
  const WorldPoint pa = snapA ? WorldPoint{snapA->x, snapA->z} : WorldPoint{stationA.x, stationA.z};
  const WorldPoint pb = snapB ? WorldPoint{snapB->x, snapB->z} : WorldPoint{stationB.x, stationB.z};
  std::vector<PlannedLeg> legs = planChain(world, from, pa, before.empty() ? std::vector<TravelMode>{TravelMode::Walk} : before);
  legs.push_back(PlannedLeg{TravelMode::Subway, {pa, pb}, std::array<Station, 2>{stationA, stationB}});
  std::vector<PlannedLeg> rest = planChain(world, pb, to, after.empty() ? std::vector<TravelMode>{TravelMode::Walk} : after);
  for (PlannedLeg& leg : rest) legs.push_back(std::move(leg));
  return legs;
}

}  // namespace

double travelKmh(TravelMode mode) { return kKmh[modeIndex(mode)]; }

ModeSpeeds playbackSpeeds(double unitMeters, double timeScale) {
  const double k = timeScale / 3.6 / unitMeters;
  ModeSpeeds out{};
  for (std::size_t i = 0; i < out.size(); ++i) out[i] = kKmh[i] * k;
  return out;
}

double groundYFor(std::optional<ProceduralLayout> layout) {
  return layout == ProceduralLayout::Grid ? 0.05 : 0.09;
}

PlanWorld planWorldFromData(const WorldData& world) {
  std::vector<GraphRoad> roads;
  roads.reserve(world.roads.size());
  for (const Road& r : world.roads) roads.push_back(GraphRoad{r.id, r.name, r.cls, r.bridge.value_or(false), r.pts});
  return PlanWorld{buildRoadGraph(std::move(roads)), world.stations};
}

PlanWorld planWorldFromProcedural(const ProceduralWorld& world) { return PlanWorld{world.graph, world.stations}; }

std::vector<WorldPoint> roadPath(const PlanWorld& world, const WorldPoint& a, const WorldPoint& b) {
  const std::optional<GraphSnap> sa = snapToGraph(world.graph, a.x, a.z);
  const std::optional<GraphSnap> sb = snapToGraph(world.graph, b.x, b.z);
  if (!sa || !sb) return dedupe({a, b});
  const std::vector<WorldPoint> route = routeOnGraph(world.graph, *sa, *sb);
  std::vector<WorldPoint> pts;
  pts.reserve(route.size() + 2);
  pts.push_back(a);
  pts.insert(pts.end(), route.begin(), route.end());
  pts.push_back(b);
  // unreachable end: go straight from the last reachable point
  return dedupe(pts);
}

int nearestStation(const std::vector<Station>& stations, const WorldPoint& p) {
  int best = -1;
  double bd = std::numeric_limits<double>::infinity();
  for (std::size_t i = 0; i < stations.size(); ++i) {
    const double d = js_math::hypot(stations[i].x - p.x, stations[i].z - p.z);
    if (d < bd) {
      bd = d;
      best = static_cast<int>(i);
    }
  }
  return best;
}

std::vector<TravelMode> normalizeModes(const std::vector<TravelMode>& modes) {
  std::vector<TravelMode> out;
  for (const TravelMode m : modes) {
    if (out.empty() || out.back() != m) out.push_back(m);
  }
  if (out.empty()) out.push_back(TravelMode::Walk);
  return out;
}

std::vector<std::vector<WorldPoint>> splitByLength(const std::vector<WorldPoint>& pts, std::size_t n) {
  if (n <= 1) return {pts};
  const double total = polylineLength(pts);
  const double nd = static_cast<double>(n);
  std::vector<std::vector<WorldPoint>> parts;
  std::vector<WorldPoint> cur{pts[0]};
  double acc = 0.0;
  std::size_t k = 1;
  for (std::size_t i = 0; i + 1 < pts.size(); ++i) {
    const WorldPoint a = pts[i], b = pts[i + 1];
    const double seg = dist(a, b);
    while (k < n && acc + seg >= (total * static_cast<double>(k)) / nd && seg > 0) {
      const double t = ((total * static_cast<double>(k)) / nd - acc) / seg;
      const WorldPoint p{a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t};
      cur.push_back(p);
      parts.push_back(std::move(cur));
      cur = {p};
      ++k;
    }
    cur.push_back(b);
    acc += seg;
  }
  parts.push_back(std::move(cur));
  while (parts.size() < n) parts.push_back({pts.back()});
  for (std::vector<WorldPoint>& part : parts) part = dedupe(part);
  return parts;
}

std::vector<PlannedLeg> planLegs(const PlanWorld& world, const WorldPoint& from, const WorldPoint& to,
                                 const std::vector<TravelMode>& modes) {
  const std::vector<PlannedLeg> raw = planChain(world, from, to, normalizeModes(modes));
  std::vector<PlannedLeg> out;
  for (const PlannedLeg& leg : raw) {
    std::vector<WorldPoint> pts = dedupe(leg.pts);
    if (pts.size() < 2) continue;
    if (!out.empty() && out.back().mode == leg.mode && leg.mode != TravelMode::Subway && leg.mode != TravelMode::Plane) {
      std::vector<WorldPoint> merged = out.back().pts;
      merged.insert(merged.end(), pts.begin(), pts.end());
      out.back().pts = dedupe(merged);
      continue;
    }
    out.push_back(PlannedLeg{leg.mode, std::move(pts), leg.stations});
  }
  return out;
}

double planeAltitude(double t, double length) {
  return std::sin(kPi * js_math::clamp(t, 0, 1)) * jsMin(kPlaneMaxAltitude, length * 0.3);
}

double etaSeconds(double meters, TravelMode mode) { return meters / (travelKmh(mode) / 3.6); }

double remainingEtaSeconds(const std::vector<LegRemaining>& remaining, double unitMeters, double timeScale) {
  double sum = 0.0;
  for (const LegRemaining& r : remaining) sum = sum + etaSeconds(r.d * unitMeters, r.mode);
  return sum / timeScale;
}

RouteResult routeResult(const PlanWorld& world, const Projection& projection, const LngLat& from, const LngLat& to,
                        const std::vector<TravelMode>& modes) {
  const std::vector<PlannedLeg> legs = planLegs(world, projection.toWorld(from), projection.toWorld(to), modes);
  RouteResult result;
  for (const PlannedLeg& l : legs) {
    RouteLeg leg;
    leg.mode = l.mode;
    leg.meters = projection.unitsToMeters(polylineLength(l.pts));
    leg.path.reserve(l.pts.size());
    for (const WorldPoint& p : l.pts) leg.path.push_back(projection.toLngLat(p));
    result.legs.push_back(std::move(leg));
  }
  double meters = 0.0, eta = 0.0;
  for (const RouteLeg& l : result.legs) meters = meters + l.meters;
  for (const RouteLeg& l : result.legs) eta = eta + etaSeconds(l.meters, l.mode);
  result.meters = meters;
  result.etaSeconds = eta;
  return result;
}

std::optional<SnapToRoadResult> snapToRoad(const PlanWorld& world, const Projection& projection, const LngLat& coordinate,
                                           std::optional<double> maxDistanceMeters) {
  const WorldPoint p = projection.toWorld(coordinate);
  const std::optional<GraphSnap> sn = snapToGraph(world.graph, p.x, p.z);
  if (!sn) return std::nullopt;
  const double meters = projection.unitsToMeters(sn->dist);
  if (maxDistanceMeters && meters > *maxDistanceMeters) return std::nullopt;
  const GraphEdge& edge = world.graph.edges[static_cast<std::size_t>(sn->e)];
  return SnapToRoadResult{projection.toLngLat(WorldPoint{sn->x, sn->z}), world.graph.roads[static_cast<std::size_t>(edge.road)].id,
                          meters};
}

std::vector<TravelLeg> travelLegs(const std::vector<PlannedLeg>& legs, const Projection& projection) {
  std::vector<TravelLeg> out;
  out.reserve(legs.size());
  for (const PlannedLeg& l : legs) out.push_back(TravelLeg{l.mode, projection.unitsToMeters(polylineLength(l.pts))});
  return out;
}

// ---------------------------------------------------------------------------
// Follower
// ---------------------------------------------------------------------------

std::optional<TravelMode> Follower::mode() const {
  if (li < legs.size()) return legs[li].mode;
  return std::nullopt;
}

void Follower::setTrip(std::vector<PlannedLeg> trip, std::optional<double> overrideSpeed, const ModeSpeeds& tripSpeeds) {
  legs = std::move(trip);
  li = 0;
  si = 0;
  speedOverride = overrideSpeed;
  speeds = tripSpeeds;
  wait = 0;
  if (!legs.empty() && body.setMode(legs[0].mode) && legs[0].mode != TravelMode::Walk) wait = kModeSwitchWaitStart;
}

bool Follower::step(double dt) { return step(dt, speeds); }

bool Follower::step(double dt, const ModeSpeeds& stepSpeeds) {
  FollowerBody& b = body;
  if (wait > 0) {
    wait -= dt;
    b.speed = 0;
    return false;
  }
  if (li >= legs.size()) {
    b.speed = 0;
    settleY(dt);
    return false;
  }
  bool arrived = false;
  const PlannedLeg* leg = &legs[li];
  double move = (speedOverride ? *speedOverride : stepSpeeds[modeIndex(leg->mode)]) * dt;
  double moved = 0;
  while (move > 0 && leg != nullptr) {
    if (si + 1 >= leg->pts.size()) {
      ++li;
      si = 0;
      if (li < legs.size()) {
        const PlannedLeg* next = &legs[li];
        if (b.setMode(next->mode)) {
          wait = kModeSwitchWait;
          break;
        }
        leg = next;
        continue;
      }
      legs.clear();
      leg = nullptr;
      arrived = true;
      break;
    }
    const WorldPoint target = leg->pts[si + 1];
    const double dx = target.x - b.x, dz = target.z - b.z, d = js_math::hypot(dx, dz);
    if (d > 0.001) b.targetYaw = std::atan2(dx, dz);
    if (d <= move) {
      b.x = target.x;
      b.z = target.z;
      move -= d;
      moved += d;
      ++si;
    } else {
      b.x += (dx / d) * move;
      b.z += (dz / d) * move;
      moved += move;
      move = 0;
    }
  }
  b.speed = dt > 0 ? moved / dt : 0;
  if (li < legs.size() && legs[li].mode == TravelMode::Plane) {
    const PlannedLeg& cl = legs[li];
    const WorldPoint& p0 = cl.pts.front();
    const WorldPoint& p1 = cl.pts.back();
    double length = dist(p0, p1);
    if (!(length != 0.0)) length = 1;  // `|| 1` (0 and NaN)
    const double t = js_math::clamp(js_math::hypot(b.x - p0.x, b.z - p0.z) / length, 0, 1);
    b.y = groundY + planeAltitude(t, length);
    b.planePitch = -0.28 * std::cos(kPi * t);
  } else {
    settleY(dt);
  }
  return arrived;
}

bool Follower::stepCharacter(double dt) {
  const bool arrived = step(dt);
  if (!active() && body.mode != TravelMode::Walk && wait <= 0) body.setMode(TravelMode::Walk);
  return arrived;
}

void Follower::settleY(double dt) {
  FollowerBody& b = body;
  b.planePitch = 0;
  if (std::fabs(b.y - groundY) > 0.001) {
    b.y += (groundY - b.y) * jsMin(1, dt * 8);
  } else {
    b.y = groundY;
  }
}

std::vector<LegRemaining> Follower::remainingByLeg() const {
  std::vector<LegRemaining> out;
  for (std::size_t l = li; l < legs.size(); ++l) {
    const std::vector<WorldPoint>& pts = legs[l].pts;
    double d = 0;
    if (l == li) {
      if (si + 1 < pts.size()) {
        const WorldPoint& nx = pts[si + 1];
        d += js_math::hypot(nx.x - body.x, nx.z - body.z);
        for (std::size_t k = si + 1; k + 1 < pts.size(); ++k) d += dist(pts[k], pts[k + 1]);
      }
    } else {
      d = polylineLength(pts);
    }
    out.push_back(LegRemaining{legs[l].mode, d});
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

std::string_view travelEventTypeName(TravelEvent::Type type) {
  switch (type) {
    case TravelEvent::Type::Start:
      return "travel:start";
    case TravelEvent::Type::Progress:
      return "travel:progress";
    case TravelEvent::Type::Arrive:
      return "travel:arrive";
    case TravelEvent::Type::Cancel:
      return "travel:cancel";
  }
  return "travel:start";
}

bool TravelTrips::isTraveling(std::string_view characterId) const {
  return std::any_of(trips_.begin(), trips_.end(), [&](const Trip& t) { return t.characterId == characterId; });
}

std::vector<PlannedLeg> TravelTrips::start(const PlanWorld& world, const Projection& projection, std::string requestId,
                                           std::string characterId, Follower& follower, const WorldPoint& to,
                                           const std::vector<TravelMode>& modes, double timeScale,
                                           std::vector<TravelEvent>& out) {
  cancel(characterId, follower, out);
  std::vector<PlannedLeg> legs = planLegs(world, WorldPoint{follower.body.x, follower.body.z}, to, modes);
  TravelEvent started;
  started.type = TravelEvent::Type::Start;
  started.requestId = requestId;
  started.characterId = characterId;
  started.legs = travelLegs(legs, projection);
  out.push_back(std::move(started));
  if (legs.empty()) {
    TravelEvent arrive;
    arrive.type = TravelEvent::Type::Arrive;
    arrive.requestId = std::move(requestId);
    arrive.characterId = std::move(characterId);
    out.push_back(std::move(arrive));
    return legs;
  }
  trips_.push_back(Trip{std::move(requestId), std::move(characterId), legs, timeScale});
  follower.setTrip(legs, std::nullopt, playbackSpeeds(projection.unitMeters(), timeScale));
  return legs;
}

bool TravelTrips::cancel(std::string_view characterId, Follower& follower, std::vector<TravelEvent>& out) {
  const auto it = std::find_if(trips_.begin(), trips_.end(), [&](const Trip& t) { return t.characterId == characterId; });
  if (it == trips_.end()) return false;
  TravelEvent cancelled;
  cancelled.type = TravelEvent::Type::Cancel;
  cancelled.requestId = it->requestId;
  cancelled.characterId = it->characterId;
  trips_.erase(it);
  follower.setTrip({});
  out.push_back(std::move(cancelled));
  return true;
}

void TravelTrips::cancelAll(const FollowerLookup& lookup, std::vector<TravelEvent>& out) {
  std::vector<std::string> ids;
  ids.reserve(trips_.size());
  for (const Trip& t : trips_) ids.push_back(t.characterId);
  for (const std::string& id : ids) {
    Follower* follower = lookup ? lookup(id) : nullptr;
    if (follower != nullptr) {
      cancel(id, *follower, out);
    } else {
      Follower detached;
      cancel(id, detached, out);
    }
  }
}

bool TravelTrips::arrived(std::string_view characterId, std::vector<TravelEvent>& out) {
  const auto it = std::find_if(trips_.begin(), trips_.end(), [&](const Trip& t) { return t.characterId == characterId; });
  if (it == trips_.end()) return false;
  TravelEvent arrive;
  arrive.type = TravelEvent::Type::Arrive;
  arrive.requestId = it->requestId;
  arrive.characterId = it->characterId;
  trips_.erase(it);
  out.push_back(std::move(arrive));
  return true;
}

void TravelTrips::progress(const Projection& projection, const FollowerLookup& lookup, std::vector<TravelEvent>& out) const {
  for (const Trip& trip : trips_) {
    const Follower* follower = lookup ? lookup(trip.characterId) : nullptr;
    if (follower == nullptr) continue;
    const std::vector<LegRemaining> rem = follower->remainingByLeg();
    double units = 0.0;
    for (const LegRemaining& r : rem) units = units + r.d;
    TravelEvent e;
    e.type = TravelEvent::Type::Progress;
    e.requestId = trip.requestId;
    e.characterId = trip.characterId;
    e.remainingMeters = projection.unitsToMeters(units);
    e.etaSeconds = remainingEtaSeconds(rem, projection.unitMeters(), trip.timeScale);
    const std::optional<TravelMode> mode = follower->mode();
    e.mode = mode ? *mode : (!trip.legs.empty() ? trip.legs.back().mode : TravelMode::Walk);
    out.push_back(std::move(e));
  }
}

}  // namespace maprama
