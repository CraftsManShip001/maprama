#include "maprama/MarkerSystem.hpp"

#include <algorithm>
#include <cmath>

#include "maprama/CameraMath.hpp"
#include "maprama/MapLook.hpp"

namespace maprama {

namespace {

using json::Value;

/// Separator of the `layerId` / `markerId` pair in a view key (engine-web `SEP`: ids never contain it).
constexpr char kSep = '\0';

const Value* member(const Value& object, std::string_view key) { return object.isObject() ? object.find(key) : nullptr; }

std::optional<double> numberMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  return v != nullptr && v->isNumber() ? std::optional<double>(v->asNumber()) : std::nullopt;
}

std::optional<std::string> stringMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  return v != nullptr && v->isString() ? std::optional<std::string>(v->asString()) : std::nullopt;
}

bool boolMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  return v != nullptr && v->isBoolean() && v->asBool();
}

MarkerAnchor parseAnchor(const std::string& name) {
  if (name == "center") return MarkerAnchor::Center;
  if (name == "top") return MarkerAnchor::Top;
  return MarkerAnchor::Bottom;
}

/// Where the box centre sits relative to the anchor, as a multiple of the card height (engine-web `ANCHORS`).
double centerFactor(MarkerAnchor anchor) {
  switch (anchor) {
    case MarkerAnchor::Bottom:
      return -0.5;
    case MarkerAnchor::Center:
      return 0.0;
    case MarkerAnchor::Top:
      return 0.5;
  }
  return -0.5;
}

/// engine-web `baseShape`: a custom image is drawn inside the pin; only the literal `"dot"` is a dot.
MarkerShape shapeOfIcon(const Value* icon) {
  return icon != nullptr && icon->isString() && icon->asString() == "dot" ? MarkerShape::Dot : MarkerShape::Pin;
}

/// engine-web `iconKeyOf` folded together with the base shape: what decides the card's *look*, and therefore
/// what the platform layers reconfigure (and re-decode an image) on.
std::string contentKeyOf(MarkerShape shape, const std::string& uri) {
  std::string key = "mk|";
  key += shape == MarkerShape::Dot ? "dot" : "pin";
  key += '|';
  key += uri.empty() ? std::string() : "uri:" + uri;
  return key;
}

}  // namespace

double markerAspect(MarkerShape shape) { return shape == MarkerShape::Dot ? kMarkerDotAspect : kMarkerPinAspect; }

std::string markerKey(const std::string& layerId, const std::string& markerId) {
  std::string key = layerId;
  key += kSep;
  key += markerId;
  return key;
}

bool markerBefore(const MarkerCandidate& a, const MarkerCandidate& b) {
  if (a.forced != b.forced) return a.forced;
  if (a.priority != b.priority) return a.priority > b.priority;
  if (a.dT != b.dT) return a.dT < b.dT;
  return a.key < b.key;
}

