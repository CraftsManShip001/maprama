// Maprama native core — map session: world -> map style, theme, camera, `camera:change`, `project` /
// `unproject` (M1) and the M2a diorama look (3D buildings, themes, building styles, presses, map UI,
// overlay anchors), all on the official MapLibre SDKs through `MapAdapter`.
//
// Owns the behaviour behind the Dispatcher (DESIGN.md §5, §11) and drives the platform map through
// `MapAdapter`. Not thread-safe: the Engine calls it with its lock held.
//
// Camera model: the session keeps the protocol `CameraState` (meters / degrees). Commands merge into it
// (`setCamera`, DESIGN.md §5.1) and are sent to the adapter as MapLibre poses (`camera_math`); the
// adapter reports every camera change (gestures, animations) back, which updates the state and feeds
// the throttled `camera:change` subscription, the scale bar and the overlay anchor positions.
//
// Style model: the GeoJSON sources are built once per world; the layers are rebuilt from the resolved
// theme (`MapLook`) and the building overrides, and only the paint properties that changed are sent.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "maprama/CameraController.hpp"
#include "maprama/MapAdapter.hpp"
#include "maprama/MapLook.hpp"
#include "maprama/MessageSink.hpp"
#include "maprama/SubscriptionRegistry.hpp"
#include "maprama/ThemeResolver.hpp"
#include "maprama/WorldStyle.hpp"
#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

class WorldStore;
struct WorldLoadReport;

/// Monotonic clock in milliseconds (injectable for tests).
using ClockMs = std::function<double()>;

