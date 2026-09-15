// Maprama native core — subscription registry (`subscribe` / `unsubscribe`, DESIGN.md §5).
//
// Continuous topics are throttled at the source. Semantics follow engine-web (`engine.ts`):
//   - `subscribe` replaces the subscription with the same key and is immediately due (`pending`), so the
//     host receives the current value once without waiting for a change;
//   - a change marks the subscription pending; a pending subscription is emitted as soon as
//     `throttleMs` has elapsed since its last emission (a late change is emitted when the window ends,
//     never dropped);
//   - `camera:change` has one subscription per engine: its `id` is ignored (as in engine-web).
#pragma once

#include <limits>
#include <optional>
#include <string>
#include <vector>

#include "maprama/types.hpp"

namespace maprama {

class SubscriptionRegistry {
 public:
  struct Entry {
    SubscriptionTopic topic = SubscriptionTopic::CameraChange;
    std::optional<std::string> id;
    double throttleMs = 0.0;
    double lastEmitMs = -std::numeric_limits<double>::infinity();
    bool pending = true;
  };

  void subscribe(SubscriptionTopic topic, std::optional<std::string> id, double throttleMs);
  /// Returns false when nothing matched.
  bool unsubscribe(SubscriptionTopic topic, const std::optional<std::string>& id);
  void clear();

  bool has(SubscriptionTopic topic) const;
  /// Marks every subscription of `topic` pending.
  void markChanged(SubscriptionTopic topic);

  /// Entries of `topic` that are pending and outside their throttle window at `nowMs`. They are marked
  /// emitted (`lastEmitMs = nowMs`, not pending). `nextDelayMs` (if given) receives the smallest wait
  /// until a still-pending entry becomes due, or +infinity when none is waiting.
  std::vector<Entry> takeDue(SubscriptionTopic topic, double nowMs, double* nextDelayMs = nullptr);

  const std::vector<Entry>& entries() const { return entries_; }

 private:
  static std::optional<std::string> keyId(SubscriptionTopic topic, std::optional<std::string> id);

  std::vector<Entry> entries_;
};

}  // namespace maprama