std::vector<std::pair<std::string, LabelBox>> placeMarkers(const std::vector<MarkerCandidate>& candidates,
                                                          const std::vector<LabelBox>& exclusions) {
  std::vector<const MarkerCandidate*> sorted;
  sorted.reserve(candidates.size());
  for (const MarkerCandidate& c : candidates) sorted.push_back(&c);
  std::sort(sorted.begin(), sorted.end(), [](const MarkerCandidate* a, const MarkerCandidate* b) {
    return markerBefore(*a, *b);
  });
  std::vector<LabelBox> placed(exclusions);
  std::vector<std::pair<std::string, LabelBox>> shown;
  for (const MarkerCandidate* c : sorted) {
    if (!c->onScreen) continue;
    if (!c->forced) {
      bool blocked = false;
      for (const LabelBox& p : placed) {
        if (overlaps(p, c->box)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
    }
    placed.push_back(c->box);
    shown.emplace_back(c->key, c->box);
  }
  return shown;
}

// ---------------------------------------------------------------------------------------------------------
// MarkerSystem
// ---------------------------------------------------------------------------------------------------------

void MarkerSystem::setLayer(const Value& msg, const Projection* projection) {
  const std::string layerId = stringMember(msg, "layerId").value_or(std::string());
  if (layerId.empty()) return;
  const auto previousIt = layers_.find(layerId);
  const std::optional<MarkerLayerState> previous =
      previousIt != layers_.end() ? std::optional<MarkerLayerState>(previousIt->second) : std::nullopt;

  MarkerLayerState state;
  state.layerId = layerId;
  if (const Value* selected = member(msg, "selectedId"); selected != nullptr && selected->isString()) {
    state.selectedId = selected->asString();
  }
  state.selectedScale = numberMember(msg, "selectedScale").value_or(kDefaultSelectedScale);
  state.size = numberMember(msg, "size").value_or(kDefaultMarkerSize);
  state.anchor = parseAnchor(stringMember(msg, "anchor").value_or(std::string()));
  if (const Value* list = member(msg, "markers"); list != nullptr && list->isArray()) {
    state.markers.reserve(list->items().size());
    for (const Value& m : list->items()) {
      MarkerSpecEntry entry;
      entry.id = stringMember(m, "id").value_or(std::string());
      if (entry.id.empty()) continue;
      if (const Value* c = member(m, "coordinate"); c != nullptr) {
        entry.coordinate.lng = numberMember(*c, "lng").value_or(0.0);
        entry.coordinate.lat = numberMember(*c, "lat").value_or(0.0);
      }
      const Value* icon = member(m, "icon");
      entry.shape = shapeOfIcon(icon);
      if (icon != nullptr && icon->isObject()) entry.iconUri = stringMember(*icon, "uri").value_or(std::string());
      entry.color = kDefaultMarkerColor;
      if (const std::optional<std::string> css = stringMember(m, "color")) {
        entry.color = parseCssHex(*css).value_or(kDefaultMarkerColor);
      }
      entry.priority = numberMember(m, "priority").value_or(0.0);
      entry.alwaysVisible = boolMember(m, "alwaysVisible");
      entry.accessibilityLabel = stringMember(m, "accessibilityLabel").value_or(std::string());
      state.markers.push_back(std::move(entry));
    }
  }

  if (projection != nullptr) {
    project(state, *projection);
  } else if (previous) {
    // No world yet: keep the anchors the previous layer already had (engine-web's deferred state).
    for (const MarkerSpecEntry& m : state.markers) {
      const auto it = previous->points.find(m.id);
      if (it != previous->points.end()) state.points.emplace(m.id, it->second);
    }
  }
  sync(state, previous ? &*previous : nullptr);
  layers_[layerId] = std::move(state);
}

bool MarkerSystem::removeLayer(const std::string& layerId) {
  const auto it = layers_.find(layerId);
  if (it == layers_.end()) return false;
  for (const MarkerSpecEntry& m : it->second.markers) recycle(markerKey(layerId, m.id));
  layers_.erase(it);
  const std::string prefix = layerId + kSep;
  hits_.erase(std::remove_if(hits_.begin(), hits_.end(),
                             [&prefix](const Hit& h) { return h.key.compare(0, prefix.size(), prefix) == 0; }),
              hits_.end());
  return true;
}

void MarkerSystem::reproject(const Projection& projection) {
  for (auto& [id, state] : layers_) project(state, projection);
}

void MarkerSystem::clear() {
  for (const auto& [id, state] : layers_) {
    for (const MarkerSpecEntry& m : state.markers) recycle(markerKey(state.layerId, m.id));
  }
  layers_.clear();
  hits_.clear();
}

std::vector<std::string> MarkerSystem::layerIds() const {
  std::vector<std::string> out;
  out.reserve(layers_.size());
  for (const auto& [id, state] : layers_) out.push_back(id);
  return out;
}

void MarkerSystem::clearPlacement() { hits_.clear(); }

MarkerFrame MarkerSystem::layout(const LabelLayoutInput& in, const std::vector<LabelBox>& exclusions) {
  MarkerFrame out;
  hits_.clear();
  if (layers_.empty() || !(in.width > 0) || !(in.height > 0)) return out;
  camera_math::FitPadding pad;
  pad.top = in.ui.inset.top;
  pad.right = in.ui.inset.right;
  pad.bottom = in.ui.inset.bottom;
  pad.left = in.ui.inset.left;
  const camera_math::VisibleRect vr = camera_math::visibleRect(in.width, in.height, pad);
  const MapProjector projector(in.pose, in.width, in.height);

  std::vector<MarkerCandidate> candidates;
  struct Placed {
    std::string key;
    LabelCardContent content;
    double x = 0.0;
    double y = 0.0;
    double width = 0.0;
    double height = 0.0;
    /// The anchor on screen (`marker:press.point`).
    double anchorX = 0.0;
    double anchorY = 0.0;
  };
  std::vector<Placed> byKey;
  for (const auto& [layerId, state] : layers_) {
    for (const MarkerSpecEntry& m : state.markers) {
      const auto point = state.points.find(m.id);
      if (point == state.points.end()) continue;  // no world yet: nothing to project against
      const std::string key = markerKey(state.layerId, m.id);
      const MapProjector::Point s = projector.project(m.coordinate, in.groundY * in.unitMeters);
      const bool selected = state.selectedId && *state.selectedId == m.id;
      const double height = state.size * (selected ? state.selectedScale : 1.0);
      const double width = height * markerAspect(m.shape);

      MarkerCandidate c;
      c.key = key;
      c.layerId = state.layerId;
      c.markerId = m.id;
      c.priority = m.priority;
      c.forced = m.alwaysVisible || selected;
      c.onScreen = s.inFront && s.x >= vr.x - width && s.x <= vr.x + vr.width + width && s.y >= vr.y - height &&
                   s.y <= vr.y + vr.height + height;
      c.dT = std::hypot(point->second.x - in.target.x, point->second.z - in.target.z);
      c.box = LabelBox{s.x, s.y + height * centerFactor(state.anchor), width / 2 + kMarkerBoxPadding,
                       height / 2 + kMarkerBoxPadding};

      Placed p;
      p.key = key;
      p.content.visual = LabelVisual::Marker;
      p.content.kind = LabelKind::Poi;
      p.content.key = contentKeyOf(m.shape, m.iconUri);
      p.content.shape = m.shape;
      p.content.iconUri = m.iconUri;
      p.content.color = m.color;
      p.content.selected = selected;
      p.content.showIcon = false;
      p.content.showSubtitle = false;
      p.content.accessibilityLabel = m.accessibilityLabel;
      p.x = c.box.x;
      p.y = c.box.y;
      p.width = width;
      p.height = height;
      p.anchorX = s.x;
      p.anchorY = s.y;
      byKey.push_back(std::move(p));
      candidates.push_back(std::move(c));
    }
  }

  const std::vector<std::pair<std::string, LabelBox>> shown = placeMarkers(candidates, exclusions);
  out.cards.reserve(shown.size());
  out.boxes.reserve(shown.size());
  hits_.reserve(shown.size());
  for (const std::pair<std::string, LabelBox>& entry : shown) {
    const std::string& key = entry.first;
    const auto it = std::find_if(byKey.begin(), byKey.end(), [&key](const Placed& p) { return p.key == key; });
    if (it == byKey.end()) continue;
    LabelCard card;
    card.id = "marker:" + key;
    card.content = it->content;
    card.x = it->x;
    card.y = it->y;
    card.width = it->width;
    card.height = it->height;
    out.cards.push_back(std::move(card));
    out.boxes.push_back(entry.second);
    hits_.push_back(Hit{key, entry.second, it->anchorX, it->anchorY});
  }
  return out;
}

std::optional<MarkerPress> MarkerSystem::hitTest(double x, double y) const {
  for (const Hit& h : hits_) {
    // The visual box decides placement; a finger needs at least 44 dp (both platforms' minimum target).
    const double hw = std::max(h.box.hw, kMarkerMinHitDp / 2), hh = std::max(h.box.hh, kMarkerMinHitDp / 2);
    if (std::fabs(x - h.box.x) > hw || std::fabs(y - h.box.y) > hh) continue;
    std::optional<MarkerPress> press = pressFor(h.key);
    if (!press) continue;
    press->x = h.x;
    press->y = h.y;
    return press;
  }
  return std::nullopt;
}

// ---------------------------------------------------------------------------------------------------------

void MarkerSystem::project(MarkerLayerState& state, const Projection& projection) {
  state.points.clear();
  for (const MarkerSpecEntry& m : state.markers) state.points.emplace(m.id, projection.toWorld(m.coordinate));
}

std::optional<MarkerPress> MarkerSystem::pressFor(const std::string& key) const {
  const std::size_t sep = key.find(kSep);
  if (sep == std::string::npos) return std::nullopt;
  const std::string layerId = key.substr(0, sep), markerId = key.substr(sep + 1);
  const auto layer = layers_.find(layerId);
  if (layer == layers_.end()) return std::nullopt;
  for (const MarkerSpecEntry& m : layer->second.markers) {
    if (m.id != markerId) continue;
    MarkerPress press;
    press.layerId = layerId;
    press.markerId = markerId;
    press.coordinate = m.coordinate;
    return press;
  }
  return std::nullopt;
}

void MarkerSystem::sync(const MarkerLayerState& state, const MarkerLayerState* previous) {
  if (previous != nullptr) {
    for (const MarkerSpecEntry& m : previous->markers) {
      const bool kept = std::any_of(state.markers.begin(), state.markers.end(),
                                    [&m](const MarkerSpecEntry& n) { return n.id == m.id; });
      if (!kept) recycle(markerKey(state.layerId, m.id));
    }
  }
  for (const MarkerSpecEntry& m : state.markers) {
    const std::string key = markerKey(state.layerId, m.id);
    auto it = views_.find(key);
    if (it == views_.end()) {
      // A recycled view costs nothing and keeps its state (engine-web's pool): only a view the pool cannot
      // supply has to be created.
      MarkerView fresh;
      if (!pool_.empty()) {
        fresh = std::move(pool_.back());
        pool_.pop_back();
      } else {
        ++stats_.viewsCreated;
      }
      it = views_.emplace(key, std::move(fresh)).first;
    }
    MarkerView& view = it->second;
    const std::string colorKey = std::to_string(m.color);
    if (view.colorKey != colorKey) view.colorKey = colorKey;  // one tint write, no rebuild
    const std::string sizeKey = std::to_string(state.size) + "|" + (m.shape == MarkerShape::Dot ? "dot" : "pin");
    if (view.sizeKey != sizeKey) view.sizeKey = sizeKey;
    const std::string anchorKey = std::to_string(static_cast<int>(state.anchor));
    if (view.anchorKey != anchorKey) view.anchorKey = anchorKey;
    const std::string iconKey = contentKeyOf(m.shape, m.iconUri);
    if (view.iconKey != iconKey) {
      view.iconKey = iconKey;
      // Only a custom image is a load; swapping between the built-in shapes is a redraw (engine-web `applyIcon`).
      if (!m.iconUri.empty()) ++stats_.iconLoads;
    }
    const std::string labelKey = m.accessibilityLabel;
    if (!view.labelSet || view.labelKey != labelKey) {
      view.labelSet = true;
      view.labelKey = labelKey;
    }
    const bool selected = state.selectedId && *state.selectedId == m.id;
    if (view.selected != selected) view.selected = selected;
  }
}

void MarkerSystem::recycle(const std::string& key) {
  const auto it = views_.find(key);
  if (it == views_.end()) return;
  pool_.push_back(std::move(it->second));
  views_.erase(it);
}

}  // namespace maprama
