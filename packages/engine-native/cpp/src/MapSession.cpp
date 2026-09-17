#include "maprama/MapSession.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <utility>

#include "maprama/CameraMath.hpp"
#include "maprama/ProceduralWorld.hpp"
#include "maprama/Projection.hpp"
#include "maprama/TravelLogic.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/protocol.hpp"

namespace maprama {

namespace {

using json::Value;
namespace cm = camera_math;

constexpr double kInf = std::numeric_limits<double>::infinity();
constexpr double kPiConst = 3.14159265358979323846;
constexpr double kDegToRad = kPiConst / 180.0;

const Value* member(const Value& object, std::string_view key) { return object.isObject() ? object.find(key) : nullptr; }

std::optional<double> numberMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  return v != nullptr && v->isNumber() ? std::optional<double>(v->asNumber()) : std::nullopt;
}

std::optional<bool> boolMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  return v != nullptr && v->isBoolean() ? std::optional<bool>(v->asBool()) : std::nullopt;
}

std::optional<LngLat> lngLatMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  if (v == nullptr || !v->isObject()) return std::nullopt;
  return LngLat{numberMember(*v, "lng").value_or(0.0), numberMember(*v, "lat").value_or(0.0)};
}

/// `animate`: `true` = the engine default duration, an object = its `durationMs`, absent = no animation.
double animationMs(const Value& spec) {
  const Value* animate = member(spec, "animate");
  if (animate == nullptr) return 0.0;
  if (animate->isBoolean()) return animate->asBool() ? camera_math::kDefaultAnimationMs : 0.0;
  if (animate->isObject()) return numberMember(*animate, "durationMs").value_or(0.0);
  return 0.0;
}

/// `FitBoundsParams.padding`: one number for all four sides, or a per-side object.
camera_math::FitPadding fitPadding(const Value& params) {
  const Value* p = member(params, "padding");
  if (p == nullptr) return {};
  if (p->isNumber()) {
    const double v = p->asNumber();
    return {v, v, v, v};
  }
  if (!p->isObject()) return {};
  return {numberMember(*p, "top").value_or(0.0), numberMember(*p, "right").value_or(0.0),
          numberMember(*p, "bottom").value_or(0.0), numberMember(*p, "left").value_or(0.0)};
}

Value lngLatValue(const LngLat& ll) { return Value::object({{"lng", ll.lng}, {"lat", ll.lat}}); }

double angleDelta(double a, double b) {
  double d = std::fmod(a - b, 360.0);
  if (d > 180.0) d -= 360.0;
  if (d < -180.0) d += 360.0;
  return std::fabs(d);
}

bool sameState(const CameraState& a, const CameraState& b) {
  return std::fabs(a.center.lng - b.center.lng) <= 1e-9 && std::fabs(a.center.lat - b.center.lat) <= 1e-9 &&
         std::fabs(a.distance - b.distance) <= 1e-6 * std::max(1.0, std::fabs(b.distance)) &&
         std::fabs(a.pitch - b.pitch) <= 1e-6 && angleDelta(a.bearing, b.bearing) <= 1e-6;
}

bool sameAnchors(const std::vector<OverlayAnchor>& a, const std::vector<OverlayAnchor>& b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (a[i].id != b[i].id || a[i].coordinate.lng != b[i].coordinate.lng || a[i].coordinate.lat != b[i].coordinate.lat) {
      return false;
    }
  }
  return true;
}

/// engine-web `OverlayTracker` change test.
bool positionsChanged(const std::vector<ScreenPoint>& a, const std::vector<ScreenPoint>& b) {
  if (a.size() != b.size()) return true;
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (a[i].visible != b[i].visible || std::fabs(a[i].x - b[i].x) >= kOverlayEpsilonPx ||
        std::fabs(a[i].y - b[i].y) >= kOverlayEpsilonPx) {
      return true;
    }
  }
  return false;
}

/// Label frames that would look the same (positions within 0.05 dp; the sequence is not part of the look).
bool sameLabelFrame(const LabelFrame& a, const LabelFrame& b) {
  if (a.visual != b.visual || a.tile != b.tile || a.night != b.night || a.cards.size() != b.cards.size()) return false;
  const auto near = [](double p, double q) { return std::fabs(p - q) < 0.05; };
  for (std::size_t i = 0; i < a.cards.size(); ++i) {
    const LabelCard& p = a.cards[i];
    const LabelCard& q = b.cards[i];
    // Markers keep their content key across a recolour / reselection (that is the point of the design), so
    // the tint and the selected flag are compared too: they still have to reach the platform.
    if (p.id != q.id || p.content.key != q.content.key || p.content.color != q.content.color ||
        p.content.selected != q.content.selected || p.content.accessibilityLabel != q.content.accessibilityLabel ||
        p.opacity != q.opacity || !near(p.x, q.x) || !near(p.y, q.y) ||
        !near(p.width, q.width) || !near(p.height, q.height) || !near(p.angle * 100, q.angle * 100) ||
        !near(p.dotX, q.dotX) || !near(p.dotY, q.dotY) || !near(p.lineX, q.lineX) || !near(p.lineY, q.lineY)) {
      return false;
    }
  }
  return true;
}

