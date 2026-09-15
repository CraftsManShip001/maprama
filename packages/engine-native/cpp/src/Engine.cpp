#include "maprama/Engine.hpp"

#include <chrono>
#include <mutex>
#include <utility>

#include "maprama/Dispatcher.hpp"
#include "maprama/GameSession.hpp"
#include "maprama/MapSession.hpp"
#include "maprama/WorldStore.hpp"

namespace maprama {

namespace {

double steadyClockMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

/// M1 engine: synchronous dispatch under one mutex (DESIGN.md §3). Commands arrive on the JS thread,
/// platform callbacks (camera, replies, frames) on the main thread; both take the same lock, and the map
/// adapter never calls back synchronously, so there is no lock re-entry.
class CoreEngine final : public Engine {
 public:
  CoreEngine(std::shared_ptr<MessageSink> sink, EngineConfig config)
      : sink_(std::move(sink)),
        world_(createWorldStore()),
        clock_(config.clockMs ? std::move(config.clockMs) : ClockMs(steadyClockMs)),
        session_(*sink_, *world_, clock_),
        game_(*sink_, *world_, session_, clock_, std::move(config.random), std::move(config.collectId)),
        dispatcher_(*sink_, makeSubsystems(), DispatcherOptions{config.info, config.validateOutgoingEvents}) {
    session_.bindEmitter(&dispatcher_);
    game_.bindEmitter(&dispatcher_);
    session_.setHooks(&game_);
  }

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
    if (!stopped_) session_.setViewport(viewport);
  }

  void frame(double /*timestampMs*/) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_) return;
    session_.frame();
    game_.frame();
  }

  void tap(double x, double y) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) session_.tap(x, y);
  }

  void zoomButton(bool zoomIn) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) session_.zoomButton(zoomIn);
  }

  const WorldStore& worldStore() const override { return *world_; }

  void attachMapAdapter(std::shared_ptr<MapAdapter> adapter) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_) return;
    // The game session first: the map session's style triggers `styleSent`, which re-sends the game sources.
    game_.attachAdapter(adapter);
    session_.attachAdapter(std::move(adapter));
  }

  void detachMapAdapter() override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_) return;
    session_.detachAdapter();
    game_.detachAdapter();
  }

  void onCameraChanged(const MapCameraPose& pose) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) session_.onCameraChanged(pose);
  }

  void onProjected(std::uint64_t token, double x, double y) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) session_.onProjected(token, x, y);
  }

  void onUnprojected(std::uint64_t token, std::optional<LngLat> coordinate) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) session_.onUnprojected(token, coordinate);
  }

  void onTextFetched(std::uint64_t token, bool ok, std::string bodyOrError) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) session_.onTextFetched(token, ok, bodyOrError);
  }

  void onPointsProjected(std::uint64_t token, std::vector<ScreenPoint> points) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) session_.onPointsProjected(token, points);
  }

  void onBuildingQueried(std::uint64_t token, std::optional<std::string> buildingId, std::optional<LngLat> ground) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) session_.onBuildingQueried(token, buildingId, ground);
  }

  void onDeviceLocation(const LocationFix& fix) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) game_.onDeviceLocation(fix);
  }

  void onDeviceLocationError(std::string message) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) game_.onDeviceLocationError(message);
  }

  void onUserPan() override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stopped_) game_.onUserPan();
  }

  CameraState cameraState() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return session_.cameraState();
  }

  std::string styleJson() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return session_.styleJson();
  }

  void shutdown() override {
    std::lock_guard<std::mutex> lock(mutex_);
    stopped_ = true;
    game_.shutdown();
    session_.shutdown();
  }

 private:
  Subsystems makeSubsystems() {
    Subsystems s;
    s.world = world_.get();
    s.session = &session_;
    s.game = &game_;
    return s;
  }

  std::shared_ptr<MessageSink> sink_;
  std::unique_ptr<WorldStore> world_;
  ClockMs clock_;
  MapSession session_;
  GameSession game_;
  Dispatcher dispatcher_;
  mutable std::mutex mutex_;
  bool started_ = false;
  bool stopped_ = false;
};

}  // namespace

std::unique_ptr<Engine> createEngine(std::shared_ptr<MessageSink> sink, EngineConfig config) {
  return std::make_unique<CoreEngine>(std::move(sink), std::move(config));
}

}  // namespace maprama