/// Error code used when a request needs the map view (adapter + laid-out viewport) and there is none.
inline constexpr std::string_view kNotReadyCode = "not_ready";
/// engine-web's error code for `setBuildingStyle` with an id that is not a rendered building.
inline constexpr std::string_view kUnknownBuildingCode = "unknown_building";
/// `overlay:positions` is emitted at most once per frame (60 Hz).
inline constexpr double kOverlayIntervalMs = 16.0;
/// engine-web `OverlayTracker` epsilon: smaller moves are not re-sent.
inline constexpr double kOverlayEpsilonPx = 0.25;
/// engine-web zoom buttons: ±1.45x camera distance over 250 ms.
inline constexpr double kZoomButtonStep = 1.45;
inline constexpr double kZoomButtonMs = 250.0;

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
  void onPointsProjected(std::uint64_t token, const std::vector<ScreenPoint>& points);
  void onUnprojected(std::uint64_t token, const std::optional<LngLat>& coordinate);
  void onBuildingQueried(std::uint64_t token, const std::optional<std::string>& buildingId, const std::optional<LngLat>& ground);
  void onTextFetched(std::uint64_t token, bool ok, const std::string& bodyOrError);
  /// Flushes throttled subscriptions / overlay positions that became due (`MapAdapter::scheduleFrame`).
  void frame();
  /// Platform tap (dp): hit-tests the 3D buildings, then emits `building:press` or `map:press`.
  void tap(double x, double y);
  /// Map UI zoom button.
  void zoomButton(bool zoomIn);

  // ---- commands (already validated by `decodeCommand`) -------------------------------------------
  void init(const json::Value& msg);
  void setCamera(const json::Value& cameraSpec);
  void setTheme(const json::Value& themeSpec);
  void setUi(const json::Value& uiSpec);
  /// `style` is a `BuildingStyle` object or `null` (clears the override).
  void setBuildingStyle(const std::string& buildingId, const json::Value& style);
  void setOverlayAnchors(const json::Value& anchors);
  void subscribeCamera(double throttleMs);
  void unsubscribeCamera();
  /// `project` / `unproject`; answered asynchronously through the adapter.
  void request(const std::string& requestId, RequestMethod method, const json::Value& params);

  void shutdown();

  // ---- state (tests, diagnostics) ----------------------------------------------------------------
  bool worldReady() const { return worldReady_; }
  const CameraState& cameraState() const { return state_; }
  const Viewport& viewport() const { return viewport_; }
  /// The complete current style (world sources, themed layers, light) as sent on attach.
  const std::string& styleJson() const;
  const ResolvedTheme& theme() const { return theme_; }
  const MapLook& look() const { return look_; }
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

  /// What a generated (`procedural`) world carries beyond WorldData (DESIGN.md §6.8).
  struct WorldExtras {
    /// engine-web `world.start`: the default camera target (WorldData worlds use the plaza / bounds centre).
    std::optional<WorldPoint> start;
    /// Palette index per `WorldData::buildings` entry (engine-web keeps the generator's `ci`).
    std::vector<std::uint32_t> palette;
  };

  /// `init` with `world.kind = "procedural"`: generate (ProceduralWorld.hpp), convert to WorldData, load.
  void loadProceduralWorld(const json::Value& source, const json::Value& initMsg);
  void loadWorldValue(const json::Value& worldData, const json::Value& initMsg, const std::string& url,
                      const WorldExtras& extras = {});
  void onWorldLoaded(const WorldLoadReport& report, const json::Value& initMsg, const WorldExtras& extras);
  void setThemeState(const json::Value& themeSpec);
  void setUiState(const json::Value& uiSpec);
  /// Rebuilds the layers from the look + building overrides and sends the changed paint properties / light.
  void applyLook();
  BuildingPaint buildingPaint() const;
  void pushUi();
  double metersPerDp() const;
  void emitError(std::string_view code, std::string message, bool fatal);
  bool canMoveCamera() const;
  bool viewReady() const;
  void sendState();
  void pushLimits();
  void cameraChanged();
  void pump();
  void pumpOverlay(double now, double* nextDelay);
  void requestFrame(double now, double delayMs);
  void respondOk(const std::string& requestId, json::Value result);
  void respondError(const std::string& requestId, std::string_view code, std::string message);
  double distanceMin() const;
  double distanceMax() const;
  double referenceLat() const;
  void log(LogLevel level, const std::string& message);
  void warnOnce(const std::string& key, const std::string& message);

  MessageSink& sink_;
  WorldStore& world_;
  ClockMs clock_;
  const ThemeResolver& themes_;
  EventEmitter* events_ = nullptr;
  std::shared_ptr<MapAdapter> adapter_;
  Viewport viewport_;
  CameraState state_;
  bool worldReady_ = false;
  /// `state_` changed while no adapter / viewport could take it; sent on the next opportunity.
  bool cameraUnsent_ = false;

  // Theme and style.
  ResolvedTheme theme_;
  MapLook look_;
  std::vector<RenderedBuilding> rendered_;
  std::unordered_map<std::string, std::size_t> renderedIndex_;
  /// Building overrides by id (ordered: deterministic style expressions).
  std::map<std::string, BuildingOverride> buildingStyles_;
  json::Value sources_;
  json::Value layers_;
  MapLight light_;
  mutable std::string styleJson_;
  mutable bool styleDirty_ = false;

  // Map UI.
  MapUiSpec ui_;
  MapUiState uiSent_;
  bool uiSentValid_ = false;

  // Overlay anchors.
  std::vector<OverlayAnchor> anchors_;
  std::vector<OverlayAnchor> anchorsInFlight_;
  std::vector<ScreenPoint> lastPositions_;
  std::uint64_t overlayToken_ = 0;
  bool overlayWanted_ = false;
  bool overlayDirty_ = true;
  double lastOverlayRequestMs_;

  SubscriptionRegistry subscriptions_;
  std::map<std::uint64_t, PendingRequest> pendingRequests_;
  std::set<std::uint64_t> pendingTaps_;
  std::optional<PendingWorld> pendingWorld_;
  std::set<std::string> warned_;
  std::uint64_t nextToken_ = 1;
  /// Absolute time of the frame already requested from the adapter (+inf = none).
  double scheduledFrameAtMs_;
};

}  // namespace maprama
