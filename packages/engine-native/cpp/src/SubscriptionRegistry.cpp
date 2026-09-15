#include "maprama/SubscriptionRegistry.hpp"

#include <algorithm>
#include <utility>

namespace maprama {

std::optional<std::string> SubscriptionRegistry::keyId(SubscriptionTopic topic, std::optional<std::string> id) {
  if (topic == SubscriptionTopic::CameraChange) return std::nullopt;
  return id;
}

void SubscriptionRegistry::subscribe(SubscriptionTopic topic, std::optional<std::string> id, double throttleMs) {
  Entry fresh;
  fresh.topic = topic;
  fresh.id = keyId(topic, std::move(id));
  fresh.throttleMs = throttleMs;
  for (Entry& e : entries_) {
    if (e.topic == topic && e.id == fresh.id) {
      e = std::move(fresh);
      return;
    }
  }
  entries_.push_back(std::move(fresh));
}

bool SubscriptionRegistry::unsubscribe(SubscriptionTopic topic, const std::optional<std::string>& id) {
  const std::optional<std::string> key = keyId(topic, id);
  const auto before = entries_.size();
  entries_.erase(std::remove_if(entries_.begin(), entries_.end(),
                                [&](const Entry& e) { return e.topic == topic && e.id == key; }),
                 entries_.end());
  return entries_.size() != before;
}

void SubscriptionRegistry::clear() { entries_.clear(); }

bool SubscriptionRegistry::has(SubscriptionTopic topic) const {
  return std::any_of(entries_.begin(), entries_.end(), [topic](const Entry& e) { return e.topic == topic; });
}

void SubscriptionRegistry::markChanged(SubscriptionTopic topic) {
  for (Entry& e : entries_) {
    if (e.topic == topic) e.pending = true;
  }
}

std::vector<SubscriptionRegistry::Entry> SubscriptionRegistry::takeDue(SubscriptionTopic topic, double nowMs,
                                                                        double* nextDelayMs) {
  std::vector<Entry> due;
  double next = std::numeric_limits<double>::infinity();
  for (Entry& e : entries_) {
    if (e.topic != topic || !e.pending) continue;
    const double wait = e.lastEmitMs + e.throttleMs - nowMs;
    if (wait <= 0) {
      e.lastEmitMs = nowMs;
      e.pending = false;
      due.push_back(e);
    } else {
      next = std::min(next, wait);
    }
  }
  if (nextDelayMs != nullptr) *nextDelayMs = next;
  return due;
}

bool SubscriptionRegistry::wants(SubscriptionTopic topic, const std::string& key) const {
  return std::any_of(entries_.begin(), entries_.end(),
                     [&](const Entry& e) { return e.topic == topic && (!e.id || *e.id == key); });
}

bool SubscriptionRegistry::due(SubscriptionTopic topic, const std::string& key, double nowMs, double* waitMs) {
  bool ok = false;
  double wait = std::numeric_limits<double>::infinity();
  // engine-web checks the subscription for the key first, then the "all" subscription.
  for (int pass = 0; pass < 2; ++pass) {
    for (Entry& e : entries_) {
      if (e.topic != topic) continue;
      if (pass == 0 ? !(e.id && *e.id == key) : e.id.has_value()) continue;
      const double throttle = std::max(0.0, e.throttleMs);
      const auto last = e.lastByKey.find(key);
      if (last == e.lastByKey.end() || nowMs - last->second >= throttle) {
        e.lastByKey[key] = nowMs;
        ok = true;
      } else {
        wait = std::min(wait, throttle - (nowMs - last->second));
      }
    }
  }
  if (waitMs != nullptr) *waitMs = wait;
  return ok;
}

void SubscriptionRegistry::resetKey(SubscriptionTopic topic, const std::string& key) {
  for (Entry& e : entries_) {
    if (e.topic == topic) e.lastByKey.erase(key);
  }
}

}  // namespace maprama
