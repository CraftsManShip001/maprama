// Maprama native core — platform map adapter (DESIGN.md §2.1).
//
// M1/M2a render with the official prebuilt MapLibre Native SDKs (iOS `MLNMapView`, Android `MapView`),
// which expose Obj-C / Java APIs instead of the `mbgl` C++ headers. The core therefore drives the map
// through this small interface that each platform implements; an `mbgl::Map`-backed adapter (only if the
// fork fallback is ever needed, DESIGN.md §11) would replace the platform ones without touching the core.
//
// Threading contract:
//   - The core calls every method with its engine lock held, from whichever thread entered the engine
//     (JS thread for commands, main thread for platform callbacks).
//   - Implementations must not block and must never call back into the Engine synchronously from
//     inside one of these methods: they post the work to the main/UI thread and reply later through
//     the Engine's `on*` methods (which take the engine lock themselves).
//   - Calls are applied in order. Style patches (`setPaintProperties`, `setLight`) sent while a style
//     from `setStyleJson` is still loading must be applied after it finished loading; a new
//     `setStyleJson` supersedes (drops) patches that were not applied yet, because the core always sends
//     the complete current style.
#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "maprama/types.hpp"

namespace maprama {

struct BuildingLayerData;

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

/// One style paint property to set: `valueJson` is a MapLibre style-spec value or expression as JSON
/// (`"#AABBCC"`, `1`, `["match", ...]`). `property` is the style-spec name (`fill-extrusion-color`).
struct PaintPropertyChange {
  std::string layerId;
  std::string property;
  std::string valueJson;

  bool operator==(const PaintPropertyChange& o) const {
    return layerId == o.layerId && property == o.property && valueJson == o.valueJson;
  }
};

/// The style's root `light` (lights `fill-extrusion` layers): anchor `map`, spherical position
/// `[radial, azimuthal°, polar°]` (azimuth clockwise from north, polar 0° = overhead), color, intensity 0-1.
struct MapLight {
  double radial = 1.15;
  double azimuthal = 210.0;
  double polar = 30.0;
  /// 24-bit RGB.
  std::uint32_t color = 0xFFFFFF;
  double intensity = 0.5;

  bool operator==(const MapLight& o) const {
    return radial == o.radial && azimuthal == o.azimuthal && polar == o.polar && color == o.color && intensity == o.intensity;
  }
  bool operator!=(const MapLight& o) const { return !(*this == o); }
};

/// Map UI ornaments the platform view shows (`MapUiSpec` resolved by the core, DESIGN.md §5.1 `setUi`).
/// The core computes every value; the platform only draws.
struct MapUiState {
  /// Scale bar: a bar `scaleBarWidth` dp long labelled `scaleBarLabel` (engine-web `scaleBarFor`).
  bool scaleBar = false;
  double scaleBarWidth = 0.0;
  std::string scaleBarLabel;
  /// Zoom in / out buttons; presses go to `Engine::zoomButton`.
  bool zoomButtons = false;
  /// MapLibre compass (shown while the map is rotated).
  bool compass = false;
  /// Visible data attribution text (e.g. "© OpenStreetMap contributors") plus MapLibre's attribution button.
  bool attribution = false;
  std::string attributionText;
  /// MapLibre logo.
  bool logo = false;

  bool operator==(const MapUiState& o) const {
    return scaleBar == o.scaleBar && scaleBarWidth == o.scaleBarWidth && scaleBarLabel == o.scaleBarLabel &&
           zoomButtons == o.zoomButtons && compass == o.compass && attribution == o.attribution &&
           attributionText == o.attributionText && logo == o.logo;
  }
  bool operator!=(const MapUiState& o) const { return !(*this == o); }
};

class MapAdapter {
 public:
  virtual ~MapAdapter() = default;

  /// Replaces the map style (MapLibre style JSON v8 with inline GeoJSON sources, see `buildWorldStyle`).
  virtual void setStyleJson(std::string styleJson) = 0;

