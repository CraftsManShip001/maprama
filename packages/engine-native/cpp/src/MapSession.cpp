#include "maprama/MapSession.hpp"

#include <cmath>
#include <limits>
#include <utility>

#include "maprama/CameraMath.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/WorldStyle.hpp"
#include "maprama/protocol.hpp"

namespace maprama {

namespace {

using json::Value;
namespace cm = camera_math;

constexpr double kInf = std::numeric_limits<double>::infinity();

const Value* member(const Value& object, std::string_view key) { return object.isObject() ? object.find(key) : nullptr; }

std::optional<double> numberMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  return v != nullptr && v->isNumber() ? std::optional<double>(v->asNumber()) : std::nullopt;
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

}  // namespace

MapSession::MapSession(MessageSink& sink, WorldStore& world, ClockMs clock)
    : sink_(sink), world_(world), clock_(std::move(clock)), scheduledFrameAtMs_(kInf) {
  styleJson_ = buildEmptyStyle();
}

// ---------------------------------------------------------------------------------------------------
// Platform side
// ---------------------------------------------------------------------------------------------------

void MapSession::attachAdapter(std::shared_ptr<MapAdapter> adapter) {
  adapter_ = std::move(adapter);
  scheduledFrameAtMs_ = kInf;
  if (!adapter_) return;
  adapter_->setStyleJson(styleJson_);
  pushLimits();
  if (worldReady_ || cameraUnsent_) sendState();
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
  adapter_.reset();
  scheduledFrameAtMs_ = kInf;
}

void MapSession::setViewport(const Viewport& viewport) {
  const bool heightChanged = viewport.height != viewport_.height;
  viewport_ = viewport;
  if (!heightChanged) return;
  // The protocol distance is physical: keep it (and re-derive the MapLibre zoom) when the view resizes.
  pushLimits();
  if (worldReady_ || cameraUnsent_) sendState();
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

void MapSession::onUnprojected(std::uint64_t token, const std::optional<LngLat>& coordinate) {
  auto it = pendingRequests_.find(token);
  if (it == pendingRequests_.end()) return;
  const PendingRequest request = std::move(it->second);
  pendingRequests_.erase(it);
  const bool valid = coordinate && std::isfinite(coordinate->lng) && std::isfinite(coordinate->lat);
  respondOk(request.requestId, Value::object({{"coordinate", valid ? lngLatValue(*coordinate) : Value(nullptr)}}));
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

// ---------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------

void MapSession::init(const Value& msg) {
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
                  " is not implemented by the maprama-native core yet (M1 renders WorldData from \"data\" and \"url\")",
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

  styleJson_ = buildWorldStyle(world, projection);
  worldReady_ = true;

  // engine-web `loadWorld`: target the world start (plaza, else bounds centre) with DEFAULT_ORBIT.
  WorldPoint start{(world.bounds.minX + world.bounds.maxX) / 2.0, (world.bounds.minZ + world.bounds.maxZ) / 2.0};
  if (world.plaza) start = *world.plaza;
  state_.center = projection.toLngLat(start);
  state_.distance = cm::kDefaultDistanceUnits * world.unitMeters;
  state_.pitch = cm::kDefaultPitch;
  state_.bearing = cm::kDefaultBearing;

  if (adapter_) {
    adapter_->setStyleJson(styleJson_);
    pushLimits();
  }
  sendState();
  if (const Value* camera = member(initMsg, "camera")) setCamera(*camera);
  cameraChanged();

  log(LogLevel::Warn, "engine-native: init: theme, labels, ui and locationSource are not applied yet (M2/M3)");
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

void MapSession::subscribeCamera(double throttleMs) {
  subscriptions_.subscribe(SubscriptionTopic::CameraChange, std::nullopt, throttleMs);
  pump();
}

void MapSession::unsubscribeCamera() { subscriptions_.unsubscribe(SubscriptionTopic::CameraChange, std::nullopt); }

void MapSession::request(const std::string& requestId, RequestMethod method, const Value& params) {
  if (!adapter_ || viewport_.height <= 0 || viewport_.width <= 0) {
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
  pendingWorld_.reset();
  subscriptions_.clear();
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
  pump();
}

void MapSession::pump() {
  if (!worldReady_ || !subscriptions_.has(SubscriptionTopic::CameraChange)) return;
  const double now = clock_();
  double nextDelay = kInf;
  const auto due = subscriptions_.takeDue(SubscriptionTopic::CameraChange, now, &nextDelay);
  if (!due.empty() && events_ != nullptr) {
    events_->emit(Value::object({
        {"type", "camera:change"},
        {"camera", Value::object({{"center", lngLatValue(state_.center)},
                                  {"distance", state_.distance},
                                  {"pitch", state_.pitch},
                                  {"bearing", cm::normalizeBearing(state_.bearing)}})},
    }));
  }
  if (std::isfinite(nextDelay) && adapter_ && now + nextDelay < scheduledFrameAtMs_ - 0.5) {
    scheduledFrameAtMs_ = now + nextDelay;
    adapter_->scheduleFrame(nextDelay);
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

}  // namespace maprama
