// Maprama native core — drop collection judgement (port of engine-web `src/game/drops.ts`,
// `DropCollector`, and the conversion in `Features.applyDropLayer`). No visuals.
//
// Rules (engine-web):
// - a collector is a character listed in the layer's `collectorIds`, or the `isPlayer` character when
//   `collectorIds` is absent (`[]` = nobody); candidates are taken in character order;
// - it collects a drop when its squared ground distance is ≤ radius² (world units);
// - layers are judged in insertion order, drops in spec order, one collector per drop and check;
// - every collection gets a fresh collectId (the last `kMaxIssuedCollectIds` are never reused);
// - a drop is collected once per collector: history keys are `layerId \0 dropId \0 characterId`. While the
//   id stays in every spec the host sends, the same collector cannot collect it again; a drop id absent
//   from the previous spec (the React Native `DropLayer` restoring a drop after a retryable rejection)
//   forgets its history, and `removeLayer` forgets the whole layer (`layerId \0` prefix).
//
// Pure logic; wired by `GameSession` (M3a). Conformance: `drops.json`.
#pragma once

#include <cstddef>
#include <deque>
#include <functional>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "maprama/GeofenceLogic.hpp"
#include "maprama/Projection.hpp"
#include "maprama/types.hpp"

namespace maprama {

/// Most recent collectIds remembered to rule out duplicates (`MAX_ISSUED_COLLECT_IDS`).
inline constexpr std::size_t kMaxIssuedCollectIds = 10000;

/// A random RFC 4122 v4 UUID (lowercase) from `std::random_device` (arc4random on Apple platforms).
std::string randomCollectId();

/// `setDropLayer` (protocol `SetDropLayerCommand`).
struct DropLayer {
  std::string layerId;
  std::vector<DropSpec> drops;
  /// Collected when a collector is within this many meters.
  double collectRadiusMeters = 0.0;
  /// Defaults to the player when absent (`[]` = nobody).
  std::optional<std::vector<std::string>> collectorIds;
};

/// A drop in a layer (engine-web `DropState`), world units.
struct DropState {
  std::string layerId;
  DropSpec spec;
  double x = 0.0;
  double z = 0.0;
  bool collected = false;
};

/// A drop of a `setLayer` call in world units.
struct DropInput {
  DropSpec spec;
  double x = 0.0;
  double z = 0.0;
};

/// Changes made by `setLayer` (snapshots; visuals add / remove / move them).
struct LayerDiff {
  std::vector<DropState> added;
  std::vector<DropState> removed;
  std::vector<DropState> moved;
};

/// One `drop:collect` judgement.
struct DropCollection {
  /// The collected drop (already marked collected).
  DropState drop;
  std::string layerId;
  std::string dropId;
  std::string characterId;
  /// The collector's position.
  LngLat coordinate;
  std::string collectId;
};

struct DropCheckResult {
  std::vector<DropCollection> collected;
  /// Set when the collectId generator kept returning remembered ids: like engine-web's throw, the drop
  /// being judged stays collected and no collection of this check is reported.
  std::optional<std::string> error;
};

class DropCollector {
 public:
  using IdGenerator = std::function<std::string()>;

  explicit DropCollector(IdGenerator newId = randomCollectId) : newId_(std::move(newId)) {}

  /// Creates or replaces a layer (radius in world units).
  LayerDiff setLayer(const std::string& layerId, const std::vector<DropInput>& drops, double radiusUnits,
                     const std::optional<std::vector<std::string>>& collectorIds);
  /// `setDropLayer` (engine-web `applyDropLayer`): projects the drops, radius = meters / unitMeters.
  LayerDiff setLayer(const DropLayer& layer, const Projection& projection);

  /// Removes a layer; returns its uncollected drops.
  std::vector<DropState> removeLayer(std::string_view layerId);

  std::vector<std::string> layerIds() const;
  std::vector<DropState> drops(std::string_view layerId) const;
  /// Collection history keys (`layer \0 drop \0 character`), sorted.
  const std::set<std::string>& history() const { return history_; }

  /// Judges collections; each returned collection already marked its drop collected.
  DropCheckResult check(const std::vector<CharacterPosition>& collectors, const Projection& projection);

 private:
  struct Layer {
    double radius = 0.0;
    std::optional<std::vector<std::string>> collectors;
    /// Insertion-ordered (a JS Map): `put` on an existing id keeps its position.
    std::vector<DropState> drops;
    std::unordered_map<std::string, std::size_t> index;
    void put(DropState state);
    DropState* find(const std::string& id);
  };

  Layer* findLayer(std::string_view layerId);
  const Layer* findLayer(std::string_view layerId) const;
  void forget(const std::string& prefix);
  std::optional<std::string> uniqueId();

  IdGenerator newId_;
  /// Insertion-ordered layers (a JS Map).
  std::vector<std::pair<std::string, Layer>> layers_;
  std::set<std::string> history_;
  std::unordered_set<std::string> issued_;
  std::deque<std::string> issuedOrder_;
};

}  // namespace maprama
