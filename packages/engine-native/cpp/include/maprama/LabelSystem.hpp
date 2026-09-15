// Maprama native core — map labels (M2b, DESIGN.md §6.5).
//
// Commands: setLabels, setLabelContent (and `init.labels`).
// Events:   labelsIndex (after every world load).
//
// A port of engine-web's pure label rules (`packages/engine-web/src/labels/index.ts`): label selection and
// stable ids, content modes, holo / app-style visibility, greedy decluttering with HUD exclusion zones and
// edge clamping. The core also projects the anchors itself (`MapProjector`, a port of MapLibre's camera
// transform) so the whole placement runs synchronously on every camera report, and hands the platform
// a `LabelFrame` of positioned cards that it draws as recycled native views (`MapAdapter::setLabelFrame`).
// Card sizes come from the platform (`MapAdapter::measureLabels`), cached by content key.
#pragma once

#include <cstddef>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "maprama/MapAdapter.hpp"
#include "maprama/Projection.hpp"
#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

struct WorldData;

// ---------------------------------------------------------------------------------------------------------
// Index (engine-web `buildLabelEntries` / `toLabelInfo`)
// ---------------------------------------------------------------------------------------------------------

/// A label with the engine-side placement data (engine-web `LabelEntry`).
struct LabelEntry {
  std::string id;
  LabelKind kind = LabelKind::Poi;
  std::string name;
  std::optional<PoiCategory> category;
  std::optional<std::string> subtitle;
  LngLat lngLat;
  /// Anchor in world units.
  double x = 0.0;
  double z = 0.0;
  /// Draw priority (lower first): district 0, arterial road 1, POI 2, other road 3.
  int pri = 0;
  LabelIcon icon = LabelIcon::Plaza;
  std::optional<RoadClass> roadClass;
  /// Road tangent (unit vector) at the anchor.
  std::optional<double> tx;
  std::optional<double> tz;
  bool water = false;
  /// Roads: the point 3 world units along the tangent (screen angle of app-style road labels).
  std::optional<LngLat> along;
};

/// Road anchors: every 42 units from 16 units along each named, non-alley, non-bridge road (to 8 units
/// before its end), skipping anchors within 30 units of an earlier anchor of the same name.
inline constexpr double kRoadLabelStart = 16.0;
inline constexpr double kRoadLabelStep = 42.0;
inline constexpr double kRoadLabelEndMargin = 8.0;
inline constexpr double kRoadLabelDedupe = 30.0;

/// Label entries of a world, in engine-web order: districts, road anchors, POIs.
std::vector<LabelEntry> buildLabelEntries(const WorldData& world, const Projection& projection);
/// Protocol `LabelInfo` object of an entry.
json::Value labelInfoValue(const LabelEntry& entry);
/// `labelsIndex.labels`.
json::Value labelsIndexValue(const std::vector<LabelEntry>& entries);

// ---------------------------------------------------------------------------------------------------------
// Spec and content
// ---------------------------------------------------------------------------------------------------------

/// `LabelsSpec` with engine-web's defaults (enabled, `holo`, icons `auto`, `nameAndType`).
struct ResolvedLabels {
  bool enabled = true;
  LabelStyle style = LabelStyle::Holo;
  HoloIconTile icons = HoloIconTile::Auto;
  LabelContentMode content = LabelContentMode::NameAndType;
};

ResolvedLabels resolveLabels(const LabelsSpec& spec);
/// A decoded `LabelsSpec` object (`checkLabelsSpec` passed).
LabelsSpec parseLabelsSpec(const json::Value& spec);
/// `setLabelContent.entries` (`Record<string, LabelContent>`).
std::map<std::string, LabelContent> parseLabelContentEntries(const json::Value& entries);

/// What a label displays after applying the content mode (engine-web `ResolvedLabelContent`).
struct ResolvedLabelContent {
  std::string title;
  std::string subtitle;
  LabelIcon icon = LabelIcon::Plaza;
  bool showIcon = true;
  bool showSubtitle = true;
  /// Host-supplied content was applied.
  bool custom = false;
};

