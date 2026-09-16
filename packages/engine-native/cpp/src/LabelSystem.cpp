#include "maprama/LabelSystem.hpp"

#include <algorithm>
#include <cmath>

#include "maprama/CameraMath.hpp"
#include "maprama/LabelIcons.hpp"
#include "maprama/Projection.hpp"
#include "maprama/WorldStore.hpp"

namespace maprama {

namespace {

using json::Value;

constexpr double kPi = 3.14159265358979323846;
/// Size-cache bound (content keys accumulate with custom content); the cache restarts beyond it.
constexpr std::size_t kMaxCachedSizes = 4096;

const Value* member(const Value& object, std::string_view key) { return object.isObject() ? object.find(key) : nullptr; }

std::optional<std::string> stringMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  return v != nullptr && v->isString() ? std::optional<std::string>(v->asString()) : std::nullopt;
}

template <class E>
std::optional<E> enumMember(const Value& object, std::string_view key) {
  const std::optional<std::string> s = stringMember(object, key);
  return s ? parseEnum<E>(*s) : std::nullopt;
}

LabelIcon iconOfCategory(PoiCategory c) { return static_cast<LabelIcon>(static_cast<std::size_t>(c)); }

bool anyOverlap(const std::vector<LabelBox>& placed, const LabelBox& box) {
  for (const LabelBox& p : placed) {
    if (overlaps(p, box)) return true;
  }
  return false;
}

std::string contentKey(const LabelCardContent& c) {
  const char sep = '\x1f';
  std::string key;
  key.reserve(c.title.size() + c.subtitle.size() + 16);
  key += static_cast<char>('0' + static_cast<int>(c.visual));
  key += static_cast<char>('0' + static_cast<int>(c.kind));
  key += c.water ? 'w' : '-';
  key += c.arterial ? 'a' : '-';
  key += c.showIcon ? 'i' : '-';
  key += c.showSubtitle ? 's' : '-';
  key += c.custom ? 'c' : '-';
  key += c.player ? 'p' : '-';
  key += static_cast<char>('A' + static_cast<int>(c.icon));
  if (c.player) key += std::to_string(c.color);
  key += sep;
  key += c.title;
  key += sep;
  if (c.showSubtitle) key += c.subtitle;
  return key;
}

}  // namespace

// ---------------------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------------------

