#include "maprama/SubscriptionRegistry.hpp"

#include <algorithm>
#include <utility>

namespace maprama {

std::optional<std::string> SubscriptionRegistry::keyId(SubscriptionTopic topic, std::optional<std::string> id) {
  if (topic == SubscriptionTopic::CameraChange) return std::nullopt;
  return id;
}

void SubscriptionRegistry::subscribe(SubscriptionTopic topic, std::optional<std::string> id, double throttleMs) {
  id = keyId(topic, std::move(id));
  for (Entry& e : entries_) {
    if (e.topic == topic && e.id == id) {
      e = Entry{topic, std::move(id), throttleMs};
      return;
    }
  }
  entries_.push_back(Entry{topic, std::move(id), throttleMs});
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

}  // namespace maprama
