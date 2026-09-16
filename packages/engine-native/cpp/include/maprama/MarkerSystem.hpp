// Maprama native core — app-owned map markers (M5, DESIGN.md §5.1 `setMarkerLayer`).
//
// Commands: setMarkerLayer, removeMarkerLayer.
// Events:   marker:press.
//
// A port of engine-web's `packages/engine-web/src/labels/markers.ts`. Markers reuse the **label view pool**:
// every marker becomes a card of the same `LabelFrame` the labels are drawn from, so it gets a recycled
// native view, an accessibility element and one collision pass shared with the labels — instead of a second
// renderer. The core owns everything but the drawing: it projects the anchors itself (`MapProjector`, the
// same projector the labels use), declutters, and hands the platform positioned cards.
//
// Placement order (one pass per frame, before the labels), identical to engine-web:
//   1. the HUD exclusion zones (status strip, map ornaments, content inset) are reserved first;
//   2. **forced** markers — `alwaysVisible`, plus the layer's `selectedId` — follow in priority order and are
//      never dropped: they ignore both the HUD zones and earlier boxes, and reserve their own box;
//   3. the rest, sorted by `priority` (higher first), then camera-target distance (nearer first), then key;
//   4. the boxes of the shown markers go to the label pass as extra exclusions, so a label never covers a
//      marker and a marker never yields to a label.
//
// Partial updates: `setLayer` diffs the incoming specs against the marker views by id. A changed `color` or
// `selectedId` neither recreates a view nor reloads an icon — the card keeps its `LabelCardContent::key`
// (which is what the platform layers reconfigure on) and only its tint / size change. `MarkerSystem::stats`
// counts both, mirroring engine-web's `MarkerLayers.stats`, and the tests assert on it.
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "maprama/LabelSystem.hpp"
#include "maprama/MapAdapter.hpp"
#include "maprama/Projection.hpp"
#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

/// Which point of the marker sits on its coordinate (protocol `MarkerAnchor`).
enum class MarkerAnchor : std::uint8_t { Bottom, Center, Top };

/// engine-web `DEFAULT_MARKER_SIZE`: marker height in dp when the layer sets no `size`.
inline constexpr double kDefaultMarkerSize = 36.0;
/// engine-web `DEFAULT_SELECTED_SCALE`.
inline constexpr double kDefaultSelectedScale = 1.25;
/// engine-web `DEFAULT_MARKER_COLOR` (#2F5BEA).
inline constexpr std::uint32_t kDefaultMarkerColor = 0x2F5BEA;
/// Aspect (width / height) of the built-in base shapes — engine-web's SVG viewBoxes.
inline constexpr double kMarkerPinAspect = 24.0 / 32.0;
inline constexpr double kMarkerDotAspect = 1.0;
/// engine-web pads every marker box by 2 dp before the collision test.
inline constexpr double kMarkerBoxPadding = 2.0;
/// Smallest press target of a marker (dp). The visual box decides placement; a small pin still has to be
/// reachable with a finger, so the *hit* box is grown to at least this on both axes.
inline constexpr double kMarkerMinHitDp = 44.0;

double markerAspect(MarkerShape shape);

/// One marker of a layer (protocol `MarkerSpec`, defaults resolved).
struct MarkerSpecEntry {
  std::string id;
  LngLat coordinate;
  MarkerShape shape = MarkerShape::Pin;
  /// `MarkerImage.uri`, empty for a plain base shape.
  std::string iconUri;
  std::uint32_t color = kDefaultMarkerColor;
  double priority = 0.0;
  bool alwaysVisible = false;
  std::string accessibilityLabel;
};

/// One layer's resolved state (engine-web `LayerState`).
struct MarkerLayerState {
  std::string layerId;
  std::vector<MarkerSpecEntry> markers;
  std::optional<std::string> selectedId;
  double selectedScale = kDefaultSelectedScale;
  double size = kDefaultMarkerSize;
  MarkerAnchor anchor = MarkerAnchor::Bottom;
  /// Anchor in world units per marker id (empty before the first world).
  std::unordered_map<std::string, WorldPoint> points;
};