std::vector<LabelEntry> buildLabelEntries(const WorldData& world, const Projection& projection) {
  std::vector<LabelEntry> out;
  const WorldBounds& b = world.bounds;
  const auto inBounds = [&b](double x, double z) { return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ; };

  std::map<std::string, int> seen;
  for (const District& d : world.districts) {
    const int n = ++seen[d.name];
    const bool water = d.water.value_or(false);
    LabelEntry e;
    e.id = "district:" + d.name + (n > 1 ? "#" + std::to_string(n) : std::string());
    e.kind = LabelKind::District;
    e.name = d.name;
    e.subtitle = std::string(kindSubtitle(water ? LabelIcon::Water : LabelIcon::District));
    e.lngLat = projection.toLngLat(WorldPoint{d.x, d.z});
    e.x = d.x;
    e.z = d.z;
    e.pri = 0;
    e.icon = water ? LabelIcon::Water : LabelIcon::District;
    e.water = water;
    out.push_back(std::move(e));
  }

  struct Anchor {
    const std::string* name;
    double x, z;
  };
  std::vector<Anchor> anchors;
  for (const Road& r : world.roads) {
    if (r.cls == RoadClass::Alley || r.bridge.value_or(false) || !r.name || r.name->empty()) continue;
    const std::vector<Vec2>& pts = r.pts;
    double length = 0;
    for (std::size_t i = 0; i + 1 < pts.size(); ++i) length += std::hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    int k = 0;
    for (double s = kRoadLabelStart; s < length - kRoadLabelEndMargin; ++k, s += kRoadLabelStep) {
      double acc = 0;
      for (std::size_t i = 0; i + 1 < pts.size(); ++i) {
        const double ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
        const double seg = std::hypot(bx - ax, bz - az);
        if (seg > 0 && acc + seg >= s) {
          const double t = (s - acc) / seg, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          const bool near = std::any_of(anchors.begin(), anchors.end(), [&](const Anchor& a) {
            return *a.name == *r.name && std::hypot(a.x - x, a.z - z) < kRoadLabelDedupe;
          });
          if (inBounds(x, z) && !near) {
            anchors.push_back(Anchor{&*r.name, x, z});
            const bool art = r.cls == RoadClass::Arterial;
            LabelEntry e;
            e.id = "road:" + r.id + ":" + std::to_string(k);
            e.kind = LabelKind::Road;
            e.name = *r.name;
            e.subtitle = std::string(kindSubtitle(art ? LabelIcon::Avenue : LabelIcon::Street));
            e.lngLat = projection.toLngLat(WorldPoint{x, z});
            e.x = x;
            e.z = z;
            e.pri = art ? 1 : 3;
            e.icon = art ? LabelIcon::Avenue : LabelIcon::Street;
            e.roadClass = r.cls;
            e.tx = (bx - ax) / seg;
            e.tz = (bz - az) / seg;
            e.along = projection.toLngLat(WorldPoint{x + *e.tx * 3.0, z + *e.tz * 3.0});
            out.push_back(std::move(e));
          }
          break;
        }
        acc += seg;
      }
    }
  }

  for (const Poi& p : world.pois) {
    LabelEntry e;
    e.id = "poi:" + p.id;
    e.kind = LabelKind::Poi;
    e.name = p.name;
    e.category = p.cat;
    e.subtitle = std::string(poiSubtitle(p.cat));
    e.lngLat = projection.toLngLat(WorldPoint{p.x, p.z});
    e.x = p.x;
    e.z = p.z;
    e.pri = 2;
    e.icon = iconOfCategory(p.cat);
    out.push_back(std::move(e));
  }
  return out;
}

Value labelInfoValue(const LabelEntry& e) {
  Value info = Value::object({{"id", e.id},
                              {"kind", std::string(enumName(e.kind))},
                              {"name", e.name},
                              {"lngLat", Value::object({{"lng", e.lngLat.lng}, {"lat", e.lngLat.lat}})}});
  if (e.category) info.set("category", std::string(enumName(*e.category)));
  if (e.subtitle) info.set("subtitle", *e.subtitle);
  return info;
}

Value labelsIndexValue(const std::vector<LabelEntry>& entries) {
  Value list = Value::array();
  for (const LabelEntry& e : entries) list.push(labelInfoValue(e));
  return list;
}

// ---------------------------------------------------------------------------------------------------------
// Spec and content
// ---------------------------------------------------------------------------------------------------------

double zoomOutFactor(ZoomOutBehavior behavior, double distanceUnits) {
  if (behavior == ZoomOutBehavior::None || !std::isfinite(distanceUnits)) return 0.0;
  const double x = std::clamp((distanceUnits - 55.0) / 55.0, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);  // engine-web `smooth01`
}

ResolvedLabels resolveLabels(const LabelsSpec& spec) {
  ResolvedLabels r;
  r.enabled = spec.enabled.value_or(true);
  r.style = spec.style.value_or(LabelStyle::Holo);
  r.icons = spec.icons.value_or(HoloIconTile::Auto);
  r.content = spec.content.value_or(LabelContentMode::NameAndType);
  return r;
}

LabelsSpec parseLabelsSpec(const Value& spec) {
  LabelsSpec s;
  if (const Value* enabled = member(spec, "enabled"); enabled != nullptr && enabled->isBoolean()) s.enabled = enabled->asBool();
  s.style = enumMember<LabelStyle>(spec, "style");
  s.icons = enumMember<HoloIconTile>(spec, "icons");
  s.content = enumMember<LabelContentMode>(spec, "content");
  return s;
}

std::map<std::string, LabelContent> parseLabelContentEntries(const Value& entries) {
  std::map<std::string, LabelContent> out;
  if (!entries.isObject()) return out;
  for (const json::Member& m : entries.members()) {
    LabelContent c;
    c.title = stringMember(m.value, "title").value_or(std::string());
    c.subtitle = stringMember(m.value, "subtitle");
    c.icon = enumMember<LabelIcon>(m.value, "icon");
    out[m.key] = std::move(c);
  }
  return out;
}

