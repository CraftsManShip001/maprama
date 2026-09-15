#include "maprama/EngineRegistry.hpp"

#include "maprama/Engine.hpp"

namespace maprama {

EngineRegistry& EngineRegistry::shared() {
  static EngineRegistry* registry = new EngineRegistry();  // never destroyed: used from any thread at exit
  return *registry;
}

void EngineRegistry::add(const std::string& engineId, const std::shared_ptr<Engine>& engine) {
  std::lock_guard<std::mutex> lock(mutex_);
  engines_[engineId] = engine;
}

void EngineRegistry::remove(const std::string& engineId, const Engine* engine) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = engines_.find(engineId);
  if (it == engines_.end()) return;
  if (engine != nullptr) {
    std::shared_ptr<Engine> current = it->second.lock();
    if (current && current.get() != engine) return;
  }
  engines_.erase(it);
}

std::shared_ptr<Engine> EngineRegistry::find(const std::string& engineId) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = engines_.find(engineId);
  return it == engines_.end() ? nullptr : it->second.lock();
}

}  // namespace maprama
