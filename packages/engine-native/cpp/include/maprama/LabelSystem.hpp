// Maprama native core — map labels.
//
// Commands: setLabels, setLabelContent.
// Events:   labelsIndex.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "maprama/MessageSink.hpp"
#include "maprama/types.hpp"

namespace maprama {

class CameraController;
class Projection;
struct WorldData;

/// A label placed for the current frame (after collision / priority culling).
struct LabelInstance {
  std::string id;
  ScreenPoint anchor;
  float opacity = 1.0f;
  std::string title;
  std::optional<std::string> subtitle;
  std::optional<LabelIcon> icon;
  LabelStyle style = LabelStyle::App;
};

class LabelSystem {
 public:
  virtual ~LabelSystem() = default;

  virtual void setLabels(const LabelsSpec& labels) = 0;
  /// Replaces all host-supplied content (used with `content: "custom"`).
  virtual void setLabelContent(std::map<std::string, LabelContent> entries) = 0;

  /// Builds the label set from roads / districts / POIs (ids `road:<id>`, `district:<n>`, `poi:<id>`, matching
  /// engine-web) and emits `labelsIndex`.
  virtual void rebuildIndex(const WorldData& world, const Projection& projection, EventEmitter& events) = 0;

  virtual const std::vector<LabelInfo>& index() const = 0;

  /// Screen-space layout for this frame. `holo` / `sign` / `ground` styles render as GPU quads in the maprama
  /// layer; `app` / `minimal` / `clean` / `sticker` can alternatively be drawn as native views (DESIGN.md §5.5).
  virtual std::vector<LabelInstance> layout(const CameraController& camera) const = 0;
};

}  // namespace maprama