ResolvedLabelContent resolveLabelContent(const LabelEntry& entry, LabelContentMode mode,
                                         const std::map<std::string, LabelContent>& entries) {
  ResolvedLabelContent base{entry.name, entry.subtitle.value_or(std::string()), entry.icon, true, true, false};
  switch (mode) {
    case LabelContentMode::NameOnly:
      base.showSubtitle = false;
      return base;
    case LabelContentMode::TextOnly:
      base.showIcon = false;
      base.showSubtitle = false;
      return base;
    case LabelContentMode::Custom: {
      const auto it = entries.find(entry.id);
      if (it == entries.end()) return base;
      const LabelContent& c = it->second;
      const std::string subtitle = c.subtitle.value_or(std::string());
      return ResolvedLabelContent{c.title, subtitle, c.icon.value_or(entry.icon), true, !subtitle.empty(), true};
    }
    case LabelContentMode::NameAndType:
      break;
  }
  return base;
}

// ---------------------------------------------------------------------------------------------------------
// Placement rules
// ---------------------------------------------------------------------------------------------------------

bool overlaps(const LabelBox& a, const LabelBox& b) {
  return std::fabs(a.x - b.x) < a.hw + b.hw && std::fabs(a.y - b.y) < a.hh + b.hh;
}

std::vector<LabelBox> hudExclusions(double vw, double vh, const MapUiSpec& ui, double top, double bottom) {
  std::vector<LabelBox> boxes{
      LabelBox{vw / 2, top / 2 + 14, vw / 2, top / 2 + 22},
      LabelBox{vw / 2, vh - bottom / 2 - 6, vw / 2, bottom / 2 + 14},
  };
  if (ui.zoomButtons.value_or(false)) boxes.push_back(LabelBox{vw - 36, top + 56 + 48, 36, 56});
  if (ui.scaleBar.value_or(false)) boxes.push_back(LabelBox{70, vh - bottom - 30, 70, 18});
  if (ui.attribution.value_or(false)) boxes.push_back(LabelBox{vw - 90, vh - bottom - 24, 90, 14});
  return boxes;
}

std::vector<LabelBox> nativeHudExclusions(double vw, double vh, const MapUiState& ui) {
  // Status strip and bottom margin as engine-web (no insets: the map view is not under the status bar
  // in a typical layout, and the strip keeps cards off the very top edge anyway).
  std::vector<LabelBox> boxes{
      LabelBox{vw / 2, 14, vw / 2, 22},
      LabelBox{vw / 2, vh - 6, vw / 2, 14},
  };
  // Zoom buttons: 44 × 96 dp, 12 dp from the right edge, vertically centred (+ margins).
  if (ui.zoomButtons) boxes.push_back(LabelBox{vw - 34, vh / 2, 34, 56});
  // Compass (shown with the zoom buttons while the map is rotated): top-right corner.
  if (ui.compass) boxes.push_back(LabelBox{vw - 32, 56, 32, 28});
  // Scale bar: bottom-left, above the MapLibre logo when it is shown.
  if (ui.scaleBar) boxes.push_back(LabelBox{70, vh - (ui.logo ? 40 : 12) - 12, 70, 18});
  // MapLibre logo (bottom-left) and the attribution text + button (bottom-right).
  if (ui.logo) boxes.push_back(LabelBox{56, vh - 20, 56, 14});
  if (ui.attribution) boxes.push_back(LabelBox{vw - 110, vh - 18, 110, 14});
  return boxes;
}

double holoHeight(LabelKind kind) {
  switch (kind) {
    case LabelKind::District:
      return 7.0;
    case LabelKind::Poi:
      return 3.6;
    case LabelKind::Road:
      return 2.8;
  }
  return 0.0;
}

