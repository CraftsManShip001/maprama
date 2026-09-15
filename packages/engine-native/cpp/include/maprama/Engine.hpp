// Maprama native core — engine facade used by the platform wrappers
// (iOS `MapramaNativeView` / Android `MapramaNativeView`, `MapramaEngineModule`).
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/CameraController.hpp"
#include "maprama/GltfLoader.hpp"
#include "maprama/MapAdapter.hpp"
#include "maprama/MessageSink.hpp"
#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

class WorldStore;

inline constexpr std::string_view kCoreName = "maprama-native";
inline constexpr std::string_view kCoreVersion = "0.1.0";

struct EngineConfig {
  EngineInfo info{std::string(kCoreName), std::string(kCoreVersion), EngineKind::Native};
  /// Validate outgoing events against the protocol (enable in debug / tests).
  bool validateOutgoingEvents = false;
  /// Monotonic milliseconds used for subscription throttling; steady_clock when empty (tests inject one).
  std::function<double()> clockMs;
  /// Uniform [0, 1) source of the simulated location walker; a seeded std::mt19937 when empty (tests inject one).
  std::function<double()> random;
  /// `drop:collect` collectId generator; `randomCollectId` (UUID v4) when empty (tests inject one).
  std::function<std::string()> collectId;
  /// M3b: runs glTF parsing off the engine lock (a detached std::thread per job when empty; tests inject a queue).
  /// The job's result is then delivered with the engine lock held.
  std::function<void(std::function<void()>)> runAsync;
  /// M3b: the platform image decoder for glTF base colour textures (ImageIO / BitmapFactory), called on worker
  /// threads; textures are skipped when empty.
  ImageDecoder decodeImage;
};

/// One engine instance per map view. All methods are safe to call from any thread: M1 serialises them
/// with one mutex per engine (DESIGN.md §3 "M1 simplification"); the core-thread queue replaces it later
/// without changing this interface.
class Engine {
 public:
  virtual ~Engine() = default;

  /// Emits `ready`. Call once after the sink is ready to receive events.
  virtual void start() = 0;

  /// One command envelope as JSON text (`encodeCommand` output).
  virtual void postMessage(std::string_view envelopeJson) = 0;
  /// One pre-parsed envelope (JSI object path).
  virtual void postEnvelope(json::Value envelope) = 0;
  /// A transport batch: envelopes are dispatched in order, each decoded independently.
  virtual void postMessages(const std::vector<std::string>& envelopesJson) = 0;

  virtual void setViewport(const Viewport& viewport) = 0;
  /// Render-thread frame callback (CADisplayLink / Choreographer), milliseconds.
  virtual void frame(double timestampMs) = 0;
  /// Tap from the platform gesture recogniser, density-independent pixels: hit-tests the 3D buildings
  /// through `MapAdapter::queryBuilding` and emits `building:press` or `map:press` (M2a).
  virtual void tap(double x, double y) = 0;
  /// A map UI zoom button was pressed (`MapUiState::zoomButtons`), main thread.
  virtual void zoomButton(bool zoomIn) = 0;

  virtual const WorldStore& worldStore() const = 0;

  // ---- M1 map adapter (MapAdapter.hpp) -------------------------------------------------------------
  /// Attaches the platform map. The core immediately sends the current style, limits and camera.
  virtual void attachMapAdapter(std::shared_ptr<MapAdapter> adapter) = 0;
  /// Detaches it; pending `project`/`unproject` requests are answered with `ok: false` (`not_ready`).
  virtual void detachMapAdapter() = 0;
  /// The platform map's camera changed (gesture, animation step, jump), main thread.
  virtual void onCameraChanged(const MapCameraPose& pose) = 0;
  /// Reply to `MapAdapter::project`.
  virtual void onProjected(std::uint64_t token, double x, double y) = 0;
  /// Reply to `MapAdapter::unproject` (nullopt when the point is not on the ground).
  virtual void onUnprojected(std::uint64_t token, std::optional<LngLat> coordinate) = 0;
  /// Reply to `MapAdapter::fetchText`: the body, or a complete error message when `ok` is false.
  virtual void onTextFetched(std::uint64_t token, bool ok, std::string bodyOrError) = 0;
  /// Reply to `MapAdapter::fetchBinary` (M3b models): the bytes, or a complete error message when `ok` is false.
  virtual void onBinaryFetched(std::uint64_t token, bool ok, std::string bytesOrError) = 0;
  /// Reply to `MapAdapter::projectPoints`: screen points (dp) in request order.
  virtual void onPointsProjected(std::uint64_t token, std::vector<ScreenPoint> points) = 0;
  /// Reply to `MapAdapter::queryBuilding`: the pressed building's `id` (nullopt: none) and the ground
  /// coordinate under the tap (nullopt: not on the ground).
  virtual void onBuildingQueried(std::uint64_t token, std::optional<std::string> buildingId, std::optional<LngLat> ground) = 0;

  // ---- M3a platform input ------------------------------------------------------------------------
  /// A platform GPS fix (`MapAdapter::startLocationUpdates`), used with the `device` location source.
  virtual void onDeviceLocation(const LocationFix& fix) = 0;
  /// The platform location feed failed (e.g. `location permission not granted`); emitted as
  /// `error {location_unavailable, "device geolocation failed: <message>"}` while the source is `device`.
  virtual void onDeviceLocationError(std::string message) = 0;
  /// The user started a pan gesture: stops `setCamera.follow` (engine-web cancels following on pans).
  virtual void onUserPan() = 0;

  /// Current protocol camera (diagnostics / tests).
  virtual CameraState cameraState() const = 0;
  /// MapLibre style JSON currently sent to the adapter (diagnostics / tests).
  virtual std::string styleJson() const = 0;

  /// Stops processing; later calls are ignored. Also detaches the map adapter.
  virtual void shutdown() = 0;
};

std::unique_ptr<Engine> createEngine(std::shared_ptr<MessageSink> sink, EngineConfig config = {});

}  // namespace maprama