/// `nameAndType` (name, subtitle, icon), `nameOnly` (name, icon), `textOnly` (name), `custom` (the host
/// entry's title / subtitle / icon; labels without an entry fall back to `nameAndType`).
ResolvedLabelContent resolveLabelContent(const LabelEntry& entry, LabelContentMode mode,
                                         const std::map<std::string, LabelContent>& entries);

// ---------------------------------------------------------------------------------------------------------
// Placement rules (engine-web `index.ts`)
// ---------------------------------------------------------------------------------------------------------

/// A screen-space box: centre and half extents (dp).
struct LabelBox {
  double x = 0.0;
  double y = 0.0;
  double hw = 0.0;
  double hh = 0.0;
};

bool overlaps(const LabelBox& a, const LabelBox& b);

/// engine-web `hudExclusions` (its own map UI layout): status strip, bottom margin, zoom buttons, scale bar,
/// attribution.
std::vector<LabelBox> hudExclusions(double vw, double vh, const MapUiSpec& ui, double top = 0.0, double bottom = 0.0);
/// The same zones for the native map views' ornaments (`MapUiState`, laid out by both platform views:
/// zoom buttons right-centred, scale bar bottom-left above the logo, attribution bottom-right).
std::vector<LabelBox> nativeHudExclusions(double vw, double vh, const MapUiState& ui);

/// Holo label height above the ground in world units per kind (prototype `H`).
double holoHeight(LabelKind kind);
/// Maximum road holo labels on screen.
inline constexpr int kHoloMaxRoads = 5;
/// engine-web `groundYFor` of data / town worlds (world units): the holo ground dot height.
inline constexpr double kLabelGroundY = 0.09;
/// Height of the app-style label anchors (world units).
inline constexpr double kAppLabelY = 0.3;
/// Gap (dp) kept between a label box and the left / right viewport edge.
inline constexpr double kLabelEdgeMargin = 6.0;

/// Whether a holo label is a candidate at camera distance `dist` and target distance `dT` (world units).
bool holoEligible(LabelKind kind, double dT, double dist);

/// A projected holo candidate (engine-web `HoloCandidate`).
struct HoloCandidate {
  std::string id;
  LabelKind kind = LabelKind::Poi;
  int pri = 0;
  double dT = 0.0;
  bool eligible = false;
  /// Panel anchor (top of the leader line).
  double topX = 0.0;
  double topY = 0.0;
  bool onScreen = false;
  double w = 0.0;
  double h = 0.0;
};

/// Greedy holo placement: candidates sorted by priority then target distance (stable); a card is shown when
/// eligible, on screen, not over an exclusion zone or an earlier card, and within the road budget. Returns
/// the shown ids with their boxes, in placement order.
std::vector<std::pair<std::string, LabelBox>> placeHolo(const std::vector<HoloCandidate>& candidates,
                                                        const std::vector<LabelBox>& exclusions,
                                                        int maxRoads = kHoloMaxRoads);

/// Visibility of an app-style label by kind and camera distance (`style`: app / minimal / clean / sticker).
bool domLabelVisible(LabelStyle style, LabelKind kind, int pri, double dist, double zoomOut);
/// Horizontal centre for a box of half width `hw` wanted at `x`, kept inside `[margin, vw - margin]`
/// (a box wider than that is centred in the viewport).
double clampLabelX(double x, double hw, double vw, double margin = kLabelEdgeMargin);
/// Collision box of a rotated label of size `w`×`h` at `(x, y)`.
LabelBox rotatedBox(double x, double y, double w, double h, double angle);
/// Keeps road label text upright: folds a screen angle into (−π/2, π/2].
double uprightAngle(double a);
/// Icon tile after resolving `auto` (white by day, black at night).
LabelTile iconTileFor(HoloIconTile tile, bool night);
/// The look a style is drawn with (`ground` -> App, `sign` -> Sticker until the custom layer, M2c).
LabelVisual labelVisualFor(LabelStyle style);
/// The engine-web DOM style whose visibility rules a visual uses.
LabelStyle domStyleFor(LabelVisual visual);