bool holoEligible(LabelKind kind, double dT, double dist) {
  if (kind == LabelKind::District) return dist > 40;
  if (kind == LabelKind::Poi) return dT < 24 + dist * 0.4;
  return dT < 14 + dist * 0.35 && dist < 120;
}

std::vector<std::pair<std::string, LabelBox>> placeHolo(const std::vector<HoloCandidate>& candidates,
                                                        const std::vector<LabelBox>& exclusions, int maxRoads) {
  std::vector<LabelBox> placed(exclusions);
  std::vector<std::pair<std::string, LabelBox>> shown;
  int roads = 0;
  std::vector<const HoloCandidate*> sorted;
  sorted.reserve(candidates.size());
  for (const HoloCandidate& c : candidates) sorted.push_back(&c);
  std::stable_sort(sorted.begin(), sorted.end(), [](const HoloCandidate* a, const HoloCandidate* b) {
    return a->pri != b->pri ? a->pri < b->pri : a->dT < b->dT;
  });
  for (const HoloCandidate* c : sorted) {
    if (!c->eligible || !c->onScreen || (c->kind == LabelKind::Road && roads >= maxRoads)) continue;
    const LabelBox box{c->topX, c->topY - c->h / 2 - 2, c->w / 2 + 5, c->h / 2 + 4};
    if (anyOverlap(placed, box)) continue;
    placed.push_back(box);
    shown.emplace_back(c->id, box);
    if (c->kind == LabelKind::Road) ++roads;
  }
  return shown;
}

bool domLabelVisible(LabelStyle style, LabelKind kind, int pri, double dist, double zoomOut) {
  bool show = kind == LabelKind::District ? (dist > 42 || zoomOut > 0.2)
              : kind == LabelKind::Road   ? (dist > 22 && (pri == 1 || dist < 115))
                                          : dist < 125;
  if (style == LabelStyle::Minimal && (pri == 3 || (kind == LabelKind::Poi && dist > 70))) show = false;
  if (style == LabelStyle::Clean && ((pri == 3 && dist > 80) || (kind == LabelKind::Poi && dist > 95))) show = false;
  return show;
}

double clampLabelX(double x, double hw, double vw, double margin) {
  const double lo = margin + hw, hi = vw - margin - hw;
  return lo > hi ? vw / 2 : std::min(hi, std::max(lo, x));
}

LabelBox rotatedBox(double x, double y, double w, double h, double angle) {
  const double c = std::fabs(std::cos(angle)), s = std::fabs(std::sin(angle));
  return LabelBox{x, y, (c * w + s * h) / 2 + 4, (s * w + c * h) / 2 + 3};
}

double uprightAngle(double a) {
  double r = a;
  if (r > kPi / 2) r -= kPi;
  if (r < -kPi / 2) r += kPi;
  return r;
}

LabelTile iconTileFor(HoloIconTile tile, bool night) {
  switch (tile) {
    case HoloIconTile::White:
      return LabelTile::White;
    case HoloIconTile::Black:
      return LabelTile::Black;
    case HoloIconTile::Color:
      return LabelTile::Color;
    case HoloIconTile::Auto:
      break;
  }
  return night ? LabelTile::Black : LabelTile::White;
}

LabelVisual labelVisualFor(LabelStyle style) {
  switch (style) {
    case LabelStyle::Holo:
      return LabelVisual::Holo;
    case LabelStyle::Minimal:
      return LabelVisual::Minimal;
    case LabelStyle::Clean:
      return LabelVisual::Clean;
    case LabelStyle::Sticker:
    case LabelStyle::Sign:
      return LabelVisual::Sticker;
    case LabelStyle::App:
    case LabelStyle::Ground:
      break;
  }
  return LabelVisual::App;
}

LabelStyle domStyleFor(LabelVisual visual) {
  switch (visual) {
    case LabelVisual::Minimal:
      return LabelStyle::Minimal;
    case LabelVisual::Clean:
      return LabelStyle::Clean;
    case LabelVisual::Sticker:
      return LabelStyle::Sticker;
    case LabelVisual::Holo:
    case LabelVisual::App:
    case LabelVisual::NameTag:
      break;
  }
  return LabelStyle::App;
}

