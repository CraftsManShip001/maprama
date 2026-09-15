#include "maprama/Engine.hpp"

#include <mutex>
#include <utility>

#include "maprama/Dispatcher.hpp"
#include "maprama/WorldStore.hpp"

namespace maprama {

namespace {

/// Skeleton engine: synchronous dispatch under a mutex. The production core replaces the mutex with a
/// single-consumer command queue drained on the core thread at the start of each frame (DESIGN.md §3).
class CoreEngine final : public Engine {
 public:
  CoreEngine(std::shared_ptr<MessageSink> sink, EngineConfig config)
      : sink_(std::move(sink)),
        world_(createWorldStore()),
        dispatcher_(*sink_, makeSubsystems(), DispatcherOptions{config.info, config.validateOutgoingEvents}) {}

  void start() override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_ || started_) return;
    started_ = true;
    dispatcher_.emitReady();
  }

  void postMessage(std::string_view envelopeJson) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) dispatcher_.dispatch(envelopeJson);
  }

  void postEnvelope(json::Value envelope) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) dispatcher_.dispatchValue(std::move(envelope));
  }

  void postMessages(const std::vector<std::string>& envelopesJson) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_) return;
    for (const std::string& envelope : envelopesJson) dispatcher_.dispatch(envelope);
  }

  void setViewport(const Viewport& viewport) override {
    std::lock_guard<std::mutex> lock(mutex_);
    viewport_ = viewport;
  }

  void frame(double timestampMs) override {
    std::lock_guard<std::mutex> lock(mutex_);
    lastFrameMs_ = timestampMs;  // subsystem updates land with their implementations
  }

  void tap(double x, double y) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_) return;
    sink_->onLog(LogLevel::Warn, "engine-native: tap(" + json::numberToString(x) + ", " + json::numberToString(y) +
                                     ") ignored: hit testing is not implemented");
  }

  const WorldStore& worldStore() const override { return *world_; }

  void shutdown() override {
    std::lock_guard<std::mutex> lock(mutex_);
    stopped_ = true;
  }

 private:
  Subsystems makeSubsystems() {
    Subsystems s;
    s.world = world_.get();
    return s;
  }

  std::shared_ptr<MessageSink> sink_;
  std::unique_ptr<WorldStore> world_;
  Dispatcher dispatcher_;
  std::mutex mutex_;
  Viewport viewport_;
  double lastFrameMs_ = 0.0;
  bool started_ = false;
  bool stopped_ = false;
};

}  // namespace

std::unique_ptr<Engine> createEngine(std::shared_ptr<MessageSink> sink, EngineConfig config) {
  return std::make_unique<CoreEngine>(std::move(sink), std::move(config));
}

}  // namespace maprama