  /// Sets paint properties of existing style layers, in order (theme and building style changes).
  virtual void setPaintProperties(const std::vector<PaintPropertyChange>& changes) = 0;

  /// Replaces the style's light (time of day).
  virtual void setLight(const MapLight& light) = 0;

  /// Shows / hides the map UI ornaments.
  virtual void setUi(const MapUiState& ui) = 0;

  /// M2c: the meshes and uniforms of the custom building layer (roofs, facades, outlines, captured flag).
  /// The platform draws the latest data in its custom render layer, placed directly below the `buildings`
  /// fill-extrusion layer of every style it loads (see `BuildingMesh.hpp`); the data is immutable and may be
  /// read from the render thread. Sent after `setStyleJson` and whenever the theme or a building style changes.
  virtual void setBuildingLayer(std::shared_ptr<const BuildingLayerData> data) = 0;

  /// Applies gesture limits. Called after a world load and whenever the viewport changes.
  virtual void setCameraLimits(const MapCameraLimits& limits) = 0;

  /// Moves the camera. `durationMs` 0 jumps, > 0 eases. The platform reports the resulting (and every
  /// intermediate) camera through `Engine::onCameraChanged`.
  virtual void moveCamera(const MapCameraPose& pose, double durationMs) = 0;

  /// Screen position (density-independent pixels, origin top-left) of a coordinate.
  /// Reply: `Engine::onProjected(token, x, y)`.
  virtual void project(std::uint64_t token, const LngLat& coordinate) = 0;

  /// Screen positions of several coordinates at once (overlay anchors), in the same order.
  /// Reply: `Engine::onPointsProjected(token, points)` (`visible` is ignored; the core decides it).
  virtual void projectPoints(std::uint64_t token, const std::vector<LngLat>& coordinates) = 0;

  /// Ground coordinate under a screen point. Reply: `Engine::onUnprojected(token, coordinate | nullopt)`.
  virtual void unproject(std::uint64_t token, double x, double y) = 0;

  /// Tap hit test: the `id` property of the topmost rendered feature of the `buildings` style layer at the
  /// screen point (rendered-feature query, extrusions included), and the ground coordinate under it.
  /// Reply: `Engine::onBuildingQueried(token, buildingId | nullopt, ground | nullopt)`.
  virtual void queryBuilding(std::uint64_t token, double x, double y) = 0;

  /// Downloads a text resource (`init` with `world.kind = "url"`).
  /// Reply: `Engine::onTextFetched(token, ok, ok ? body : errorMessage)`.
  virtual void fetchText(std::uint64_t token, const std::string& url) = 0;

  /// Asks for one `Engine::frame` call after `delayMs` (used to flush throttled subscriptions).
  /// Several requests may be coalesced into one frame call.
  virtual void scheduleFrame(double delayMs) = 0;

  // ---- M3a game visuals and device location (defaults: no-ops, so adapters of other milestones compile) --

  /// Replaces the data of a GeoJSON source of the current style (`geojson` is a FeatureCollection as JSON
  /// text). Like paint patches, data sent while a style is loading is applied once it finished loading;
  /// only the latest data per source matters (implementations may coalesce), and a new `setStyleJson`
  /// drops data queued for the previous style (the core re-sends every game source after a style change).
  virtual void setSourceData(const std::string& sourceId, std::string geojson) {
    (void)sourceId;
    (void)geojson;
  }

  /// Starts the platform location feed (`setLocationSource {kind: "device"}`): fixes go to
  /// `Engine::onDeviceLocation`, failures (permission not granted, provider unavailable) to
  /// `Engine::onDeviceLocationError`. Requesting the permission is the app's job.
  virtual void startLocationUpdates() {}
  /// Stops the platform location feed.
  virtual void stopLocationUpdates() {}
};

}  // namespace maprama