// ---------------------------------------------------------------------------------------------------------
// Character name tags
// ---------------------------------------------------------------------------------------------------------

namespace {
/// engine-web `vehicles.ts` / `characters.ts`: plane scale and tail-fin top, the tag gap over the plane, the subway
/// ghost train's middle car (local z) and the tag height over it.
constexpr double kPlaneScale = 0.9;
constexpr double kPlaneTopY = 1.69;
constexpr double kPlaneTagGap = 0.3;
constexpr double kSubwayMiddleCarZ = -2.2;
constexpr double kSubwayTagHeight = 1.25;
}  // namespace

NameTagOffset nameTagAnchor(TravelMode mode, double yaw, double scale, double vehicleScale) {
  if (mode == TravelMode::Subway && vehicleScale > 0.55) {
    const double back = kSubwayMiddleCarZ * vehicleScale * scale;
    return NameTagOffset{std::sin(yaw) * back, kSubwayTagHeight * vehicleScale * scale, std::cos(yaw) * back};
  }
  if (mode == TravelMode::Plane && vehicleScale > 0.55) {
    return NameTagOffset{0.0, (kPlaneTopY * kPlaneScale * vehicleScale + kPlaneTagGap) * scale, 0.0};
  }
  return NameTagOffset{0.0, (mode == TravelMode::Car ? 2.0 : 2.3) * scale, 0.0};
}

LabelCardContent nameTagContent(const NameTag& tag) {
  LabelCardContent c;
  c.visual = LabelVisual::NameTag;
  c.kind = LabelKind::Poi;
  c.title = tag.text;
  c.showIcon = false;
  c.showSubtitle = false;
  c.player = tag.player;
  c.color = tag.player ? tag.color : 0;
  c.accessibilityLabel = tag.text;
  c.key = contentKey(c);
  return c;
}

// ---------------------------------------------------------------------------------------------------------
// Screen projection
// ---------------------------------------------------------------------------------------------------------

MapProjector::MapProjector(const MapCameraPose& pose, double width, double height)
    : width_(width), height_(height), worldSize_(camera_math::kMapLibreTileSize * std::pow(2.0, pose.zoom)) {
  const double lat = std::clamp(pose.center.lat, -85.051128779806604, 85.051128779806604);
  centerX_ = (180.0 + pose.center.lng) / 360.0 * worldSize_;
  centerY_ = (180.0 - 180.0 / kPi * std::log(std::tan(kPi / 4 + lat * kPi / 360.0))) / 360.0 * worldSize_;
  const double bearing = pose.bearing * kPi / 180.0, pitch = pose.pitch * kPi / 180.0;
  cosBearing_ = std::cos(bearing);
  sinBearing_ = std::sin(bearing);
  cosPitch_ = std::cos(pitch);
  sinPitch_ = std::sin(pitch);
  cameraDistance_ = 0.5 * height / std::tan(kMapLibreFovRad / 2);
  const double mpp = camera_math::mapLibreMetersPerPixel(pose.zoom, lat);
  pixelsPerMeter_ = mpp > 0 ? 1.0 / mpp : 0.0;
}

MapProjector::Point MapProjector::project(const LngLat& coordinate, double altitudeMeters) const {
  const double lat = std::clamp(coordinate.lat, -85.051128779806604, 85.051128779806604);
  const double px = (180.0 + coordinate.lng) / 360.0 * worldSize_ - centerX_;
  const double py = (180.0 - 180.0 / kPi * std::log(std::tan(kPi / 4 + lat * kPi / 360.0))) / 360.0 * worldSize_ - centerY_;
  // Rotate into the view (bearing clockwise from north: a point ahead of the camera ends up above the centre).
  const double rx = px * cosBearing_ + py * sinBearing_;
  const double ry = -px * sinBearing_ + py * cosBearing_;
  const double h = altitudeMeters * pixelsPerMeter_;
  // Camera at (0, D·sin p, D·cos p) looking at the centre; depth along its view direction.
  const double depth = cameraDistance_ - ry * sinPitch_ - h * cosPitch_;
  const double up = -ry * cosPitch_ + h * sinPitch_;
  Point p;
  p.inFront = depth > cameraDistance_ * 1e-3;
  const double d = p.inFront ? depth : cameraDistance_ * 1e-3;
  p.x = width_ / 2 + cameraDistance_ * rx / d;
  p.y = height_ / 2 - cameraDistance_ * up / d;
  return p;
}

