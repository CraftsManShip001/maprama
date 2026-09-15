// Maprama native core — subscription registry (`subscribe` / `unsubscribe`, DESIGN.md §5).
//
// Continuous topics are throttled at the source. Semantics follow engine-web (`engine.ts`):
//   - `subscribe` replaces the subscription with the same key and is immediately due (`pending`), so the
//     host receives the current value once without waiting for a change;
//   - a change marks the subscription pending; a pending subscription is emitted as soon as
//     `throttleMs` has elapsed since its last emission (a late change is emitted when the window ends,
//     never dropped);
//   - `camera:change` has one subscription per engine: its `id` is ignored (as in engine-web).
//
// The per-key API (`wants` / `due` / `resetKey`, M3a) is engine-web's `ThrottledTopic` for the
// `character:position` and `travel:progress` topics: a subscription without `id` matches every key, and
// throttling is tracked per subscription **and** per key (an "all characters" subscription still delivers
// every character at its rate).
#pragma once

#include <limits>
#include <map>
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
    /// Per-key last emission (per-key API).
    std::map<std::string, double> lastByKey;
  };

  /// True when a subscription of `topic` matches `key` (its id, or no id), regardless of throttling.
  bool wants(SubscriptionTopic topic, const std::string& key) const;
  /// engine-web `ThrottledTopic.due`: true when an event for `key` may be sent at `nowMs`; records it as
  /// sent for every matching subscription that was due. `waitMs` (if given) receives the smallest wait
  /// until a matching subscription that was not due becomes due (+infinity when none).
  bool due(SubscriptionTopic topic, const std::string& key, double nowMs, double* waitMs = nullptr);
  /// Forgets the per-key throttle state of `key` (e.g. a removed character).
  void resetKey(SubscriptionTopic topic, const std::string& key);

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
