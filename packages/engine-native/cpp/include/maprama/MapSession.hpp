// Maprama native core — M1 map session: world -> map style, camera, `camera:change`, `project` / `unproject`.
//
// Owns the M1 behaviour behind the Dispatcher (DESIGN.md §5, §11 M1) and drives the platform map through
// `MapAdapter`. Not thread-safe: the Engine calls it with its lock held.
//
// Camera model: the session keeps the protocol `CameraState` (meters / degrees). Commands merge into it
// (`setCamera`, DESIGN.md §5.1) and are sent to the adapter as MapLibre poses (`camera_math`); the
// adapter reports every camera change (gestures, animations) back, which updates the state and feeds
// the throttled `camera:change` subscription.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "maprama/CameraController.hpp"
#include "maprama/MapAdapter.hpp"
#include "maprama/MessageSink.hpp"
#include "maprama/SubscriptionRegistry.hpp"
#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

class WorldStore;
struct WorldLoadReport;

/// Monotonic clock in milliseconds (injectable for tests).
using ClockMs = std::function<double()>;

/// Error code used when a request needs the map view (adapter + laid-out viewport) and there is none.
inline constexpr std::string_view kNotReadyCode = "not_ready";

class MapSession {
 public:
  MapSession(MessageSink& sink, WorldStore& world, ClockMs clock);

  /// Events are emitted through the Dispatcher (it assigns `seq`); bound once by the Engine.
  void bindEmitter(EventEmitter* events) { events_ = events; }

  // ---- platform side -------------------------------------------------------------------------------
  void attachAdapter(std::shared_ptr<MapAdapter> adapter);
  /// Fails pending requests / URL loads (the view is gone) and forgets the adapter.
  void detachAdapter();
  void setViewport(const Viewport& viewport);
  void onCameraChanged(const MapCameraPose& pose);
  void onProjected(std::uint64_t token, double x, double y);
  void onUnprojected(std::uint64_t token, const std::optional<LngLat>& coordinate);
  void onTextFetched(std::uint64_t token, bool ok, const std::string& bodyOrError);
  /// Flushes throttled subscriptions that became due (`MapAdapter::scheduleFrame`).
  void frame();

  // ---- commands (already validated by `decodeCommand`) -------------------------------------------
  void init(const json::Value& msg);
  void setCamera(const json::Value& cameraSpec);
  void subscribeCamera(double throttleMs);
  void unsubscribeCamera();
  /// `project` / `unproject`; answered asynchronously through the adapter.
  void request(const std::string& requestId, RequestMethod method, const json::Value& params);

  void shutdown();

  // ---- state (tests, diagnostics) ----------------------------------------------------------------
  bool worldReady() const { return worldReady_; }
  const CameraState& cameraState() const { return state_; }
  const Viewport& viewport() const { return viewport_; }
  const std::string& styleJson() const { return styleJson_; }
  MapCameraPose poseFor(const CameraState& state) const;
  MapCameraLimits limits() const;
  std::size_t pendingRequests() const { return pendingRequests_.size(); }

 private:
  struct PendingRequest {
    std::string requestId;
    RequestMethod method = RequestMethod::Project;
  };
  struct PendingWorld {
    std::uint64_t token = 0;
    std::string url;
    json::Value initMsg;
  };

  void loadWorldValue(const json::Value& worldData, const json::Value& initMsg, const std::string& url);
  void onWorldLoaded(const WorldLoadReport& report, const json::Value& initMsg);
  void emitError(std::string_view code, std::string message, bool fatal);
  bool canMoveCamera() const;
  void sendState();
  void pushLimits();
  void cameraChanged();
  void pump();
  void respondOk(const std::string& requestId, json::Value result);
  void respondError(const std::string& requestId, std::string_view code, std::string message);
  double distanceMin() const;
  double distanceMax() const;
  double referenceLat() const;
  void log(LogLevel level, const std::string& message);

  MessageSink& sink_;
  WorldStore& world_;
  ClockMs clock_;
  EventEmitter* events_ = nullptr;
  std::shared_ptr<MapAdapter> adapter_;
  Viewport viewport_;
  CameraState state_;
  bool worldReady_ = false;
  /// `state_` changed while no adapter / viewport could take it; sent on the next opportunity.
  bool cameraUnsent_ = false;
  std::string styleJson_;
  SubscriptionRegistry subscriptions_;
  std::map<std::uint64_t, PendingRequest> pendingRequests_;
  std::optional<PendingWorld> pendingWorld_;
  std::uint64_t nextToken_ = 1;
  /// Absolute time of the frame already requested from the adapter (+inf = none).
  double scheduledFrameAtMs_;
};

}  // namespace maprama