// ---------------------------------------------------------------------------------------------------------
// Label system
// ---------------------------------------------------------------------------------------------------------

void LabelSystem::setWorld(const WorldData& world, const Projection& projection) {
  entries_ = buildLabelEntries(world, projection);
  worldSet_ = true;
  byPriority_.resize(entries_.size());
  for (std::size_t i = 0; i < entries_.size(); ++i) byPriority_[i] = i;
  std::stable_sort(byPriority_.begin(), byPriority_.end(),
                   [this](std::size_t a, std::size_t b) { return entries_[a].pri < entries_[b].pri; });
  rebuildContents();
}

void LabelSystem::clearWorld() {
  entries_.clear();
  byPriority_.clear();
  contents_.clear();
  worldSet_ = false;
}

void LabelSystem::setSpec(const LabelsSpec& spec) {
  spec_ = resolveLabels(spec);
  rebuildContents();
}

void LabelSystem::setContent(std::map<std::string, LabelContent> entries) {
  content_ = std::move(entries);
  rebuildContents();
}

void LabelSystem::rebuildContents() {
  const LabelVisual visual = labelVisualFor(spec_.style);
  contents_.clear();
  contents_.reserve(entries_.size());
  for (const LabelEntry& e : entries_) {
    const ResolvedLabelContent r = resolveLabelContent(e, spec_.content, content_);
    LabelCardContent c;
    c.visual = visual;
    c.kind = e.kind;
    c.water = e.water;
    c.arterial = e.roadClass == RoadClass::Arterial;
    c.title = r.title;
    c.subtitle = r.subtitle;
    c.icon = r.icon;
    c.showIcon = r.showIcon;
    c.showSubtitle = r.showSubtitle && !r.subtitle.empty();
    c.custom = r.custom;
    const std::string type = c.showSubtitle ? r.subtitle : e.subtitle.value_or(std::string());
    c.accessibilityLabel = type.empty() ? r.title : r.title + ", " + type;
    c.key = contentKey(c);
    contents_.push_back(std::move(c));
  }
}

std::vector<LabelCardContent> LabelSystem::takeUnmeasured() {
  if (sizes_.size() > kMaxCachedSizes) {
    sizes_.clear();
    requested_.clear();
  }
  std::vector<LabelCardContent> out;
  for (const std::vector<LabelCardContent>* list : {&contents_, &tagContents_}) {
    for (const LabelCardContent& c : *list) {
      if (sizes_.count(c.key) != 0 || !requested_.insert(c.key).second) continue;
      out.push_back(c);
    }
  }
  return out;
}

void LabelSystem::onMeasured(const std::vector<LabelCardContent>& items, const std::vector<LabelSize>& sizes) {
  for (std::size_t i = 0; i < items.size(); ++i) {
    requested_.erase(items[i].key);
    if (i < sizes.size() && std::isfinite(sizes[i].width) && std::isfinite(sizes[i].height) && sizes[i].width > 0 &&
        sizes[i].height > 0) {
      sizes_[items[i].key] = sizes[i];
    }
  }
}

void LabelSystem::resetRequests() { requested_.clear(); }

std::optional<LabelSize> LabelSystem::sizeOf(const std::string& key) const {
  const auto it = sizes_.find(key);
  return it != sizes_.end() ? std::optional<LabelSize>(it->second) : std::nullopt;
}

