#include "maprama/GeofenceLogic.hpp"

#include <utility>

#include "maprama/RoadGraph.hpp"

// Keep V8's double arithmetic (no fused multiply-add) so boundary decisions match engine-web.
#if defined(__clang__)
#pragma clang fp contract(off)
#endif

namespace maprama {

std::vector<WorldFence> worldFences(const std::vector<GeofenceSpec>& specs, const Projection& projection) {
  std::vector<WorldFence> out;
  out.reserve(specs.size());
  for (const GeofenceSpec& g : specs) {
    const WorldPoint p = projection.toWorld(g.center);
    out.push_back(WorldFence{g.id, p.x, p.z, g.radiusMeters / projection.unitMeters()});
  }
  return out;
}

void GeofenceTracker::set(std::vector<WorldFence> fences) {
  fences_ = std::move(fences);
  std::map<std::string, std::set<std::string>, std::less<>> next;
  for (const WorldFence& f : fences_) {
    const auto old = inside_.find(f.id);
    next[f.id] = old != inside_.end() ? old->second : std::set<std::string>{};
  }
  inside_ = std::move(next);
}

std::vector<GeofenceTransition> GeofenceTracker::update(const std::vector<CharacterPosition>& characters) {
  std::vector<GeofenceTransition> events;
  std::set<std::string_view> present;
  for (const CharacterPosition& c : characters) present.insert(c.id);
  for (const WorldFence& f : fences_) {
    std::set<std::string>& inside = inside_[f.id];
    for (auto it = inside.begin(); it != inside.end();) {
      if (present.count(*it) == 0) {
        it = inside.erase(it);
      } else {
        ++it;
      }
    }
    for (const CharacterPosition& c : characters) {
      const bool now = js_math::hypot(c.x - f.x, c.z - f.z) < f.r;
      const bool was = inside.count(c.id) > 0;
      if (now == was) continue;
      if (now) {
        inside.insert(c.id);
        events.push_back(GeofenceTransition{true, f.id, c.id});
      } else {
        inside.erase(c.id);
        events.push_back(GeofenceTransition{false, f.id, c.id});
      }
    }
  }
  return events;
}

bool GeofenceTracker::isInside(std::string_view geofenceId, std::string_view characterId) const {
  const auto it = inside_.find(geofenceId);
  return it != inside_.end() && it->second.count(std::string(characterId)) > 0;
}

}  // namespace maprama