bool pointInRing(double x, double z, const std::vector<Vec2>& ring) {
  bool inside = false;
  for (std::size_t i = 0, j = ring.size() - 1; i < ring.size(); j = i++) {
    const double xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > z) != (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

WorldPoint ringCentroid(const std::vector<Vec2>& ring) {
  double a2 = 0, cx = 0, cz = 0;
  for (std::size_t i = 0, j = ring.size() - 1; i < ring.size(); j = i++) {
    const double cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a2 += cross;
    cx += (ring[j][0] + ring[i][0]) * cross;
    cz += (ring[j][1] + ring[i][1]) * cross;
  }
  if (std::fabs(a2) > 1e-12) return WorldPoint{cx / (3.0 * a2), cz / (3.0 * a2)};
  double sx = 0, sz = 0;
  for (const Vec2& p : ring) {
    sx += p[0];
    sz += p[1];
  }
  const double n = ring.empty() ? 1.0 : static_cast<double>(ring.size());
  return WorldPoint{sx / n, sz / n};
}

/// Compares two layer arrays; returns false when they differ in anything but paint values (then the
/// whole style must be re-sent), otherwise appends every changed paint property to `out`.
bool diffLayers(const Value& before, const Value& after, std::vector<PaintPropertyChange>& out) {
  if (!before.isArray() || !after.isArray() || before.items().size() != after.items().size()) return false;
  static const Value kNull;
  const auto same = [](const Value* a, const Value* b) {
    return json::stringify(a != nullptr ? *a : kNull) == json::stringify(b != nullptr ? *b : kNull);
  };
  for (std::size_t i = 0; i < after.items().size(); ++i) {
    const Value& a = before.items()[i];
    const Value& b = after.items()[i];
    for (const char* key : {"id", "type", "source", "filter", "layout"}) {
      if (!same(a.find(key), b.find(key))) return false;
    }
    const Value* pa = a.find("paint");
    const Value* pb = b.find("paint");
    if (pa == nullptr || pb == nullptr) {
      if (pa != pb) return false;
      continue;
    }
    if (pa->members().size() != pb->members().size()) return false;
    for (const json::Member& m : pb->members()) {
      const Value* old = pa->find(m.key);
      if (old == nullptr) return false;
      std::string next = json::stringify(m.value);
      if (json::stringify(*old) != next) out.push_back(PaintPropertyChange{b.find("id")->asString(), m.key, std::move(next)});
    }
  }
  return true;
}

}  // namespace

MapSession::MapSession(MessageSink& sink, WorldStore& world, ClockMs clock)
    : sink_(sink),
      world_(world),
      clock_(std::move(clock)),
      themes_(ThemeResolver::builtIn()),
      animatingUntilMs_(-kInf),
      cameraIdleAtMs_(kInf),
      cameraMoveReasonUntilMs_(-kInf),
      lastOverlayRequestMs_(-kInf),
      scheduledFrameAtMs_(kInf) {
  theme_ = themes_.resolve(Value::object());
  look_ = mapLookFor(theme_);
  light_ = look_.light;
  styleJson_ = buildEmptyStyle();
}

// ---------------------------------------------------------------------------------------------------
// Platform side
// ---------------------------------------------------------------------------------------------------

void MapSession::attachAdapter(std::shared_ptr<MapAdapter> adapter) {
  adapter_ = std::move(adapter);
  scheduledFrameAtMs_ = kInf;
  overlayToken_ = 0;
  pendingTaps_.clear();
  animatingUntilMs_ = -kInf;
  pendingMeasures_.clear();
  labels_.resetRequests();
  labelFrameSent_ = false;
  labelsDirty_ = true;
  if (!adapter_) return;
  sendStyle();
  zoomSentValid_ = false;
  pushBuildingLayerZoom(true);
  uiSentValid_ = false;
  pushUi();
  pushLimits();
  if (worldReady_ || cameraUnsent_) sendState();
  requestLabelSizes();
  overlayWanted_ = true;
  pump();
}

void MapSession::detachAdapter() {
  std::map<std::uint64_t, PendingRequest> pending;
  pending.swap(pendingRequests_);
  for (auto& [token, request] : pending) {
    respondError(request.requestId, kNotReadyCode, "the map view was detached before the request completed");
  }
  if (pendingWorld_) {
    const std::string url = pendingWorld_->url;
    pendingWorld_.reset();
    emitError(error_codes::kWorldLoadFailed, "failed to load " + url + ": the map view was detached", true);
  }
  pendingTaps_.clear();
  pendingMeasures_.clear();
  labels_.resetRequests();
  labelFrameSent_ = false;
  markers_.clearPlacement();  // nothing is on screen any more, so nothing is pressable
  overlayToken_ = 0;
  adapter_.reset();
  scheduledFrameAtMs_ = kInf;
}

void MapSession::setViewport(const Viewport& viewport) {
  const bool heightChanged = viewport.height != viewport_.height;
  const bool sizeChanged = heightChanged || viewport.width != viewport_.width;
  viewport_ = viewport;
  if (!sizeChanged) return;
  labelsDirty_ = true;
  if (heightChanged) {
    // The protocol distance is physical: keep it (and re-derive the MapLibre zoom) when the view resizes.
    pushLimits();
    if (worldReady_ || cameraUnsent_) sendState();
  }
  pushUi();
  overlayWanted_ = true;
  pump();
}

void MapSession::onCameraChanged(const MapCameraPose& pose) {
  // A camera still waiting for the viewport (`sendState`) is the target: until it reached the map, the map
  // reports its own initial pose (0,0, zoom 0), which must not replace it (iOS remounts: the world loads
  // before the view is laid out and the new map reports in between).
  if (cameraUnsent_) return;
  CameraState next;
  next.center = pose.center;
  next.distance = cm::mapLibreZoomToDistance(pose.zoom, pose.center.lat, viewport_.height);
  next.pitch = pose.pitch;
  next.bearing = pose.bearing;
  // The map reports the pose it was given, i.e. the *shifted* centre: undo `poseFor`'s content-inset shift so
  // `CameraState.center` keeps meaning "under the middle of the visible area".
  next.center = offsetByMeters(next.center, insetShiftFor(next).x, insetShiftFor(next).z);
  if (sameState(next, state_)) return;
  state_ = next;
  cameraChanged();
}

void MapSession::onProjected(std::uint64_t token, double x, double y) {
  auto it = pendingRequests_.find(token);
  if (it == pendingRequests_.end()) return;
  const PendingRequest request = std::move(it->second);
  pendingRequests_.erase(it);
  const bool finite = std::isfinite(x) && std::isfinite(y);
  const cm::VisibleRect vr = cm::visibleRect(viewport_.width, viewport_.height, contentPadding());
  const bool visible = finite && x >= vr.x && y >= vr.y && x <= vr.x + vr.width && y <= vr.y + vr.height;
  respondOk(request.requestId,
            Value::object({{"x", finite ? x : 0.0}, {"y", finite ? y : 0.0}, {"visible", visible}}));
}

void MapSession::onPointsProjected(std::uint64_t token, const std::vector<ScreenPoint>& points) {
  if (token == 0 || token != overlayToken_) return;
  overlayToken_ = 0;
  if (!sameAnchors(anchorsInFlight_, anchors_) || points.size() != anchors_.size()) {
    // The anchors changed while the projection was in flight: project the new set.
    overlayWanted_ = !anchors_.empty();
    pump();
    return;
  }
  std::vector<ScreenPoint> positions;
  positions.reserve(points.size());
  // `visible` is "inside the visible area", i.e. content-inset aware (engine-web `worldToScreen`).
  const cm::VisibleRect vr = cm::visibleRect(viewport_.width, viewport_.height, contentPadding());
  for (const ScreenPoint& p : points) {
    const bool finite = std::isfinite(p.x) && std::isfinite(p.y);
    ScreenPoint s;
    s.x = finite ? p.x : 0.0;
    s.y = finite ? p.y : 0.0;
    s.visible = finite && p.x >= vr.x && p.y >= vr.y && p.x <= vr.x + vr.width && p.y <= vr.y + vr.height;
    positions.push_back(s);
  }
  if ((overlayDirty_ || positionsChanged(lastPositions_, positions)) && events_ != nullptr) {
    Value list = Value::array();
    for (std::size_t i = 0; i < positions.size(); ++i) {
      list.push(Value::object(
          {{"id", anchors_[i].id}, {"x", positions[i].x}, {"y", positions[i].y}, {"visible", positions[i].visible}}));
    }
    events_->emit(Value::object({{"type", "overlay:positions"}, {"positions", std::move(list)}}));
  }
  lastPositions_ = std::move(positions);
  overlayDirty_ = false;
  pump();  // a camera change that arrived meanwhile is due now (or at the next frame)
}

void MapSession::onUnprojected(std::uint64_t token, const std::optional<LngLat>& coordinate) {
  auto it = pendingRequests_.find(token);
  if (it == pendingRequests_.end()) return;
  const PendingRequest request = std::move(it->second);
  pendingRequests_.erase(it);
  const bool valid = coordinate && std::isfinite(coordinate->lng) && std::isfinite(coordinate->lat);
  respondOk(request.requestId, Value::object({{"coordinate", valid ? lngLatValue(*coordinate) : Value(nullptr)}}));
}

void MapSession::onBuildingQueried(std::uint64_t token, const std::optional<std::string>& buildingId,
                                   const std::optional<LngLat>& ground) {
  if (pendingTaps_.erase(token) == 0 || !worldReady_ || events_ == nullptr) return;
  const bool groundValid = ground && std::isfinite(ground->lng) && std::isfinite(ground->lat);
  if (buildingId && renderedIndex_.count(*buildingId) != 0) {
    const BuildingFootprint& b = world_.world()->buildings[rendered_[renderedIndex_.at(*buildingId)].worldIndex];
    const Projection& projection = *world_.projection();
    // engine-web reports the hit point on the building; the SDK query has no hit point, so the ground point
    // under the tap is used when it lies on the footprint, the footprint centroid otherwise.
    LngLat coordinate = projection.toLngLat(ringCentroid(b.footprint));
    if (groundValid) {
      const WorldPoint p = projection.toWorld(*ground);
      if (pointInRing(p.x, p.z, b.footprint)) coordinate = *ground;
    }
    events_->emit(Value::object({{"type", "building:press"}, {"buildingId", *buildingId}, {"coordinate", lngLatValue(coordinate)}}));
    return;
  }
  if (groundValid) events_->emit(Value::object({{"type", "map:press"}, {"coordinate", lngLatValue(*ground)}}));
}

void MapSession::onTextFetched(std::uint64_t token, bool ok, const std::string& bodyOrError) {
  if (!pendingWorld_ || pendingWorld_->token != token) return;  // superseded by a newer init
  PendingWorld pending = std::move(*pendingWorld_);
  pendingWorld_.reset();
  if (!ok) {
    emitError(error_codes::kWorldLoadFailed, bodyOrError, true);
    return;
  }
  json::ParseResult parsed = json::parse(bodyOrError);
  if (!parsed.ok) {
    emitError(error_codes::kWorldLoadFailed, "failed to load " + pending.url + ": " + parsed.error, true);
    return;
  }
  loadWorldValue(parsed.value, pending.initMsg, pending.url);
}

void MapSession::onLabelsMeasured(std::uint64_t token, const std::vector<LabelSize>& sizes) {
  auto it = pendingMeasures_.find(token);
  if (it == pendingMeasures_.end()) return;
  const std::vector<LabelCardContent> items = std::move(it->second);
  pendingMeasures_.erase(it);
  labels_.onMeasured(items, sizes);
  labelsDirty_ = true;
  pump();
}

void MapSession::frame() {
  scheduledFrameAtMs_ = kInf;
  pump();
}

void MapSession::tap(double x, double y) {
  if (!worldReady_ || !viewReady()) {
    log(LogLevel::Debug, "engine-native: tap ignored (no world or no laid-out map view)");
    return;
  }
  // Markers come first: a press that hits one emits `marker:press` **only** (engine-web `Engine.tap`).
  // Label cards are not pressable on either engine, and a shown marker always reserves its box against the
  // labels, so a marker under an overlapping label still wins.
  if (const std::optional<MarkerPress> press = markers_.hitTest(x, y)) {
    if (events_ != nullptr) {
      events_->emit(Value::object({{"type", "marker:press"},
                                   {"layerId", press->layerId},
                                   {"markerId", press->markerId},
                                   {"coordinate", lngLatValue(press->coordinate)},
                                   {"point", Value::object({{"x", press->x}, {"y", press->y}})}}));
    }
    return;
  }
  const std::uint64_t token = nextToken_++;
  pendingTaps_.insert(token);
  adapter_->queryBuilding(token, x, y);
}

void MapSession::zoomButton(bool zoomIn) {
  if (!worldReady_ || !canMoveCamera()) return;
  CameraState target = state_;
  const double factor = zoomIn ? 1.0 / kZoomButtonStep : kZoomButtonStep;
  target.distance = cm::clampValue(state_.distance * factor, distanceMin(), distanceMax());
  animatingUntilMs_ = clock_() + kZoomButtonMs;
  // A zoom button is the user's finger on an engine ornament, not a command the host sent: `gesture`.
  noteCameraMove(CameraIdleReason::Gesture, kZoomButtonMs);
  adapter_->moveCamera(poseFor(target), kZoomButtonMs);
}

// ---------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------

void MapSession::init(const Value& msg) {
  // engine-web: the theme and ui of `init` apply at once (a `setTheme` sent while a url world loads wins).
  if (const Value* theme = member(msg, "theme")) setThemeState(*theme);
  if (const Value* ui = member(msg, "ui")) setUiState(*ui);
  if (const Value* labels = member(msg, "labels")) setLabelsState(*labels);

  const Value& source = *msg.find("world");
  const std::string& kind = source.find("kind")->asString();
  pendingWorld_.reset();
  if (kind == "data") {
    loadWorldValue(*source.find("world"), msg, {});
  } else if (kind == "url") {
    const std::string& url = source.find("url")->asString();
    if (!adapter_) {
      emitError(error_codes::kWorldLoadFailed, "failed to load " + url + ": no map view is attached", true);
      return;
    }
    PendingWorld pending{nextToken_++, url, msg};
    const std::uint64_t token = pending.token;
    pendingWorld_ = std::move(pending);
    adapter_->fetchText(token, url);
  } else if (kind == "procedural") {
    loadProceduralWorld(source, msg);
  } else if (kind == "tiles") {
    // The payload format is understood (maprama/TileFormat.hpp decodes MTIL v1 and is covered by
    // cpp/tests/tile_tests.cpp), but nothing streams or draws tiles on the native engine yet: say so
    // instead of pretending to load a world. engine-web implements `kind: "tiles"`.
    emitError(error_codes::kUnsupported,
              "world source kind \"tiles\" is not supported by the native engine yet (use engine=\"web\")", true);
  } else {
    // Unreachable: decodeCommand only accepts data / url / procedural / tiles.
    emitError(error_codes::kUnsupported, "world source kind " + json::quote(kind) + " is not supported", true);
  }
}

void MapSession::loadProceduralWorld(const Value& source, const Value& initMsg) {
  // `decodeCommand` already checked `layout` (grid | town) and `seed` (integer).
  const ProceduralLayout layout =
      parseEnum<ProceduralLayout>(source.find("layout")->asString()).value_or(ProceduralLayout::Town);
  const double seed = numberMember(source, "seed").value_or(0.0);
  const auto t0 = std::chrono::steady_clock::now();
  const ProceduralWorld generated = buildProceduralWorld(layout, seed);
  const Value worldData = proceduralWorldData(generated);
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  log(LogLevel::Info, "engine-native: generated procedural " + std::string(enumName(layout)) + " (seed " +
                          json::numberToString(seed) + ", " + std::to_string(generated.buildings.size()) +
                          " buildings) in " + json::numberToString(std::round(ms * 10) / 10) + " ms");
  WorldExtras extras;
  extras.start = generated.start;
  extras.palette.reserve(generated.buildings.size());
  for (const ProceduralBuilding& b : generated.buildings) extras.palette.push_back(static_cast<std::uint32_t>(b.ci));
  extras.generated = &generated;
  loadWorldValue(worldData, initMsg, {}, extras);
}

void MapSession::loadWorldValue(const Value& worldData, const Value& initMsg, const std::string& url) {
  loadWorldValue(worldData, initMsg, url, WorldExtras{});
}

void MapSession::loadWorldValue(const Value& worldData, const Value& initMsg, const std::string& url,
                                const WorldExtras& extras) {
  Result<WorldLoadReport> loaded = world_.load(worldData);
  if (!loaded.ok()) {
    emitError(error_codes::kWorldLoadFailed, url.empty() ? loaded.error : "invalid WorldData from " + url + ": " + loaded.error,
              true);
    return;
  }
  onWorldLoaded(*loaded.value, initMsg, extras);
}

void MapSession::onWorldLoaded(const WorldLoadReport& report, const Value& initMsg, const WorldExtras& extras) {
  for (const std::string& warning : report.warnings) log(LogLevel::Warn, "engine-native: init world: " + warning);
  const WorldData& world = *world_.world();
  const Projection& projection = *world_.projection();
  log(LogLevel::Info, "engine-native: world loaded (" + std::to_string(report.roads) + " roads, " +
                          std::to_string(report.buildings) + " buildings, " + std::to_string(report.pois) + " pois)");

  // A new world starts without building overrides (engine-web keeps them only for the same world).
  rendered_ = renderedBuildings(world);
  if (extras.palette.size() == world.buildings.size()) {
    // Procedural worlds keep the generator's palette index (engine-web `BuildingModel.ci`).
    for (RenderedBuilding& rb : rendered_) rb.ci = extras.palette[rb.worldIndex];
  }
  renderedIndex_.clear();
  for (std::size_t i = 0; i < rendered_.size(); ++i) {
    renderedIndex_.emplace(world.buildings[rendered_[i].worldIndex].id, i);  // first id wins, like findBuilding
  }
  buildingStyles_.clear();
  sources_ = buildWorldSources(world, projection, rendered_);
  if (hooks_ != nullptr) hooks_->extendSources(sources_);
  layers_ = worldLayers();
  light_ = look_.light;
  styleDirty_ = true;
  worldReady_ = true;
  buildingLayer_.reset();
  updateBuildingLayer(false);

  // engine-web `loadWorld`: target the world start (plaza, else bounds centre) with DEFAULT_ORBIT.
  WorldPoint start{(world.bounds.minX + world.bounds.maxX) / 2.0, (world.bounds.minZ + world.bounds.maxZ) / 2.0};
  if (world.plaza) start = *world.plaza;
  if (extras.start) start = *extras.start;  // procedural: engine-web targets the generator's start point
  state_.center = projection.toLngLat(start);
  state_.distance = cm::kDefaultDistanceUnits * world.unitMeters;
  state_.pitch = cm::kDefaultPitch;
  state_.bearing = cm::kDefaultBearing;

  if (adapter_) {
    sendStyle();
    pushLimits();
  }
  sendState();
  // engine-web: world hooks (characters, drops, geofences) run before `init.camera` (which may follow a character).
  if (hooks_ != nullptr) hooks_->worldLoaded(initMsg, extras.generated);
  // engine-web: `labelsIndex` after every world load (same ids, same shape), emitted by the world hooks, i.e.
  // before `init.camera` (whose `follow` may fail with `unknown_character`).
  labels_.setWorld(world, projection);
  markers_.reproject(projection);  // a new world means a new projection (engine-web `MarkerLayers.reproject`)
  labelGroundY_ = groundYFor(extras.generated != nullptr ? std::optional<ProceduralLayout>(extras.generated->layout) : std::nullopt);
  if (events_ != nullptr) {
    events_->emit(Value::object({{"type", "labelsIndex"}, {"labels", labelsIndexValue(labels_.entries())}}));
  }
  requestLabelSizes();
  labelsDirty_ = true;
  if (const Value* camera = member(initMsg, "camera")) setCamera(*camera, "init");
  overlayDirty_ = true;
  lastPositions_.clear();
  cameraChanged();
}

void MapSession::setCamera(const Value& spec, std::string_view command) {
  // The limits come first: a spec that widens the range and moves out in one command must not be
  // clamped by the range it replaces.
  applyCameraLimits(spec);
  const std::optional<LngLat> center = lngLatMember(spec, "center");
  // engine-web: `follow` is resolved first (an unknown character fails the whole command); a `center` without
  // `follow` stops following.
  if (const Value* follow = member(spec, "follow")) {
    const std::optional<std::string> id = follow->isString() ? std::optional<std::string>(follow->asString()) : std::nullopt;
    if (hooks_ == nullptr) {
      if (id) log(LogLevel::Warn, "engine-native: setCamera.follow " + json::quote(*id) + " needs the game session; ignored");
    } else if (!hooks_->setFollow(id)) {
      emitError("unknown_character", std::string(command) + ": cannot follow \"" + *id + "\": no such character", false);
      return;
    }
  } else if (center && hooks_ != nullptr) {
    hooks_->setFollow(std::nullopt);
  }
  CameraState target = state_;
  if (center) target.center = *center;
  if (const std::optional<double> distance = numberMember(spec, "distance")) {
    target.distance = cm::clampValue(*distance, distanceMin(), distanceMax());
  } else if (const std::optional<double> zoom = numberMember(spec, "zoom")) {
    const double lat = center ? center->lat : referenceLat();
    target.distance = cm::clampValue(cm::webZoomToDistance(*zoom, lat, viewport_.height), distanceMin(), distanceMax());
  }
  if (const std::optional<double> pitch = numberMember(spec, "pitch")) {
    target.pitch = cm::clampValue(*pitch, cm::kPitchMin, cm::kPitchMax);
  }
  if (const std::optional<double> bearing = numberMember(spec, "bearing")) target.bearing = *bearing;

  moveCameraTo(target, animationMs(spec));
}

void MapSession::moveCameraTo(const CameraState& target, double durationMs) {
  noteCameraMove(CameraIdleReason::Api, durationMs);
  if (durationMs > 0 && canMoveCamera()) {
    // The adapter animates and reports every intermediate camera; the state follows those reports.
    animatingUntilMs_ = clock_() + durationMs;
    adapter_->moveCamera(poseFor(target), durationMs);
    return;
  }
  if (sameState(target, state_) && !cameraUnsent_) return;
  state_ = target;
  sendState();
  cameraChanged();
}

void MapSession::fitBounds(const std::string& requestId, const Value& params) {
  const WorldData* w = world_.world();
  if (!worldReady_ || w == nullptr) {
    respondError(requestId, kNotReadyCode, "no world loaded (send init first)");
    return;
  }
  // A tangent plane on the world origin with one unit = one meter: the fit math is scale free, so
  // running it in meters is engine-web's world-unit run times `unitMeters` (fixture-compared).
  Result<Projection> projection = Projection::create(ProjectionOptions{w->origin, 1.0});
  if (!projection.ok()) {
    respondError(requestId, kNotReadyCode, projection.error);
    return;
  }
  const Projection& proj = *projection.value;
  const Value* bounds = member(params, "bounds");
  const LngLat ne = bounds != nullptr ? lngLatMember(*bounds, "ne").value_or(LngLat{}) : LngLat{};
  const LngLat sw = bounds != nullptr ? lngLatMember(*bounds, "sw").value_or(LngLat{}) : LngLat{};
  const auto corner = [&proj](double lng, double lat) {
    const WorldPoint p = proj.toWorld(LngLat{lng, lat});
    return camera_math::FitPoint{p.x, p.z};
  };

  camera_math::FitBoundsInput in;
  in.corners = {corner(sw.lng, sw.lat), corner(ne.lng, sw.lat), corner(ne.lng, ne.lat), corner(sw.lng, ne.lat)};
  in.width = viewport_.width;
  in.height = viewport_.height;
  in.padding = fitPadding(params);
  // `ui.contentInset` is app chrome over the map, so it is padding on top of what the request asked for
  // (engine-web frames into the visible area the same way).
  in.padding.top += ui_.contentInset.top;
  in.padding.right += ui_.contentInset.right;
  in.padding.bottom += ui_.contentInset.bottom;
  in.padding.left += ui_.contentInset.left;
  in.fovDeg = cm::kReferenceFovDeg;
  const std::optional<double> pitch = numberMember(params, "pitch");
  const std::optional<double> bearing = numberMember(params, "bearing");
  in.pitch = cm::clampValue(pitch.value_or(state_.pitch), cm::kPitchMin, cm::kPitchMax);
  in.bearing = bearing.value_or(state_.bearing);
  in.minDistance = distanceMin();
  in.maxDistance = distanceMax();
  in.startDistance = state_.distance;

  // An explicit pitch / bearing is an instruction, so it turns `auto`'s fallback off.
  cm::FitOrientation orientation = pitch || bearing ? cm::FitOrientation::Keep : cm::FitOrientation::Auto;
  if (const Value* o = member(params, "orientation")) {
    if (o->isString()) {
      const std::string& name = o->asString();
      orientation = name == "keep"    ? cm::FitOrientation::Keep
                    : name == "reset" ? cm::FitOrientation::Reset
                                      : cm::FitOrientation::Auto;
    }
  }
  const cm::FitBoundsOutput out = cm::fitBounds(in, orientation);

  if (hooks_ != nullptr) hooks_->setFollow(std::nullopt);
  const LngLat center = proj.toLngLat(WorldPoint{out.x, out.z});
  CameraState target{center, out.distance, out.pitch, out.bearing};
  moveCameraTo(target, animationMs(params));
  respondOk(requestId, Value::object({
                           {"camera", Value::object({{"center", lngLatValue(center)},
                                                     {"distance", out.distance},
                                                     {"pitch", out.pitch},
                                                     {"bearing", cm::normalizeBearing(out.bearing)}})},
                           {"fitted", out.fitted},
                           {"distanceLimited", out.distanceLimited},
                       }));
}

void MapSession::applyCameraLimits(const Value& spec) {
  const std::optional<double> wantMin = numberMember(spec, "minDistanceMeters");
  const std::optional<double> wantMax = numberMember(spec, "maxDistanceMeters");
  if (!wantMin && !wantMax) return;
  if (wantMin) limitMinMeters_ = *wantMin;
  if (wantMax) limitMaxMeters_ = *wantMax;
  const double u = unitMeters();
  const double askMin = limitMinMeters_ ? *limitMinMeters_ / u : cm::kDistanceMinUnits;
  const double askMax = limitMaxMeters_ ? *limitMaxMeters_ / u : cm::kDistanceMaxUnits;
  // MapLibre owns the gestures: its zoom bounds have to follow the new range or a pinch could leave it.
  pushLimits();
  const double effMin = distanceMin() / u, effMax = distanceMax() / u;
  if (askMin == effMin && askMax == effMax) return;
  const std::string key = "cameraLimits:" + json::numberToString(askMin) + "/" + json::numberToString(askMax) + "/" +
                          json::numberToString(u);
  if (!warned_.insert(key).second) return;
  const auto meters = [u](double units) { return json::numberToString(std::round(units * u)) + " m"; };
  emitError(kCameraLimitsClampedCode,
            "camera distance range " + meters(askMin) + "-" + meters(askMax) +
                " is outside what this engine can render at " + json::numberToString(u) +
                " m per world unit; using " + meters(effMin) + "-" + meters(effMax),
            false);
}

void MapSession::setTheme(const Value& themeSpec) {
  setThemeState(themeSpec);
  applyLook();
  labelsDirty_ = true;  // night palette / icon tile
  pump();  // M4: the zoom-out behaviour may have changed
}

void MapSession::setThemeState(const Value& themeSpec) {
  theme_ = themes_.resolve(themeSpec);
  look_ = mapLookFor(theme_);
  zoomOut_.invalidate();  // engine-web re-applies the zoom-out look after a theme change
  for (const std::string& option : unrenderedThemeOptions(theme_)) {
    warnOnce("theme:" + option, "engine-native: theme option " + option + " is accepted but not rendered yet");
  }
}

void MapSession::setUi(const Value& uiSpec) {
  setUiState(uiSpec);
  pushUi();
  labelsDirty_ = true;  // HUD exclusion zones
  pump();
}

void MapSession::setLabels(const Value& labelsSpec) {
  setLabelsState(labelsSpec);
  requestLabelSizes();
  pump();
}

void MapSession::setLabelsState(const Value& labelsSpec) {
  labels_.setSpec(parseLabelsSpec(labelsSpec));
  const LabelStyle style = labels_.spec().style;
  if (style == LabelStyle::Ground || style == LabelStyle::Sign) {
    const std::string name(enumName(style));
    warnOnce("labels.style." + name,
             "engine-native: label style " + json::quote(name) + " is drawn as " +
                 (style == LabelStyle::Ground ? "\"app\"" : "\"sticker\"") +
                 " labels (3D ground / sign labels need the custom layer, M2c)");
  }
  labelsDirty_ = true;
}

void MapSession::setLabelContent(const Value& entries) {
  labels_.setContent(parseLabelContentEntries(entries));
  labelsDirty_ = true;
  requestLabelSizes();
  pump();
}

void MapSession::setNameTags(std::vector<NameTag> tags) {
  if (tags.empty() && labels_.nameTags().empty()) return;
  if (labels_.setNameTags(std::move(tags))) requestLabelSizes();
  tagsDirty_ = true;
  pumpLabels();
}

void MapSession::setMarkerLayer(const Value& msg) {
  markers_.setLayer(msg, worldReady_ ? world_.projection() : nullptr);
  labelsDirty_ = true;  // the marker boxes are exclusions of the label pass
  pumpLabels();
}

void MapSession::removeMarkerLayer(const std::string& layerId) {
  if (!markers_.removeLayer(layerId)) return;
  labelsDirty_ = true;
  pumpLabels();
}

void MapSession::setUiState(const Value& uiSpec) {
  // engine-web replaces the whole ui object (`this.ui = {...cmd.ui}`): absent fields are off.
  const ContentInset previousInset = ui_.contentInset;
  ui_ = MapUiSpec{};
  ui_.locationPuck = boolMember(uiSpec, "locationPuck");
  ui_.scaleBar = boolMember(uiSpec, "scaleBar");
  ui_.zoomButtons = boolMember(uiSpec, "zoomButtons");
  ui_.attribution = boolMember(uiSpec, "attribution");
  if (const Value* inset = member(uiSpec, "contentInset")) {
    ui_.contentInset.top = numberMember(*inset, "top").value_or(0.0);
    ui_.contentInset.right = numberMember(*inset, "right").value_or(0.0);
    ui_.contentInset.bottom = numberMember(*inset, "bottom").value_or(0.0);
    ui_.contentInset.left = numberMember(*inset, "left").value_or(0.0);
  }
  const bool insetChanged = !(ui_.contentInset == previousInset);
  // `contentInset` is applied in full since M5: the camera centre and `follow` centring move with it
  // (`insetShiftFor`), the ornaments are laid out inside the visible area by both platform views
  // (`MapUiState::inset`), labels and markers are placed inside it, `camera:idle` measures it and
  // `ScreenPoint.visible` means "inside the visible area".
  if (insetChanged) {
    labelsDirty_ = true;
    overlayDirty_ = true;
    overlayWanted_ = !anchors_.empty();
    sendState();
  }
}

void MapSession::setBuildingStyle(const std::string& buildingId, const Value& style) {
  // engine-web's messages (`setBuildingStyle: ...` from its dispatcher, fatal: false).
  if (!worldReady_) {
    emitError(kNotReadyCode, "setBuildingStyle: no world loaded (send init first)", false);
    return;
  }
  if (renderedIndex_.count(buildingId) == 0) {
    emitError(kUnknownBuildingCode, "setBuildingStyle: unknown building \"" + buildingId + "\"", false);
    return;
  }
  if (style.isNull()) {
    buildingStyles_.erase(buildingId);
  } else {
    BuildingOverride o;
    if (const Value* c = member(style, "color"); c != nullptr && c->isString()) o.color = parseCssHex(c->asString());
    if (const Value* s = member(style, "state"); s != nullptr && s->isString()) o.captured = s->asString() == "captured";
    if (const Value* r = member(style, "roof"); r != nullptr && r->isString()) {
      const auto& names = EnumNames<RoofShape>::values;
      for (std::size_t i = 0; i < names.size(); ++i) {
        if (names[i] == r->asString()) o.roof = static_cast<RoofShape>(i);
      }
    }
    if (const Value* f = member(style, "facade"); f != nullptr && f->isBoolean()) o.facade = f->asBool();
    for (const char* field : {"decorations", "massing", "replaceModel"}) {
      if (member(style, field) != nullptr) {
        warnOnce(std::string("setBuildingStyle.") + field,
                 std::string("engine-native: setBuildingStyle.") + field +
                     " is accepted but not rendered yet; color, state, roof and facade are applied");
      }
    }
    buildingStyles_[buildingId] = o;
  }
  applyLook();
}

void MapSession::setOverlayAnchors(const Value& anchors) {
  anchors_.clear();
  if (anchors.isArray()) {
    for (const Value& a : anchors.items()) {
      const Value* id = member(a, "id");
      anchors_.push_back(OverlayAnchor{id != nullptr ? id->asString() : std::string(), lngLatMember(a, "coordinate").value_or(LngLat{})});
    }
  }
  overlayDirty_ = true;
  lastPositions_.clear();
  overlayWanted_ = !anchors_.empty();
  pump();
}

void MapSession::subscribeCamera(double throttleMs) {
  subscriptions_.subscribe(SubscriptionTopic::CameraChange, std::nullopt, throttleMs);
  pump();
}

void MapSession::unsubscribeCamera() { subscriptions_.unsubscribe(SubscriptionTopic::CameraChange, std::nullopt); }

void MapSession::subscribeCameraIdle(double throttleMs) {
  subscriptions_.subscribe(SubscriptionTopic::CameraIdle, std::nullopt, throttleMs);
  // Subscribing arms one event, so the host learns what is on screen without waiting for a move.
  cameraIdleAtMs_ = clock_() + kCameraIdleDelayMs;
  pump();
}

void MapSession::unsubscribeCameraIdle() {
  subscriptions_.unsubscribe(SubscriptionTopic::CameraIdle, std::nullopt);
  cameraIdleAtMs_ = kInf;
}

void MapSession::request(const std::string& requestId, RequestMethod method, const Value& params) {
  if (!viewReady()) {
    respondError(requestId, kNotReadyCode, "the map view is not ready (no laid-out native view is attached)");
    return;
  }
  if (method == RequestMethod::FitBounds) {
    fitBounds(requestId, params);
    return;
  }
  const std::uint64_t token = nextToken_++;
  pendingRequests_[token] = PendingRequest{requestId, method};
  if (method == RequestMethod::Project) {
    adapter_->project(token, lngLatMember(params, "coordinate").value_or(LngLat{}));
  } else {
    adapter_->unproject(token, numberMember(params, "x").value_or(0.0), numberMember(params, "y").value_or(0.0));
  }
}

bool MapSession::followCenter(const LngLat& center) {
  if (!worldReady_ || clock_() < animatingUntilMs_) return false;
  CameraState target = state_;
  target.center = center;
  if (sameState(target, state_) && !cameraUnsent_) return false;
  noteCameraMove(CameraIdleReason::Follow, 0.0);
  state_ = target;
  sendState();
  cameraChanged();
  return true;
}

void MapSession::shutdown() {
  adapter_.reset();
  pendingRequests_.clear();
  pendingTaps_.clear();
  pendingWorld_.reset();
  subscriptions_.clear();
  anchors_.clear();
  pendingMeasures_.clear();
  markers_.clear();
  overlayToken_ = 0;
}

// ---------------------------------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------------------------------

const std::string& MapSession::styleJson() const {
  if (styleDirty_ && worldReady_) {
    styleJson_ = json::stringify(composeStyle(sources_, layers_, light_));
    styleDirty_ = false;
  }
  return styleJson_;
}

BuildingPaint MapSession::buildingPaint() const {
  BuildingPaint paint;
  for (const auto& [id, o] : buildingStyles_) {
    const RenderedBuilding& rb = rendered_[renderedIndex_.at(id)];
    if (o.color || o.captured) paint.colors.emplace_back(id, buildingOverrideColor(look_, rb.ci, rb.index, o));
    if (o.captured) paint.captured.push_back(id);
  }
  return paint;
}

Value MapSession::worldLayers() const {
  Value layers = buildWorldLayers(*world_.world(), look_, buildingPaint(), zoomOutPaint());
  if (hooks_ != nullptr) hooks_->extendLayers(layers, look_);
  return layers;
}

void MapSession::sendStyle() {
  adapter_->setStyleJson(styleJson());
  // M2c: the platform re-inserts its custom building layer into every loaded style; M3a: the new style
  // carries empty game sources, which the hooks re-send.
  if (buildingLayer_) adapter_->setBuildingLayer(buildingLayer_);
  if (hooks_ != nullptr) hooks_->styleSent();
}

void MapSession::applyLook() {
  if (!worldReady_) return;
  Value next = worldLayers();
  const MapLight light = look_.light;
  if (adapter_) {
    std::vector<PaintPropertyChange> changes;
    if (!diffLayers(layers_, next, changes)) {
      layers_ = std::move(next);
      light_ = light;
      styleDirty_ = true;
      sendStyle();
      updateBuildingLayer(true);
      return;
    }
    if (!changes.empty()) adapter_->setPaintProperties(changes);
    if (light != light_) adapter_->setLight(light);
  }
  layers_ = std::move(next);
  light_ = light;
  styleDirty_ = true;
  updateBuildingLayer(true);
}

void MapSession::updateBuildingLayer(bool send) {
  if (!worldReady_) return;
  BuildingLayerData next = buildBuildingLayer(*world_.world(), *world_.projection(), rendered_, theme_, look_, buildingStyles_);
  if (buildingLayer_ && buildingLayer_->sameContent(next)) return;
  next.version = ++buildingLayerVersion_;
  buildingLayer_ = std::make_shared<const BuildingLayerData>(std::move(next));
  if (send && adapter_) adapter_->setBuildingLayer(buildingLayer_);
}

// ---------------------------------------------------------------------------------------------------
// Map UI
// ---------------------------------------------------------------------------------------------------

double MapSession::metersPerDp() const {
  // Ground resolution at the target: the protocol distance frames 2·d·tan(20°) over the viewport height.
  return viewport_.height > 0 ? 2.0 * state_.distance * std::tan(cm::kReferenceFovDeg / 2.0 * kDegToRad) / viewport_.height : 0.0;
}

void MapSession::pushUi() {
  if (!adapter_) return;
  MapUiState s;
  if (worldReady_) {
    const WorldData& w = *world_.world();
    if (ui_.scaleBar.value_or(false) && viewport_.height > 0) {
      const ScaleBarSpec bar = scaleBarFor(metersPerDp());
      s.scaleBar = bar.width > 0;
      s.scaleBarWidth = bar.width;
      s.scaleBarLabel = bar.label;
    }
    s.zoomButtons = ui_.zoomButtons.value_or(false);
    s.compass = s.zoomButtons;
    std::string text;
    for (const std::string& line : w.attribution) {
      if (line.empty()) continue;
      if (!text.empty()) text += " · ";
      text += line;
    }
    s.attribution = ui_.attribution.value_or(false) && !text.empty();
    if (s.attribution) s.attributionText = text;
    s.logo = ui_.attribution.value_or(false);
  }
  // The inset reaches the platform even without a world: the ornaments must never sit under app chrome.
  s.inset = ui_.contentInset;
  if (uiSentValid_ && s == uiSent_) return;
  uiSent_ = s;
  uiSentValid_ = true;
  adapter_->setUi(s);
}

// ---------------------------------------------------------------------------------------------------
// Camera helpers
// ---------------------------------------------------------------------------------------------------

camera_math::FitPadding MapSession::contentPadding() const {
  cm::FitPadding pad;
  pad.top = ui_.contentInset.top;
  pad.right = ui_.contentInset.right;
  pad.bottom = ui_.contentInset.bottom;
  pad.left = ui_.contentInset.left;
  return pad;
}

camera_math::FitPoint MapSession::insetShiftFor(const CameraState& state) const {
  if (ui_.contentInset.empty() || !(viewport_.width > 0) || !(viewport_.height > 0)) return cm::FitPoint{};
  // The shift is computed in the *MapLibre* frustum (36.87°), because it is the MapLibre camera that moves;
  // the core's own projector (`MapProjector`) uses the same pose and keeps the view centre, so labels,
  // markers and name tags stay exactly where the map draws.
  const double metersPerPixel = cm::mapLibreMetersPerPixel(
      cm::distanceToMapLibreZoom(state.distance, state.center.lat, viewport_.height), state.center.lat);
  const double cameraDistanceMeters = 0.5 * viewport_.height / std::tan(kMapLibreFovRad / 2.0) * metersPerPixel;
  return cm::insetShift(viewport_.width, viewport_.height, contentPadding(), cameraDistanceMeters, state.pitch,
                        state.bearing, kMapLibreFovRad * 180.0 / kPiConst);
}

LngLat MapSession::offsetByMeters(const LngLat& center, double east, double south) const {
  if (east == 0.0 && south == 0.0) return center;
  const double metersPerDegLng = kMetersPerDegreeLng * std::max(std::cos(center.lat * kDegToRad), 1e-12);
  return LngLat{center.lng + east / metersPerDegLng, center.lat - south / kMetersPerDegreeLat};
}

MapCameraPose MapSession::poseFor(const CameraState& state) const {
  MapCameraPose pose;
  // `ui.contentInset`: the protocol centre belongs under the middle of the *visible* area, so the map looks
  // at `centre - shift` (engine-web `CameraController.apply`).
  const cm::FitPoint shift = insetShiftFor(state);
  pose.center = offsetByMeters(state.center, -shift.x, -shift.z);
  pose.zoom = cm::distanceToMapLibreZoom(state.distance, state.center.lat, viewport_.height);
  pose.pitch = state.pitch;
  pose.bearing = state.bearing;
  return pose;
}

MapCameraLimits MapSession::limits() const {
  MapCameraLimits l;
  const double lat = referenceLat();
  // Slightly wider than the core's own distance clamp so the map never re-clamps a commanded camera.
  l.minZoom = cm::distanceToMapLibreZoom(distanceMax(), lat, viewport_.height) - 0.01;
  l.maxZoom = cm::distanceToMapLibreZoom(distanceMin(), lat, viewport_.height) + 0.01;
  l.minPitch = cm::kPitchMin;
  l.maxPitch = cm::kPitchMax;
  return l;
}

bool MapSession::canMoveCamera() const { return adapter_ != nullptr && viewport_.height > 0; }

bool MapSession::viewReady() const { return adapter_ != nullptr && viewport_.height > 0 && viewport_.width > 0; }

void MapSession::sendState() {
  if (!canMoveCamera()) {
    cameraUnsent_ = true;
    return;
  }
  cameraUnsent_ = false;
  adapter_->moveCamera(poseFor(state_), 0.0);
}

void MapSession::pushLimits() {
  if (adapter_ && worldReady_ && viewport_.height > 0) adapter_->setCameraLimits(limits());
}

void MapSession::cameraChanged() {
  subscriptions_.markChanged(SubscriptionTopic::CameraChange);
  cameraIdleReason_ = currentCameraMoveReason();
  if (subscriptions_.has(SubscriptionTopic::CameraIdle)) cameraIdleAtMs_ = clock_() + kCameraIdleDelayMs;
  overlayWanted_ = !anchors_.empty();
  labelsDirty_ = true;
  pushUi();
  pump();
  if (hooks_ != nullptr) hooks_->cameraMoved();
}

void MapSession::noteCameraMove(CameraIdleReason reason, double durationMs) {
  cameraMoveReason_ = reason;
  cameraMoveReasonUntilMs_ = clock_() + std::max(0.0, durationMs) + kCameraIdleReasonGraceMs;
}

CameraIdleReason MapSession::currentCameraMoveReason() const {
  // Anything the adapter reports outside a commanded move is the user moving the map.
  return clock_() <= cameraMoveReasonUntilMs_ ? cameraMoveReason_ : CameraIdleReason::Gesture;
}

Value MapSession::cameraIdleEvent() const {
  // The visible area's ground quad, in meters around the camera centre, clamped at the far plane so a
  // camera looking towards the horizon still reports a box an app can query (protocol
  // CAMERA_IDLE_HORIZON_FACTOR).
  cm::FitPadding inset;
  inset.top = ui_.contentInset.top;
  inset.right = ui_.contentInset.right;
  inset.bottom = ui_.contentInset.bottom;
  inset.left = ui_.contentInset.left;
  const std::vector<cm::FitPoint> corners =
      cm::visibleGroundCorners(viewport_.width, viewport_.height, inset, state_.distance, state_.pitch,
                               state_.bearing, kCameraIdleHorizonFactor * state_.distance);
  const double metersPerDegLng =
      kMetersPerDegreeLng * std::max(std::cos(state_.center.lat * kDegToRad), 1e-12);
  // `visibleGroundCorners` measures from the point the optical axis hits, which under `ui.contentInset` is
  // the *pose* centre (`poseFor`: protocol centre − shift), not the protocol centre this event reports.
  // Undo the shift so `bounds` and `radiusMeters` are both anchored on the centre in the payload — otherwise
  // a bottom sheet pushes the box a shift north of its own centre and a radius query drops the POIs just
  // above the sheet.
  const cm::FitPoint shift = insetShiftFor(state_);
  double minLng = kInf, minLat = kInf, maxLng = -kInf, maxLat = -kInf, maxMeters = 0.0;
  for (const cm::FitPoint& c : corners) {
    const double east = c.x - shift.x, south = c.z - shift.z;
    const double lng = state_.center.lng + east / metersPerDegLng;
    const double lat = state_.center.lat - south / kMetersPerDegreeLat;
    minLng = std::min(minLng, lng);
    maxLng = std::max(maxLng, lng);
    minLat = std::min(minLat, lat);
    maxLat = std::max(maxLat, lat);
    maxMeters = std::max(maxMeters, std::sqrt(east * east + south * south));
  }
  return Value::object({
      {"type", "camera:idle"},
      {"camera", Value::object({{"center", lngLatValue(state_.center)},
                                {"distance", state_.distance},
                                {"pitch", state_.pitch},
                                {"bearing", cm::normalizeBearing(state_.bearing)}})},
      {"bounds", Value::object({{"ne", Value::object({{"lng", maxLng}, {"lat", maxLat}})},
                                {"sw", Value::object({{"lng", minLng}, {"lat", minLat}})}})},
      {"radiusMeters", maxMeters},
      {"reason", std::string(enumName(cameraIdleReason_))},
  });
}

void MapSession::pumpCameraIdle(double now, double* nextDelay) {
  if (!worldReady_ || !subscriptions_.has(SubscriptionTopic::CameraIdle)) return;
  if (cameraIdleAtMs_ == kInf) return;
  if (now < cameraIdleAtMs_) {
    *nextDelay = std::min(*nextDelay, cameraIdleAtMs_ - now);
    return;
  }
  // The camera has been still for the idle delay: `takeDue` applies the subscription's own throttle
  // (a floor between idle events) and tells us when the window opens if it is still closed.
  double delay = kInf;
  subscriptions_.markChanged(SubscriptionTopic::CameraIdle);
  const auto due = subscriptions_.takeDue(SubscriptionTopic::CameraIdle, now, &delay);
  if (!due.empty()) {
    cameraIdleAtMs_ = kInf;
    if (events_ != nullptr) events_->emit(cameraIdleEvent());
  }
  *nextDelay = std::min(*nextDelay, delay);
}

void MapSession::pump() {
  const double now = clock_();
  double nextDelay = kInf;
  if (worldReady_ && subscriptions_.has(SubscriptionTopic::CameraChange)) {
    double delay = kInf;
    const auto due = subscriptions_.takeDue(SubscriptionTopic::CameraChange, now, &delay);
    if (!due.empty() && events_ != nullptr) {
      events_->emit(Value::object({
          {"type", "camera:change"},
          {"camera", Value::object({{"center", lngLatValue(state_.center)},
                                    {"distance", state_.distance},
                                    {"pitch", state_.pitch},
                                    {"bearing", cm::normalizeBearing(state_.bearing)}})},
      }));
    }
    nextDelay = std::min(nextDelay, delay);
  }
  pumpCameraIdle(now, &nextDelay);
  pumpOverlay(now, &nextDelay);
  pumpZoomOut(now, &nextDelay);
  pumpLabels();
  if (std::isfinite(nextDelay)) requestFrame(now, nextDelay);
}

double MapSession::unitMeters() const {
  const WorldData* w = world_.world();
  return w != nullptr ? w->unitMeters : kDefaultUnitMeters;
}

void MapSession::pumpZoomOut(double now, double* nextDelay) {
  if (!worldReady_) return;
  const double units = state_.distance / unitMeters();
  const ZoomOutBehavior behavior = theme_.zoomOut;
  if (zoomOut_.settling(units, behavior)) {
    // engine-web steps the factor every rendered frame with that frame's dt (at most 50 ms); the session steps it in
    // its own 16 ms frames while it eases, starting from rest with one 16 ms step.
    const double dt = zoomOutLastMs_ ? std::clamp((now - *zoomOutLastMs_) / 1000.0, 0.0, 0.05) : kZoomOutFrameMs / 1000.0;
    zoomOutLastMs_ = now;
    if (zoomOut_.update(dt, units, behavior)) applyZoomOut();
  }
  if (zoomOut_.settling(units, behavior)) {
    *nextDelay = std::min(*nextDelay, kZoomOutFrameMs);
  } else {
    zoomOutLastMs_.reset();
  }
  if (zoomOut_.updateSprites(units, behavior) && hooks_ != nullptr) hooks_->zoomOutChanged();
}

ZoomOutPaint MapSession::zoomOutPaint() const {
  ZoomOutPaint p;
  p.heightScale = zoomOut_.look().heightScale;
  p.mapOpacity = zoomOut_.look().mapOpacity;
  return p;
}

void MapSession::applyZoomOut() {
  if (!worldReady_) return;
  // Only the zoom-out paint properties change: patch them in the current layers instead of rebuilding the style.
  const std::vector<PaintPropertyChange> changes = zoomOutPaintChanges(layers_, look_, zoomOutPaint());
  if (!changes.empty()) {
    styleDirty_ = true;
    if (adapter_) adapter_->setPaintProperties(changes);
  }
  pushBuildingLayerZoom(false);
}

void MapSession::pushBuildingLayerZoom(bool force) {
  if (!adapter_) return;
  BuildingLayerZoom z;
  z.heightScale = static_cast<float>(zoomOut_.look().heightScale);
  z.lowDetail = zoomOut_.look().lowDetail();
  if (!force && zoomSentValid_ && z == zoomSent_) return;
  zoomSent_ = z;
  zoomSentValid_ = true;
  adapter_->setBuildingLayerZoom(z);
}

// ---------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------

void MapSession::requestLabelSizes() {
  if (!adapter_ || !worldReady_) return;
  std::vector<LabelCardContent> items = labels_.takeUnmeasured();
  if (items.empty()) return;
  const std::uint64_t token = nextToken_++;
  adapter_->measureLabels(token, items);
  pendingMeasures_.emplace(token, std::move(items));
}

void MapSession::pumpLabels() {
  // Synchronous on every change (camera reports arrive once per rendered frame), so the cards follow the
  // map without a projection round trip; the frame is only sent when it differs from the last one.
  if (!(labelsDirty_ || tagsDirty_) || !viewReady()) {
    if (!viewReady()) markers_.clearPlacement();
    return;
  }
  const auto started = std::chrono::steady_clock::now();
  const bool full = labelsDirty_ || !worldReady_;
  labelsDirty_ = false;
  tagsDirty_ = false;
  LabelFrame frame;
  if (worldReady_) {
    const WorldData& w = *world_.world();
    LabelLayoutInput in;
    in.pose = poseFor(state_);
    in.width = viewport_.width;
    in.height = viewport_.height;
    in.ui = uiSent_;
    in.unitMeters = w.unitMeters;
    in.distanceUnits = state_.distance / w.unitMeters;
    in.target = world_.projection()->toWorld(state_.center);
    in.night = theme_.time.lights > 0.8;  // engine-web `params.lights > 0.8`
    in.groundY = labelGroundY_;
    in.zoomOut = zoomOutFactor(theme_.zoomOut, in.distanceUnits);
    if (full) {
      // engine-web `Features.project`: the markers are placed first, and their boxes reserve space in the
      // label pass, so a label never covers a marker and a marker never yields to a label.
      const std::vector<LabelBox> hud = nativeHudExclusions(in.width, in.height, in.ui);
      MarkerFrame placedMarkers = markers_.layout(in, hud);
      labelOnly_ = labels_.layout(in, placedMarkers.boxes);
      // Markers are drawn above the labels (engine-web `.mpr-mk { z-index: 2 }`) and below the name tags.
      labelOnly_.cards.insert(labelOnly_.cards.end(), std::make_move_iterator(placedMarkers.cards.begin()),
                              std::make_move_iterator(placedMarkers.cards.end()));
    }
    frame = labelOnly_;
    std::vector<LabelCard> tags = labels_.layoutTags(in);  // after the labels: drawn on top (engine-web DOM order)
    frame.cards.insert(frame.cards.end(), std::make_move_iterator(tags.begin()), std::make_move_iterator(tags.end()));
  } else {
    labelOnly_ = LabelFrame();
    markers_.clearPlacement();
  }
  recordLabelPass(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count(), !full);
  // Diagnostic: labels on, entries known, but nothing placed (usually card sizes that were never measured).
  const bool nothingShown = worldReady_ && labels_.spec().enabled && !labels_.entries().empty() && frame.cards.empty();
  if (nothingShown != labelsEmptyLogged_) {
    labelsEmptyLogged_ = nothingShown;
    if (nothingShown) {
      log(LogLevel::Info, "engine-native: labels: nothing placed (" + std::to_string(labels_.entries().size()) + " labels, " +
                              std::to_string(labels_.knownSizes()) + " sizes known, " + std::to_string(labels_.unansweredRequests()) +
                              " awaiting measurement)");
    } else {
      log(LogLevel::Info, "engine-native: labels: " + std::to_string(frame.cards.size()) + " cards placed again");
    }
  }
  if (labelFrameSent_ && sameLabelFrame(frame, labelFrame_)) return;
  labelFrame_ = std::move(frame);
  labelFrame_.sequence = ++labelFrameSeq_;
  labelFrameSent_ = true;
  adapter_->setLabelFrame(labelFrame_);
}

void MapSession::recordLabelPass(double ms, bool tagsOnly) {
  for (LabelPlacementStats* st : {&labelStats_, &labelWindow_}) {
    ++st->passes;
    if (tagsOnly) ++st->tagPasses;
    st->totalMs += ms;
    st->maxMs = std::max(st->maxMs, ms);
  }
  // Every 5 s of activity: the per-pass cost on the thread that placed them (the platform logs it; DESIGN.md §8).
  const double now = clock_();
  if (labelWindowStartMs_ < 0) labelWindowStartMs_ = now;
  if (now - labelWindowStartMs_ < 5000.0) return;
  const auto fixed = [](double v, int digits) {
    std::string out = std::to_string(v);
    const std::size_t dot = out.find('.');
    return dot == std::string::npos ? out : out.substr(0, dot + 1 + static_cast<std::size_t>(digits));
  };
  const LabelPlacementStats& w = labelWindow_;
  log(LogLevel::Info, "engine-native: label placement " + std::to_string(w.passes) + " passes (" + std::to_string(w.tagPasses) +
                          " name-tag only) in " + fixed((now - labelWindowStartMs_) / 1000.0, 1) + " s: avg " +
                          fixed(w.totalMs / static_cast<double>(w.passes), 3) + " ms, max " + fixed(w.maxMs, 3) + " ms (" +
                          std::to_string(labelFrame_.cards.size()) + " cards)");
  labelWindow_ = LabelPlacementStats();
  labelWindowStartMs_ = now;
}

void MapSession::pumpOverlay(double now, double* nextDelay) {
  if (anchors_.empty() || !worldReady_ || !viewReady() || overlayToken_ != 0 || !overlayWanted_) return;
  const double since = now - lastOverlayRequestMs_;
  if (since < kOverlayIntervalMs) {
    *nextDelay = std::min(*nextDelay, kOverlayIntervalMs - since);
    return;
  }
  overlayWanted_ = false;
  lastOverlayRequestMs_ = now;
  overlayToken_ = nextToken_++;
  anchorsInFlight_ = anchors_;
  std::vector<LngLat> coordinates;
  coordinates.reserve(anchors_.size());
  for (const OverlayAnchor& a : anchors_) coordinates.push_back(a.coordinate);
  adapter_->projectPoints(overlayToken_, coordinates);
}

void MapSession::requestFrame(double now, double delayMs) {
  if (adapter_ && now + delayMs < scheduledFrameAtMs_ - 0.5) {
    scheduledFrameAtMs_ = now + delayMs;
    adapter_->scheduleFrame(delayMs);
  }
}

double MapSession::referenceLat() const {
  const WorldData* w = world_.world();
  return worldReady_ && w != nullptr ? w->origin.lat : state_.center.lat;
}

// The app's limits are meters and the engine's defaults are world units; both are resolved to world
// units for the world in force, clamped into what the renderer can serve, and handed back in meters.
double MapSession::distanceMin() const {
  const double u = unitMeters();
  const double want = limitMinMeters_ ? *limitMinMeters_ / u : cm::kDistanceMinUnits;
  return cm::clampValue(want, cm::kDistanceHardMinUnits, cm::kDistanceHardMaxUnits) * u;
}

double MapSession::distanceMax() const {
  const double u = unitMeters();
  const double lo = distanceMin() / u;
  const double want = limitMaxMeters_ ? *limitMaxMeters_ / u : cm::kDistanceMaxUnits;
  return cm::clampValue(want, lo, cm::kDistanceHardMaxUnits) * u;
}

// ---------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------

void MapSession::emitError(std::string_view code, std::string message, bool fatal) {
  if (events_ == nullptr) return;
  events_->emit(Value::object({{"type", "error"}, {"code", std::string(code)}, {"message", std::move(message)}, {"fatal", fatal}}));
}

void MapSession::respondOk(const std::string& requestId, Value result) {
  if (events_ == nullptr) return;
  events_->emit(Value::object({{"type", "response"}, {"requestId", requestId}, {"ok", true}, {"result", std::move(result)}}));
}

void MapSession::respondError(const std::string& requestId, std::string_view code, std::string message) {
  if (events_ == nullptr) return;
  events_->emit(Value::object({{"type", "response"},
                               {"requestId", requestId},
                               {"ok", false},
                               {"error", Value::object({{"code", std::string(code)}, {"message", std::move(message)}})}}));
}

void MapSession::log(LogLevel level, const std::string& message) { sink_.onLog(level, message); }

void MapSession::warnOnce(const std::string& key, const std::string& message) {
  if (warned_.insert(key).second) log(LogLevel::Warn, message);
}

}  // namespace maprama
