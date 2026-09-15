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
#include <optional>
#include <string>
#include <vector>

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

// ---------------------------------------------------------------------------------------------------------
// Labels (M2b, DESIGN.md §6.5): the core selects, projects and declutters labels; the platform draws each
// placed label as a recycled native view (card) at the position the core computed.
// ---------------------------------------------------------------------------------------------------------

/// Look a label card is drawn with. `ground` / `sign` (3D labels) are drawn as `App` / `Sticker` until the
/// custom layer exists (M2c).
enum class LabelVisual : std::uint8_t { Holo, App, Minimal, Clean, Sticker };
/// Icon tile of `Holo` cards (`HoloIconTile::Auto` resolved by the time of day: white by day, black at night).
enum class LabelTile : std::uint8_t { White, Black, Color };

/// Everything that decides a card's look and size (not its position). Cards with the same `key` have the
/// same size, so the platform measures each key once (`measureLabels`).
struct LabelCardContent {
  std::string key;
  LabelVisual visual = LabelVisual::Holo;
  LabelKind kind = LabelKind::Poi;
  /// District over water (`app` styles: italic blue).
  bool water = false;
  /// Arterial road (`app` styles: bold amber; `clean`: glass pill; `sticker`: yellow pill).
  bool arterial = false;
  std::string title;
  /// Shown when `showSubtitle` (holo: second line; app styles: POIs only).
  std::string subtitle;
  LabelIcon icon = LabelIcon::Plaza;
  /// Holo: icon tile; app styles: POI badge (POIs only).
  bool showIcon = true;
  bool showSubtitle = true;
  /// Host-supplied content (`content: "custom"`): holo subtitles use the accent style.
  bool custom = false;
  /// Accessibility label: name + type (the shown subtitle, else the default one).
  std::string accessibilityLabel;
};

/// Measured card size (dp) in `measureLabels` request order.
struct LabelSize {
  double width = 0.0;
  double height = 0.0;
};

/// One placed label for the current camera (dp, origin top-left of the map view).
struct LabelCard {
  /// Stable label id (`poi:<id>`, `road:<id>:<n>`, `district:<name>`), the key for view recycling.
  std::string id;
  LabelCardContent content;
  /// Card centre and size (the size the core placed it with).
  double x = 0.0;
  double y = 0.0;
  double width = 0.0;
  double height = 0.0;
  /// Rotation around the centre in radians (road labels of the app styles), 0 otherwise.
  double angle = 0.0;
  double opacity = 1.0;
  /// Holo only: the ground dot (true anchor) and the top end of the leader line (under the card).
  double dotX = 0.0;
  double dotY = 0.0;
  double lineX = 0.0;
  double lineY = 0.0;
};

/// The complete set of label views to show; every label not in `cards` is hidden.
struct LabelFrame {
  LabelVisual visual = LabelVisual::Holo;
  LabelTile tile = LabelTile::White;
  /// Night palette (engine-web: time-of-day `lights` > 0.8).
  bool night = false;
  /// Placement order (later cards on top).
  std::vector<LabelCard> cards;
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

  // ---- labels (M2b) --------------------------------------------------------------------------------
  // Default implementations do nothing (an adapter without label views shows no labels).

  /// Measures the cards the platform would draw for `items` (same fonts / paddings as `setLabelFrame`).
  /// Reply: `Engine::onLabelsMeasured(token, sizes)` with one size per item, in order.
  virtual void measureLabels(std::uint64_t /*token*/, const std::vector<LabelCardContent>& /*items*/) {}

  /// Shows exactly the cards of `frame` (recycling views by `LabelCard::id`) and hides every other label
  /// view. Sent whenever the placement changes (camera, labels, content, theme, viewport). May be applied
  /// synchronously when called on the main thread (it never calls back into the Engine).
  virtual void setLabelFrame(const LabelFrame& /*frame*/) {}
};

}  // namespace maprama
