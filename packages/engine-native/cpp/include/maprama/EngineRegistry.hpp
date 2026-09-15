// Maprama native core — process-wide `engineId -> Engine` registry shared by both platforms.
//
// The platform view owns its engine and registers it on mount; the TurboModule (`postMessage`) looks
// engines up by id. Entries are weak, so a destroyed view never keeps its engine alive.
#pragma once

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace maprama {

class Engine;

class EngineRegistry {
 public:
  static EngineRegistry& shared();

  /// Registers (or replaces) `engineId`.
  void add(const std::string& engineId, const std::shared_ptr<Engine>& engine);
  /// Removes `engineId` if it still refers to `engine` (nullptr removes unconditionally).
  void remove(const std::string& engineId, const Engine* engine = nullptr);
  /// The live engine for `engineId`, or nullptr.
  std::shared_ptr<Engine> find(const std::string& engineId) const;

 private:
  mutable std::mutex mutex_;
  std::unordered_map<std::string, std::weak_ptr<Engine>> engines_;
};

}  // namespace maprama