LabelFrame LabelSystem::layout(const LabelLayoutInput& in) const {
  LabelFrame frame;
  frame.visual = labelVisualFor(spec_.style);
  frame.tile = iconTileFor(spec_.icons, in.night);
  frame.night = in.night;
  if (!spec_.enabled || entries_.empty() || !(in.width > 0) || !(in.height > 0)) return frame;
  const MapProjector projector(in.pose, in.width, in.height);
  const std::vector<LabelBox> exclusions = nativeHudExclusions(in.width, in.height, in.ui);
  if (frame.visual == LabelVisual::Holo) {
    layoutHolo(in, projector, exclusions, frame);
  } else {
    layoutApp(in, projector, exclusions, frame);
  }
  return frame;
}

bool LabelSystem::setNameTags(std::vector<NameTag> tags) {
  tags_ = std::move(tags);
  tagContents_.clear();
  tagContents_.reserve(tags_.size());
  bool unknown = false;
  for (const NameTag& t : tags_) {
    LabelCardContent c = nameTagContent(t);
    unknown = unknown || (sizes_.count(c.key) == 0 && requested_.count(c.key) == 0);
    tagContents_.push_back(std::move(c));
  }
  return unknown;
}

std::vector<LabelCard> LabelSystem::layoutTags(const LabelLayoutInput& in) const {
  std::vector<LabelCard> out;
  // engine-web `updateTags`: hidden from a 0.6 zoom-out factor on.
  if (tags_.empty() || !(in.width > 0) || !(in.height > 0) || in.zoomOut >= kNameTagMaxZoomOut) return out;
  const double W = in.width, H = in.height;
  const MapProjector projector(in.pose, in.width, in.height);
  const std::vector<LabelBox> exclusions = nativeHudExclusions(W, H, in.ui);
  // The camera eye in world units (engine-web `CameraController.apply`: orbit around the target at the ground height).
  const double pitch = in.pose.pitch * kPi / 180.0, bearing = in.pose.bearing * kPi / 180.0;
  const double reach = in.distanceUnits * std::sin(pitch);
  const double eyeX = in.target.x - std::sin(bearing) * reach;
  const double eyeY = in.groundY + in.distanceUnits * std::cos(pitch);
  const double eyeZ = in.target.z + std::cos(bearing) * reach;
  for (std::size_t i = 0; i < tags_.size(); ++i) {
    const NameTag& t = tags_[i];
    if (std::hypot(eyeX - t.root.x, eyeY - t.rootY, eyeZ - t.root.z) >= kNameTagMaxDistance) continue;
    const std::optional<LabelSize> size = sizeOf(tagContents_[i].key);
    if (!size) continue;  // measured one main-thread hop later
    const MapProjector::Point s = projector.project(t.anchor, t.anchorY * in.unitMeters);
    if (!s.inFront || s.x < 0 || s.x > W || s.y < 0 || s.y > H) continue;  // engine-web `worldToScreen().visible`
    // The tag hangs above its anchor (CSS `translate(-50%, -100%)`); over a HUD zone it is hidden.
    const LabelBox box{s.x, s.y - size->height / 2, size->width / 2, size->height / 2};
    if (anyOverlap(exclusions, box)) continue;
    LabelCard card;
    card.id = "tag:" + t.characterId;
    card.content = tagContents_[i];
    card.x = s.x;
    card.y = s.y - size->height / 2;
    card.width = size->width;
    card.height = size->height;
    out.push_back(std::move(card));
  }
  return out;
}

