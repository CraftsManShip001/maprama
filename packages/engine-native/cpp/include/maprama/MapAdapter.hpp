// Maprama native core — M1 platform map adapter (DESIGN.md §2.1).
//
// M1 renders with the official prebuilt MapLibre Native SDKs (iOS `MLNMapView`, Android `MapView`),
// which expose Obj-C / Java APIs instead of the `mbgl` C++ headers. The core therefore drives the map
// through this small interface that each platform implements; at M2 an `mbgl::Map`-backed adapter
// built from the patched fork replaces the platform ones without touching the core logic.
//
// Threading contract:
//   - The core calls every method with its engine lock held, from whichever thread entered the engine
//     (JS thread for commands, main thread for platform callbacks).
//   - Implementations must not block and must never call back into the Engine synchronously from
//     inside one of these methods: they post the work to the main/UI thread and reply later through
//     the Engine's `on*` methods (which take the engine lock themselves).
#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include "maprama/types.hpp"

namespace maprama {

/// A camera in MapLibre terms (512-px tiles, `zoom` is MapLibre's zoom level).
struct MapCameraPose {
  LngLat center;
  double zoom = 0.0;
  /// Degrees, 0 = straight down.
  double pitch = 0.0;
  /// Degrees clockwise from north.
  double bearing = 0.0;
};

/// Gesture limits the platform map applies (MapLibre min/max zoom and pitch).
struct MapCameraLimits {
  double minZoom = 0.0;
  double maxZoom = 22.0;
  double minPitch = 0.0;
  double maxPitch = 60.0;
};

class MapAdapter {
 public:
  virtual ~MapAdapter() = default;

  /// Replaces the map style (MapLibre style JSON v8 with inline GeoJSON sources, see `buildWorldStyle`).
  virtual void setStyleJson(std::string styleJson) = 0;

  /// Applies gesture limits. Called after a world load and whenever the viewport changes.
  virtual void setCameraLimits(const MapCameraLimits& limits) = 0;

  /// Moves the camera. `durationMs` 0 jumps, > 0 eases. The platform reports the resulting (and every
  /// intermediate) camera through `Engine::onCameraChanged`.
  virtual void moveCamera(const MapCameraPose& pose, double durationMs) = 0;

  /// Screen position (density-independent pixels, origin top-left) of a coordinate.
  /// Reply: `Engine::onProjected(token, x, y)`.
  virtual void project(std::uint64_t token, const LngLat& coordinate) = 0;

  /// Ground coordinate under a screen point. Reply: `Engine::onUnprojected(token, coordinate | nullopt)`.
  virtual void unproject(std::uint64_t token, double x, double y) = 0;

  /// Downloads a text resource (`init` with `world.kind = "url"`).
  /// Reply: `Engine::onTextFetched(token, ok, ok ? body : errorMessage)`.
  virtual void fetchText(std::uint64_t token, const std::string& url) = 0;

  /// Asks for one `Engine::frame` call after `delayMs` (used to flush throttled subscriptions).
  /// Several requests may be coalesced into one frame call.
  virtual void scheduleFrame(double delayMs) = 0;
};

}  // namespace maprama
