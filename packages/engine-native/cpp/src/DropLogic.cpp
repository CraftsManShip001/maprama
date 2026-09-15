#include "maprama/DropLogic.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <random>

// `dx * dx + dz * dz > r2` must not be contracted into an FMA (engine-web compares the rounded sum).
#if defined(__clang__)
#pragma clang fp contract(off)
#endif

namespace maprama {

namespace {

bool sameLook(const DropSpec& a, const DropSpec& b) {
  const std::optional<std::string> ua = a.model ? std::optional<std::string>(a.model->uri) : std::nullopt;
  const std::optional<std::string> ub = b.model ? std::optional<std::string>(b.model->uri) : std::nullopt;
  return a.type == b.type && a.rarity.value_or(Rarity::Common) == b.rarity.value_or(Rarity::Common) && ua == ub &&
         a.value == b.value;
}

std::string historyKey(std::string_view layerId, std::string_view dropId, std::string_view collectorId) {
  std::string key;
  key.reserve(layerId.size() + dropId.size() + collectorId.size() + 2);
  key.append(layerId);
  key.push_back('\0');
  key.append(dropId);
  key.push_back('\0');
  key.append(collectorId);
  return key;
}

/// `Math.max(0, r)` (NaN propagates).
double nonNegative(double r) {
  if (std::isnan(r)) return r;
  return r > 0 ? r : 0.0;
}

}  // namespace

std::string randomCollectId() {
  std::random_device device;
  std::array<std::uint8_t, 16> b{};
  for (std::size_t i = 0; i < b.size(); i += 4) {
    const std::uint32_t r = device();
    for (std::size_t k = 0; k < 4; ++k) b[i + k] = static_cast<std::uint8_t>(r >> (8 * k));
  }
  b[6] = static_cast<std::uint8_t>((b[6] & 0x0f) | 0x40);
  b[8] = static_cast<std::uint8_t>((b[8] & 0x3f) | 0x80);
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(36);
  for (std::size_t i = 0; i < b.size(); ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out.push_back('-');
    out.push_back(kHex[b[i] >> 4]);
    out.push_back(kHex[b[i] & 0x0f]);
  }
  return out;
}

void DropCollector::Layer::put(DropState state) {
  const auto it = index.find(state.spec.id);
  if (it != index.end()) {
    drops[it->second] = std::move(state);
    return;
  }
  index.emplace(state.spec.id, drops.size());
  drops.push_back(std::move(state));
}

DropState* DropCollector::Layer::find(const std::string& id) {
  const auto it = index.find(id);
  return it == index.end() ? nullptr : &drops[it->second];
}

DropCollector::Layer* DropCollector::findLayer(std::string_view layerId) {
  for (auto& entry : layers_) {
    if (entry.first == layerId) return &entry.second;
  }
  return nullptr;
}

const DropCollector::Layer* DropCollector::findLayer(std::string_view layerId) const {
  for (const auto& entry : layers_) {
    if (entry.first == layerId) return &entry.second;
  }
  return nullptr;
}

LayerDiff DropCollector::setLayer(const std::string& layerId, const std::vector<DropInput>& drops, double radiusUnits,
                                  const std::optional<std::vector<std::string>>& collectorIds) {
  // `prev` is mutated in place like engine-web's shared DropState objects (a duplicate id in `drops`
  // sees the first occurrence's update).
  Layer* prev = findLayer(layerId);
  Layer next;
  next.radius = nonNegative(radiusUnits);
  next.collectors = collectorIds;
  LayerDiff diff;
  for (const DropInput& d : drops) {
    DropState* old = prev != nullptr ? prev->find(d.spec.id) : nullptr;
    if (old != nullptr && !old->collected && sameLook(old->spec, d.spec)) {
      const bool moved = old->x != d.x || old->z != d.z;
      old->spec = d.spec;
      old->x = d.x;
      old->z = d.z;
      next.put(*old);
      if (moved) diff.moved.push_back(*old);
    } else {
      if (old != nullptr && !old->collected) diff.removed.push_back(*old);
      // A drop id absent from the previous spec is (re-)added by the host, e.g. restored after a rejected
      // server verification: forget earlier collections of it so it can be collected again.
      if (old == nullptr) forget(historyKey(layerId, d.spec.id, ""));
      DropState s{layerId, d.spec, d.x, d.z, false};
      next.put(s);
      diff.added.push_back(std::move(s));
    }
  }
  if (prev != nullptr) {
    for (const DropState& old : prev->drops) {
      if (next.index.count(old.spec.id) == 0 && !old.collected) diff.removed.push_back(old);
    }
    *prev = std::move(next);
  } else {
    layers_.emplace_back(layerId, std::move(next));
  }
  return diff;
}

LayerDiff DropCollector::setLayer(const DropLayer& layer, const Projection& projection) {
  std::vector<DropInput> inputs;
  inputs.reserve(layer.drops.size());
  for (const DropSpec& spec : layer.drops) {
    const WorldPoint p = projection.toWorld(spec.coordinate);
    inputs.push_back(DropInput{spec, p.x, p.z});
  }
  return setLayer(layer.layerId, inputs, layer.collectRadiusMeters / projection.unitMeters(), layer.collectorIds);
}

std::vector<DropState> DropCollector::removeLayer(std::string_view layerId) {
  const auto it = std::find_if(layers_.begin(), layers_.end(), [&](const auto& e) { return e.first == layerId; });
  if (it == layers_.end()) return {};
  Layer layer = std::move(it->second);
  layers_.erase(it);
  std::string prefix(layerId);
  prefix.push_back('\0');
  forget(prefix);
  std::vector<DropState> out;
  for (DropState& d : layer.drops) {
    if (!d.collected) out.push_back(std::move(d));
  }
  return out;
}

std::vector<std::string> DropCollector::layerIds() const {
  std::vector<std::string> out;
  out.reserve(layers_.size());
  for (const auto& e : layers_) out.push_back(e.first);
  return out;
}

std::vector<DropState> DropCollector::drops(std::string_view layerId) const {
  const Layer* layer = findLayer(layerId);
  return layer != nullptr ? layer->drops : std::vector<DropState>{};
}

DropCheckResult DropCollector::check(const std::vector<CharacterPosition>& collectors, const Projection& projection) {
  DropCheckResult result;
  for (auto& entry : layers_) {
    const std::string& layerId = entry.first;
    Layer& layer = entry.second;
    std::vector<const CharacterPosition*> allowed;
    for (const CharacterPosition& c : collectors) {
      const bool ok = layer.collectors ? std::find(layer.collectors->begin(), layer.collectors->end(), c.id) != layer.collectors->end()
                                       : c.isPlayer;
      if (ok) allowed.push_back(&c);
    }
    if (allowed.empty()) continue;
    const double r2 = layer.radius * layer.radius;
    for (DropState& d : layer.drops) {
      if (d.collected) continue;
      for (const CharacterPosition* c : allowed) {
        std::string key = historyKey(layerId, d.spec.id, c->id);
        if (history_.count(key) > 0) continue;
        const double dx = c->x - d.x, dz = c->z - d.z;
        if (dx * dx + dz * dz > r2) continue;
        d.collected = true;
        history_.insert(std::move(key));
        std::optional<std::string> id = uniqueId();
        if (!id) {
          result.collected.clear();
          result.error = "collectId generator keeps returning duplicates";
          return result;
        }
        result.collected.push_back(
            DropCollection{d, layerId, d.spec.id, c->id, projection.toLngLat(WorldPoint{c->x, c->z}), std::move(*id)});
        break;
      }
    }
  }
  return result;
}

void DropCollector::forget(const std::string& prefix) {
  for (auto it = history_.lower_bound(prefix); it != history_.end() && it->compare(0, prefix.size(), prefix) == 0;) {
    it = history_.erase(it);
  }
}

std::optional<std::string> DropCollector::uniqueId() {
  for (int i = 0; i < 8; ++i) {
    std::string id = newId_ ? newId_() : std::string();
    if (!id.empty() && issued_.count(id) == 0) {
      issued_.insert(id);
      issuedOrder_.push_back(id);
      // drop the oldest id once the cap is exceeded
      if (issued_.size() > kMaxIssuedCollectIds) {
        issued_.erase(issuedOrder_.front());
        issuedOrder_.pop_front();
      }
      return id;
    }
  }
  return std::nullopt;
}

}  // namespace maprama