void LabelSystem::layoutHolo(const LabelLayoutInput& in, const MapProjector& projector,
                             const std::vector<LabelBox>& exclusions, LabelFrame& frame) const {
  const double W = in.width, H = in.height, dist = in.distanceUnits;
  struct Anchor {
    double gx = 0, gy = 0, tx = 0;
  };
  std::vector<HoloCandidate> candidates(entries_.size());
  std::vector<Anchor> anchors(entries_.size());
  std::unordered_map<std::string, std::size_t> indexOf;
  for (std::size_t i = 0; i < entries_.size(); ++i) {
    const LabelEntry& e = entries_[i];
    HoloCandidate& c = candidates[i];
    c.id = e.id;
    c.kind = e.kind;
    c.pri = e.pri;
    c.dT = std::hypot(e.x - in.target.x, e.z - in.target.z);
    c.eligible = holoEligible(e.kind, c.dT, dist);
    if (!c.eligible) continue;
    const std::optional<LabelSize> size = sizeOf(contents_[i].key);
    const MapProjector::Point g = projector.project(e.lngLat, in.groundY * in.unitMeters);
    const MapProjector::Point t = projector.project(e.lngLat, (in.groundY + holoHeight(e.kind)) * in.unitMeters);
    // Not measured yet: not placed (the size arrives one main-thread hop later).
    c.onScreen = size.has_value() && g.inFront && t.inFront && t.x >= -0.01 * W && t.x <= 1.01 * W && t.y >= 0.01 * H &&
                 t.y <= 0.99 * H;
    anchors[i] = Anchor{g.x, g.y, t.x};
    if (size) {
      c.w = size->width;
      c.h = size->height;
    }
    // The whole card stays inside the viewport horizontally (the dot and the leader line keep the true anchor).
    c.topX = c.w > 0 ? clampLabelX(t.x, c.w / 2, W) : t.x;
    c.topY = t.y;
    indexOf.emplace(e.id, i);
  }
  const auto shown = placeHolo(candidates, exclusions);
  std::vector<bool> isShown(entries_.size(), false);
  for (const auto& s : shown) isShown[indexOf.at(s.first)] = true;
  for (std::size_t i = 0; i < entries_.size(); ++i) {  // engine-web DOM order: entry order
    if (!isShown[i]) continue;
    const HoloCandidate& c = candidates[i];
    const Anchor& a = anchors[i];
    const double px = c.topX, py = c.topY, inset = std::min(10.0, c.w / 2);
    LabelCard card;
    card.id = c.id;
    card.content = contents_[i];
    card.width = c.w;
    card.height = c.h;
    card.x = px;
    card.y = py - 2 - c.h / 2;
    card.dotX = a.gx;
    card.dotY = a.gy;
    card.lineX = std::min(px + c.w / 2 - inset, std::max(px - c.w / 2 + inset, a.tx));
    card.lineY = py;
    frame.cards.push_back(std::move(card));
  }
}

void LabelSystem::layoutApp(const LabelLayoutInput& in, const MapProjector& projector,
                            const std::vector<LabelBox>& exclusions, LabelFrame& frame) const {
  const double W = in.width, H = in.height, dist = in.distanceUnits;
  const LabelStyle style = domStyleFor(frame.visual);
  std::vector<LabelBox> placed(exclusions);
  for (const std::size_t i : byPriority_) {
    const LabelEntry& e = entries_[i];
    if (!domLabelVisible(style, e.kind, e.pri, dist, in.zoomOut)) continue;
    const std::optional<LabelSize> size = sizeOf(contents_[i].key);
    if (!size) continue;
    const MapProjector::Point s = projector.project(e.lngLat, kAppLabelY * in.unitMeters);
    if (!(s.x >= -0.025 * W && s.x <= 1.025 * W && s.y >= -0.025 * H && s.y <= 1.025 * H) || !s.inFront) continue;
    double angle = 0.0;
    if (e.kind == LabelKind::Road && style != LabelStyle::Sticker && e.along) {
      const MapProjector::Point s2 = projector.project(*e.along, kAppLabelY * in.unitMeters);
      angle = uprightAngle(std::atan2(s2.y - s.y, s2.x - s.x));
    }
    const double w = size->width, h = size->height;
    const double sx = clampLabelX(s.x, (std::fabs(std::cos(angle)) * w + std::fabs(std::sin(angle)) * h) / 2, W);
    const LabelBox box = rotatedBox(sx, s.y, w, h, angle);
    if (anyOverlap(placed, box)) continue;
    placed.push_back(box);
    LabelCard card;
    card.id = e.id;
    card.content = contents_[i];
    card.x = sx;
    card.y = s.y;
    card.width = w;
    card.height = h;
    card.angle = angle;
    card.opacity = e.kind == LabelKind::District ? std::min(1.0, 0.45 + in.zoomOut) : 1.0;  // engine-web dom-styles
    frame.cards.push_back(std::move(card));
  }
}

}  // namespace maprama