/// A marker projected for one frame (engine-web `MarkerCandidate`).
struct MarkerCandidate {
  std::string key;
  std::string layerId;
  std::string markerId;
  double priority = 0.0;
  /// `alwaysVisible`, or the layer's selected marker: never dropped by collision.
  bool forced = false;
  bool onScreen = false;
  /// Distance to the camera target in world units (tie-break).
  double dT = 0.0;
  LabelBox box;
};

/// Placement order: forced first, then priority desc, then nearest to the camera target, then key.
bool markerBefore(const MarkerCandidate& a, const MarkerCandidate& b);

/// Greedy placement in the documented order; returns the shown keys with their boxes **in placement order**
/// (highest priority first), which is also the hit-test order.
std::vector<std::pair<std::string, LabelBox>> placeMarkers(const std::vector<MarkerCandidate>& candidates,
                                                          const std::vector<LabelBox>& exclusions);

/// What `marker:press` reports.
struct MarkerPress {
  std::string layerId;
  std::string markerId;
  LngLat coordinate;
  /// The marker's anchor on screen in dp (the pin tip for `anchor: "bottom"`).
  double x = 0.0;
  double y = 0.0;
};

/// The result of one placement pass.
struct MarkerFrame {
  /// Cards to draw, in placement order (highest priority first).
  std::vector<LabelCard> cards;
  /// Their boxes, handed to the label pass as extra exclusions.
  std::vector<LabelBox> boxes;
};

/// The marker layers of one engine.
class MarkerSystem {
 public:
  /// Creates or replaces a layer (`setMarkerLayer`, already validated by `decodeCommand`). `projection` is the
  /// current world's projection, or nullptr before a world: the previous layer's anchors are then kept.
  void setLayer(const json::Value& msg, const Projection* projection);
  /// Removes a layer and recycles its views. True when the layer existed.
  bool removeLayer(const std::string& layerId);
  /// Re-projects every layer after a world (and therefore projection) change.
  void reproject(const Projection& projection);
  /// Forgets every layer and its views.
  void clear();

  bool empty() const { return layers_.empty(); }
  std::vector<std::string> layerIds() const;
  const MarkerStats& stats() const { return stats_; }

  /// Projects and places every marker for one camera. `exclusions` are the HUD zones; the returned boxes are
  /// what the label pass must avoid. The shown markers are remembered for `hitTest`.
  MarkerFrame layout(const LabelLayoutInput& input, const std::vector<LabelBox>& exclusions);
  /// Clears the hit list (no placement runs while the view is gone).
  void clearPlacement();

  /// The marker under a screen point (dp), or nullopt. Placement order decides, so the higher-priority marker
  /// wins where two hit boxes overlap. The hit box is the visual box grown to at least `kMarkerMinHitDp`.
  std::optional<MarkerPress> hitTest(double x, double y) const;

 private:
  /// The core's mirror of one platform marker view (engine-web `MarkerView`): what the platform would have to
  /// redo if it changed. `key` is `LabelCardContent::key`, which is what the platform reconfigures on.
  struct MarkerView {
    std::string iconKey;
    std::string colorKey;
    /// Empty until the first sync, so a marker without a label still runs its branch once.
    bool labelSet = false;
    std::string labelKey;
    std::string sizeKey;
    std::string anchorKey;
    bool selected = false;
  };
  struct Hit {
    std::string key;
    LabelBox box;
    double x = 0.0;
    double y = 0.0;
  };

  void project(MarkerLayerState& state, const Projection& projection);
  /// Creates, updates or recycles the views of one layer: the partial-update pass (engine-web `sync`).
  void sync(const MarkerLayerState& state, const MarkerLayerState* previous);
  void recycle(const std::string& key);
  std::optional<MarkerPress> pressFor(const std::string& key) const;

  /// Layers in insertion order is not needed (engine-web iterates a Map): a `std::map` keeps the frame
  /// deterministic across platforms.
  std::map<std::string, MarkerLayerState> layers_;
  std::unordered_map<std::string, MarkerView> views_;
  /// Views handed back by `recycle`, reused (with their state) by the next marker that needs one.
  std::vector<MarkerView> pool_;
  /// Shown markers of the last frame, in placement (= hit-test) order.
  std::vector<Hit> hits_;
  MarkerStats stats_;
};

/// Stable view key of a marker across layers (engine-web `markerKey`: ids never contain `\0`).
std::string markerKey(const std::string& layerId, const std::string& markerId);

}  // namespace maprama
