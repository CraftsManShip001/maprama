#include "maprama/MapSession.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

#include "maprama/CameraMath.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/protocol.hpp"

namespace maprama {

namespace {

using json::Value;
namespace cm = camera_math;

constexpr double kInf = std::numeric_limits<double>::infinity();
constexpr double kDegToRad = 3.14159265358979323846 / 180.0;

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
  if (!adapter_) return;
  adapter_->setStyleJson(styleJson());
  uiSentValid_ = false;
  pushUi();
  pushLimits();
  if (worldReady_ || cameraUnsent_) sendState();
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
  overlayToken_ = 0;
  adapter_.reset();
  scheduledFrameAtMs_ = kInf;
}

void MapSession::setViewport(const Viewport& viewport) {
  const bool heightChanged = viewport.height != viewport_.height;
  const bool sizeChanged = heightChanged || viewport.width != viewport_.width;
  viewport_ = viewport;
  if (!sizeChanged) return;
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
  CameraState next;
  next.center = pose.center;
  next.distance = cm::mapLibreZoomToDistance(pose.zoom, pose.center.lat, viewport_.height);
  next.pitch = pose.pitch;
  next.bearing = pose.bearing;
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
  const bool visible = finite && x >= 0 && y >= 0 && x <= viewport_.width && y <= viewport_.height;
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
  for (const ScreenPoint& p : points) {
    const bool finite = std::isfinite(p.x) && std::isfinite(p.y);
    ScreenPoint s;
    s.x = finite ? p.x : 0.0;
    s.y = finite ? p.y : 0.0;
    s.visible = finite && p.x >= 0 && p.y >= 0 && p.x <= viewport_.width && p.y <= viewport_.height;
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

void MapSession::frame() {
  scheduledFrameAtMs_ = kInf;
  pump();
}

void MapSession::tap(double x, double y) {
  if (!worldReady_ || !viewReady()) {
    log(LogLevel::Debug, "engine-native: tap ignored (no world or no laid-out map view)");
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
  adapter_->moveCamera(poseFor(target), kZoomButtonMs);
}

// ---------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------

void MapSession::init(const Value& msg) {
  // engine-web: the theme and ui of `init` apply at once (a `setTheme` sent while a url world loads wins).
  if (const Value* theme = member(msg, "theme")) setThemeState(*theme);
  if (const Value* ui = member(msg, "ui")) setUiState(*ui);
  warnOnce("init.labels", "engine-native: init.labels / setLabels are not applied yet (labels arrive in M2b)");
  if (const Value* source = member(msg, "locationSource"); source != nullptr && source->isString() && source->asString() != "external") {
    warnOnce("init.locationSource", "engine-native: init.locationSource " + json::quote(source->asString()) +
                                        " is not applied yet (location sources arrive in M3)");
  }

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
  } else {
    emitError(error_codes::kUnsupported,
              "world source kind " + json::quote(kind) +
                  " is not implemented by the maprama-native core yet (procedural worlds arrive in M2b; \"data\" and \"url\" render)",
              true);
  }
}

void MapSession::loadWorldValue(const Value& worldData, const Value& initMsg, const std::string& url) {
  Result<WorldLoadReport> loaded = world_.load(worldData);
  if (!loaded.ok()) {
    emitError(error_codes::kWorldLoadFailed, url.empty() ? loaded.error : "invalid WorldData from " + url + ": " + loaded.error,
              true);
    return;
  }
  onWorldLoaded(*loaded.value, initMsg);
}

void MapSession::onWorldLoaded(const WorldLoadReport& report, const Value& initMsg) {
  for (const std::string& warning : report.warnings) log(LogLevel::Warn, "engine-native: init world: " + warning);
  const WorldData& world = *world_.world();
  const Projection& projection = *world_.projection();
  log(LogLevel::Info, "engine-native: world loaded (" + std::to_string(report.roads) + " roads, " +
                          std::to_string(report.buildings) + " buildings, " + std::to_string(report.pois) + " pois)");

  // A new world starts without building overrides (engine-web keeps them only for the same world).
  rendered_ = renderedBuildings(world);
  renderedIndex_.clear();
  for (std::size_t i = 0; i < rendered_.size(); ++i) {
    renderedIndex_.emplace(world.buildings[rendered_[i].worldIndex].id, i);  // first id wins, like findBuilding
  }
  buildingStyles_.clear();
  sources_ = buildWorldSources(world, projection, rendered_);
  layers_ = buildWorldLayers(world, look_, buildingPaint());
  light_ = look_.light;
  styleDirty_ = true;
  worldReady_ = true;

  // engine-web `loadWorld`: target the world start (plaza, else bounds centre) with DEFAULT_ORBIT.
  WorldPoint start{(world.bounds.minX + world.bounds.maxX) / 2.0, (world.bounds.minZ + world.bounds.maxZ) / 2.0};
  if (world.plaza) start = *world.plaza;
  state_.center = projection.toLngLat(start);
  state_.distance = cm::kDefaultDistanceUnits * world.unitMeters;
  state_.pitch = cm::kDefaultPitch;
  state_.bearing = cm::kDefaultBearing;

  if (adapter_) {
    adapter_->setStyleJson(styleJson());
    pushLimits();
  }
  sendState();
  if (const Value* camera = member(initMsg, "camera")) setCamera(*camera);
  overlayDirty_ = true;
  lastPositions_.clear();
  cameraChanged();
}

void MapSession::setCamera(const Value& spec) {
  CameraState target = state_;
  const std::optional<LngLat> center = lngLatMember(spec, "center");
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

  double durationMs = 0.0;
  if (const Value* animate = member(spec, "animate")) {
    if (animate->isBoolean() && animate->asBool()) durationMs = cm::kDefaultAnimationMs;
    if (animate->isObject()) durationMs = numberMember(*animate, "durationMs").value_or(0.0);
  }
  if (const Value* follow = member(spec, "follow"); follow != nullptr && follow->isString()) {
    log(LogLevel::Warn, "engine-native: setCamera.follow " + json::quote(follow->asString()) +
                            " is not implemented yet (characters arrive in M3); the other camera fields were applied");
  }

  if (durationMs > 0 && canMoveCamera()) {
    // The adapter animates and reports every intermediate camera; the state follows those reports.
    adapter_->moveCamera(poseFor(target), durationMs);
    return;
  }
  if (sameState(target, state_) && !cameraUnsent_) return;
  state_ = target;
  sendState();
  cameraChanged();
}

void MapSession::setTheme(const Value& themeSpec) {
  setThemeState(themeSpec);
  applyLook();
}

void MapSession::setThemeState(const Value& themeSpec) {
  theme_ = themes_.resolve(themeSpec);
  look_ = mapLookFor(theme_);
  for (const std::string& option : unrenderedThemeOptions(theme_)) {
    warnOnce("theme:" + option, "engine-native: theme option " + option +
                                    " is accepted but not rendered yet (custom building layer, M2c)");
  }
}

void MapSession::setUi(const Value& uiSpec) {
  setUiState(uiSpec);
  pushUi();
}

void MapSession::setUiState(const Value& uiSpec) {
  // engine-web replaces the whole ui object (`this.ui = {...cmd.ui}`): absent fields are off.
  ui_ = MapUiSpec{};
  ui_.locationPuck = boolMember(uiSpec, "locationPuck");
  ui_.scaleBar = boolMember(uiSpec, "scaleBar");
  ui_.zoomButtons = boolMember(uiSpec, "zoomButtons");
  ui_.attribution = boolMember(uiSpec, "attribution");
  if (ui_.locationPuck.value_or(false)) {
    warnOnce("ui.locationPuck", "engine-native: ui.locationPuck is accepted but not drawn yet (the puck follows the player, M3)");
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
    for (const char* field : {"roof", "facade", "decorations", "massing", "replaceModel"}) {
      if (member(style, field) != nullptr) {
        warnOnce(std::string("setBuildingStyle.") + field,
                 std::string("engine-native: setBuildingStyle.") + field +
                     " is accepted but not rendered yet (custom building layer, M2c); color and state are applied");
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

void MapSession::request(const std::string& requestId, RequestMethod method, const Value& params) {
  if (!viewReady()) {
    respondError(requestId, kNotReadyCode, "the map view is not ready (no laid-out native view is attached)");
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

void MapSession::shutdown() {
  adapter_.reset();
  pendingRequests_.clear();
  pendingTaps_.clear();
  pendingWorld_.reset();
  subscriptions_.clear();
  anchors_.clear();
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

void MapSession::applyLook() {
  if (!worldReady_) return;
  Value next = buildWorldLayers(*world_.world(), look_, buildingPaint());
  const MapLight light = look_.light;
  if (adapter_) {
    std::vector<PaintPropertyChange> changes;
    if (!diffLayers(layers_, next, changes)) {
      layers_ = std::move(next);
      light_ = light;
      styleDirty_ = true;
      adapter_->setStyleJson(styleJson());
      return;
    }
    if (!changes.empty()) adapter_->setPaintProperties(changes);
    if (light != light_) adapter_->setLight(light);
  }
  layers_ = std::move(next);
  light_ = light;
  styleDirty_ = true;
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
  if (uiSentValid_ && s == uiSent_) return;
  uiSent_ = s;
  uiSentValid_ = true;
  adapter_->setUi(s);
}

// ---------------------------------------------------------------------------------------------------
// Camera helpers
// ---------------------------------------------------------------------------------------------------

MapCameraPose MapSession::poseFor(const CameraState& state) const {
  MapCameraPose pose;
  pose.center = state.center;
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
  overlayWanted_ = !anchors_.empty();
  pushUi();
  pump();
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
  pumpOverlay(now, &nextDelay);
  if (std::isfinite(nextDelay)) requestFrame(now, nextDelay);
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

double MapSession::distanceMin() const {
  const WorldData* w = world_.world();
  return cm::kDistanceMinUnits * (w != nullptr ? w->unitMeters : kDefaultUnitMeters);
}

double MapSession::distanceMax() const {
  const WorldData* w = world_.world();
  return cm::kDistanceMaxUnits * (w != nullptr ? w->unitMeters : kDefaultUnitMeters);
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