// ---------------------------------------------------------------------------------------------------------
// Screen projection
// ---------------------------------------------------------------------------------------------------------

/// MapLibre's field of view (`mbgl::TransformState` default, 36.87°).
inline constexpr double kMapLibreFovRad = 0.6435011087932844;

/// Screen projection of a MapLibre camera (a port of the perspective in `mbgl::TransformState`: 512-dp
/// tiles, camera `0.5·height / tan(fov/2)` dp from the centre, pitched about the centre, rotated by the
/// bearing; heights in meters at the centre's ground scale). Coordinates are dp from the view's top-left.
class MapProjector {
 public:
  struct Point {
    double x = 0.0;
    double y = 0.0;
    /// In front of the camera.
    bool inFront = false;
  };

  MapProjector(const MapCameraPose& pose, double width, double height);

  Point project(const LngLat& coordinate, double altitudeMeters = 0.0) const;

 private:
  double width_, height_;
  double worldSize_;
  double centerX_, centerY_;
  double cosBearing_, sinBearing_, cosPitch_, sinPitch_;
  double cameraDistance_;
  double pixelsPerMeter_;
};

// ---------------------------------------------------------------------------------------------------------
// Label system
// ---------------------------------------------------------------------------------------------------------

/// Inputs of one layout pass.
struct LabelLayoutInput {
  MapCameraPose pose;
  /// Map view size (dp).
  double width = 0.0;
  double height = 0.0;
  /// The map UI currently shown (HUD exclusion zones).
  MapUiState ui;
  /// Camera distance and target in world units (engine-web orbit).
  double distanceUnits = 0.0;
  WorldPoint target;
  double unitMeters = kDefaultUnitMeters;
  bool night = false;
  /// engine-web `groundYFor(world.kind)` (world units): the holo ground dot height.
  double groundY = kLabelGroundY;
};

class LabelSystem {
 public:
  /// A new world: rebuilds the entries (the size cache is kept: it is keyed by content).
  void setWorld(const WorldData& world, const Projection& projection);
  void clearWorld();
  bool hasWorld() const { return !entries_.empty() || worldSet_; }

  /// Replaces the spec (engine-web `this.labels = {...cmd.labels}`).
  void setSpec(const LabelsSpec& spec);
  const ResolvedLabels& spec() const { return spec_; }
  /// Replaces all host content (engine-web `setLabelContent`).
  void setContent(std::map<std::string, LabelContent> entries);

  const std::vector<LabelEntry>& entries() const { return entries_; }
  /// Card content of entry `i` for the current style, content mode and host content.
  const LabelCardContent& cardContent(std::size_t i) const { return contents_.at(i); }

  /// Card contents (one per key) whose size is neither known nor requested; marks them requested.
  std::vector<LabelCardContent> takeUnmeasured();
  /// Stores measured sizes (`items` as returned by `takeUnmeasured`).
  void onMeasured(const std::vector<LabelCardContent>& items, const std::vector<LabelSize>& sizes);
  /// Forgets requests in flight (the adapter changed); they are requested again.
  void resetRequests();
  std::optional<LabelSize> sizeOf(const std::string& key) const;

  /// Placement for one camera: the cards to show (none while disabled, or before sizes are known).
  LabelFrame layout(const LabelLayoutInput& input) const;

 private:
  void rebuildContents();
  void layoutHolo(const LabelLayoutInput& in, const MapProjector& projector, const std::vector<LabelBox>& exclusions,
                  LabelFrame& frame) const;
  void layoutApp(const LabelLayoutInput& in, const MapProjector& projector, const std::vector<LabelBox>& exclusions,
                 LabelFrame& frame) const;

  std::vector<LabelEntry> entries_;
  /// Entry indices sorted by priority (stable): the app styles' order.
  std::vector<std::size_t> byPriority_;
  bool worldSet_ = false;
  ResolvedLabels spec_;
  std::map<std::string, LabelContent> content_;
  std::vector<LabelCardContent> contents_;
  std::unordered_map<std::string, LabelSize> sizes_;
  std::set<std::string> requested_;
};

}  // namespace maprama
