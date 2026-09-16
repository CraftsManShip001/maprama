#include "maprama/GameSession.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <limits>
#include <random>
#include <utility>

#include "maprama/MapLook.hpp"
#include "maprama/ProceduralWorld.hpp"
#include "maprama/WorldStore.hpp"

namespace maprama {

namespace {

using json::Value;

constexpr double kInf = std::numeric_limits<double>::infinity();
constexpr double kPi = 3.14159265358979323846;
/// A frame arriving this much before the one this session asked for was requested by the map session.
constexpr double kFrameSlackMs = 2.0;
/// engine-web `RenderCore` clamps a frame's dt to 50 ms.
constexpr double kMaxDt = 0.05;
/// The `simulated` walker advances in wall-clock time between idle ticks (at most 1 s per tick).
constexpr double kMaxWalkerDt = 1.0;
/// Tick cost log interval.
constexpr double kStatsWindowMs = 5000.0;
/// engine-web `LocationPuck` accuracy disc: radius `max(1.4, accuracy · 2.2)` world units, 40 segments.
constexpr double kPuckAccuracyMin = 1.4;
constexpr double kPuckAccuracyScale = 2.2;
constexpr int kPuckSegments = 40;

const Value* member(const Value& object, std::string_view key) { return object.isObject() ? object.find(key) : nullptr; }

std::optional<double> numberMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  return v != nullptr && v->isNumber() ? std::optional<double>(v->asNumber()) : std::nullopt;
}

std::optional<std::string> stringMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  return v != nullptr && v->isString() ? std::optional<std::string>(v->asString()) : std::nullopt;
}

std::optional<LngLat> lngLatMember(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  if (v == nullptr || !v->isObject()) return std::nullopt;
  return LngLat{numberMember(*v, "lng").value_or(0.0), numberMember(*v, "lat").value_or(0.0)};
}

Value lngLatValue(const LngLat& ll) { return Value::object({{"lng", ll.lng}, {"lat", ll.lat}}); }

double realMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

std::function<double()> defaultRandom() {
  auto gen = std::make_shared<std::mt19937>(std::random_device{}());
  return [gen] { return static_cast<double>((*gen)() >> 8) / 16777216.0; };
}

LocationFix parseFix(const Value& v) {
  LocationFix fix;
  fix.lng = numberMember(v, "lng").value_or(0.0);
  fix.lat = numberMember(v, "lat").value_or(0.0);
  fix.accuracyMeters = numberMember(v, "accuracyMeters");
  fix.headingDeg = numberMember(v, "headingDeg");
  fix.speedMps = numberMember(v, "speedMps");
  fix.timestamp = numberMember(v, "timestamp").value_or(0.0);
  return fix;
}

std::vector<TravelMode> parseModes(const Value* v) {
  std::vector<TravelMode> modes;
  if (v == nullptr || !v->isArray()) return modes;
  for (const Value& m : v->items()) {
    if (!m.isString()) continue;
    if (const std::optional<TravelMode> mode = parseEnum<TravelMode>(m.asString())) modes.push_back(*mode);
  }
  return modes;
}

double wrapAngle(double a) { return std::atan2(std::sin(a), std::cos(a)); }

/// engine-web's `character:position` change key (`toFixed(3)` / `toFixed(1)` / `toFixed(2)`).
std::string positionKey(double x, double z, double heading, double speed) {
  char buf[160];
  std::snprintf(buf, sizeof buf, "%.3f|%.3f|%.1f|%.2f", x, z, heading, speed);
  return buf;
}

/// `CharacterSpec.model.uri` (absent / cleared: the procedural body).
std::optional<std::string> modelUriOf(const Value& spec) {
  const Value* model = member(spec, "model");
  if (model == nullptr || !model->isObject()) return std::nullopt;
  return stringMember(*model, "uri");
}

/// A model URI for logs (data: URIs are long).
std::string shortUri(const std::string& uri) { return uri.size() > 64 ? uri.substr(0, 64) + "..." : uri; }

bool isPlayerSpec(const Value& spec) {
  const Value* v = member(spec, "isPlayer");
  return v != nullptr && v->isBoolean() && v->asBool();
}

/// engine-web `mergeCharacterSpec`: absent fields keep their value, `null` removes the field (its default).
Value mergeSpec(const Value& current, const Value& patch) {
  Value merged = Value::object();
  for (const json::Member& m : current.members()) {
    const Value* p = patch.find(m.key);
    if (p != nullptr && p->isNull()) continue;
    merged.set(m.key, m.value);
  }
  for (const json::Member& m : patch.members()) {
    if (!m.value.isNull()) merged.set(m.key, m.value);
  }
  return merged;
}

std::string dropKey(const std::string& layerId, const std::string& dropId) {
  std::string key = layerId;
  key.push_back('\0');
  key += dropId;
  return key;
}

Value travelEventValue(const TravelEvent& e) {
  Value v = Value::object({{"type", std::string(travelEventTypeName(e.type))},
                           {"requestId", e.requestId},
                           {"characterId", e.characterId}});
  if (e.type == TravelEvent::Type::Start) {
    Value legs = Value::array();
    for (const TravelLeg& l : e.legs) legs.push(Value::object({{"mode", std::string(enumName(l.mode))}, {"meters", l.meters}}));
    v.set("legs", std::move(legs));
  } else if (e.type == TravelEvent::Type::Progress) {
    v.set("remainingMeters", e.remainingMeters);
    v.set("etaSeconds", e.etaSeconds);
    v.set("mode", std::string(enumName(e.mode)));
  }
  return v;
}

}  // namespace

struct GameSession::Character {
  /// engine-web `NormalizedCharacterSpec`: the merged spec without `null` fields (always has `id`).
  Value spec;
  Follower follower;
  /// Smoothed facing (engine-web `Character.yaw`, eased towards the follower's `targetYaw`).
  double yaw = kPi / 2;
  /// M3b: the 3D body (glTF or procedural) and vehicles; the model URI shown or loading (engine-web `modelUri`)
  /// and whether a load for it is pending (engine-web's `loadToken` check).
  CharacterModel visual;
  std::optional<std::string> modelUri;
  bool modelWaiting = false;

  const std::string& id() const { return spec.find("id")->asString(); }
  bool isPlayer() const { return isPlayerSpec(spec); }
  bool followsLocation() const {
    const Value* f = spec.find("follow");
    return f != nullptr && f->isString() && f->asString() == "location";
  }
  double scale() const {
    const Value* s = spec.find("scale");
    return s != nullptr && s->isNumber() && s->asNumber() > 0 ? s->asNumber() : 1.0;
  }
};

GameSession::GameSession(MessageSink& sink, WorldStore& world, MapSession& map, ClockMs clock, std::function<double()> random,
                         std::function<std::string()> collectId)
    : sink_(sink),
      world_(world),
      map_(map),
      clock_(std::move(clock)),
      groundY_(groundYFor(std::nullopt)),
      location_(random ? std::move(random) : defaultRandom()),
      collector_(collectId ? DropCollector::IdGenerator(std::move(collectId)) : DropCollector::IdGenerator(randomCollectId)),
      subscriptionWaitMs_(kInf),
      scheduledAtMs_(kInf),
      lastTickMs_(kInf) {}

GameSession::~GameSession() = default;

// ---------------------------------------------------------------------------------------------------
// Platform side
// ---------------------------------------------------------------------------------------------------

void GameSession::attachAdapter(std::shared_ptr<MapAdapter> adapter) {
  adapter_ = std::move(adapter);
  models_.attachAdapter(adapter_.get());
  scheduledAtMs_ = kInf;
  deviceRunning_ = false;
  if (!adapter_) return;
  dirty_ = kAll;
  if (location_.kind() == LocationSourceKind::Device) startDevice();
  wake();
}

void GameSession::detachAdapter() {
  if (deviceRunning_ && adapter_) adapter_->stopLocationUpdates();
  deviceRunning_ = false;
  models_.detachAdapter();
  adapter_.reset();
  scheduledAtMs_ = kInf;
}

void GameSession::frame() {
  if (!std::isfinite(scheduledAtMs_)) return;  // this session asked for no frame
  const double now = clock_();
  if (now < scheduledAtMs_ - kFrameSlackMs) return;  // the map session's frame; ours is still pending
  scheduledAtMs_ = kInf;
  tick(now);
  scheduleNext(now);
}

void GameSession::onDeviceLocation(const LocationFix& fix) {
  if (!worldReady_ || !proj_) return;
  if (const std::optional<ProcessedFix> processed = location_.onDevice(fix, *proj_)) onLocationFix(*processed);
}

void GameSession::onDeviceLocationError(const std::string& message) {
  if (location_.kind() != LocationSourceKind::Device) return;
  // engine-web `LocationService` reports geolocation failures this way (not fatal).
  emitError(kLocationUnavailableCode, "device geolocation failed: " + message);
}

void GameSession::onUserPan() {
  followId_.reset();
  followMoving_ = false;
}

// ---------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------

void GameSession::init(const Value& msg) {
  if (const std::optional<std::string> source = stringMember(msg, "locationSource")) {
    if (const std::optional<LocationSourceKind> kind = parseEnum<LocationSourceKind>(*source)) locationSource_ = *kind;
  }
}

void GameSession::upsertCharacters(const Value& characters) {
  std::vector<Value> specs;
  for (const Value& s : characters.items()) {
    if (stringMember(s, "id")) specs.push_back(s);
  }
  if (!worldReady_) {
    // engine-web keeps them (`{...pending, ...spec}`, `null` included) until a world loads.
    for (const Value& s : specs) {
      const std::string& id = s.find("id")->asString();
      auto it = std::find_if(pendingChars_.begin(), pendingChars_.end(),
                             [&](const Value& p) { return p.find("id")->asString() == id; });
      if (it == pendingChars_.end()) {
        pendingChars_.push_back(s);
      } else {
        for (const json::Member& m : s.members()) it->set(m.key, m.value);
      }
    }
    return;
  }
  applyUpsert(specs);
}

void GameSession::applyUpsert(const std::vector<Value>& specs) {
  // engine-web `CharacterManager.upsert`: validate the player count first (nothing is applied on failure).
  std::vector<std::string> players;
  for (const auto& ch : chars_) {
    if (ch->isPlayer()) players.push_back(ch->id());
  }
  for (const Value& s : specs) {
    const Value* p = s.find("isPlayer");
    if (p == nullptr) continue;
    const std::string& id = s.find("id")->asString();
    const auto it = std::find(players.begin(), players.end(), id);
    if (p->isBoolean() && p->asBool()) {
      if (it == players.end()) players.push_back(id);
    } else if (it != players.end()) {
      players.erase(it);
    }
  }
  if (players.size() > 1) {
    std::string list;
    for (const std::string& id : players) list += (list.empty() ? "" : ", ") + id;
    emitError(kInvalidCharacterCode, "upsertCharacters: at most one character can be the player (got " + list + ")");
    return;
  }

  const Projection& projection = *proj_;
  for (const Value& s : specs) {
    const std::string id = s.find("id")->asString();
    const std::optional<LngLat> position = lngLatMember(s, "position");
    Character* ch = find(id);
    if (ch == nullptr) {
      auto created = std::make_unique<Character>();
      created->spec = mergeSpec(Value::object({{"id", id}}), s);
      created->follower.groundY = groundY_;
      created->follower.body.y = groundY_;
      created->follower.body.targetYaw = kPi / 2;
      chars_.push_back(std::move(created));
      ch = chars_.back().get();
      const WorldPoint p = position ? projection.toWorld(*position) : spawnPoint(*ch);
      ch->follower.body.x = p.x;
      ch->follower.body.z = p.z;
    } else {
      ch->spec = mergeSpec(ch->spec, s);
      if (position) {
        ch->follower.setTrip({});
        const WorldPoint p = projection.toWorld(*position);
        ch->follower.body.x = p.x;
        ch->follower.body.z = p.z;
      }
    }
    // engine-web `CharacterManager.upsert`: `refreshClips()`, then `setModel(spec.model?.uri ?? null)`.
    ch->visual.setMapping(animationMapping(member(ch->spec, "animations")));
    setModel(*ch, modelUriOf(ch->spec));
  }
  // engine-web `Features.upsertCharacters`.
  for (const Value& s : specs) {
    const std::string& id = s.find("id")->asString();
    if (member(s, "position") != nullptr) lastPosition_.erase(id);
    const Value* follow = member(s, "follow");
    const bool stop = follow != nullptr && (follow->isNull() || (follow->isString() && follow->asString() == "none"));
    if (stop && !trips_.isTraveling(id)) {
      if (Character* ch = find(id)) ch->follower.setTrip({});
    }
  }
  if (const std::optional<ProcessedFix>& last = location_.last()) {
    for (const Value& s : specs) {
      if (stringMember(s, "follow") != std::optional<std::string>("location")) continue;
      if (Character* ch = find(s.find("id")->asString())) driveToFix(*ch, WorldPoint{last->fix.x, last->fix.z});
    }
  }
  dirty_ |= kModels | kPuck;
  wake();
}

WorldPoint GameSession::spawnPoint(const Character& ch) const {
  // engine-web `CharacterManager.spawnPoint`: the plaza (else the world origin) of a data world, the start of a
  // procedural one; NPCs of a crowd scatter 30 units around it by their id hash; snapped to a road.
  const WorldPoint base = spawnBase_;
  WorldPoint p = base;
  if (!ch.isPlayer() && chars_.size() > 1) {
    const std::uint32_t h = hashId(ch.id());
    p = WorldPoint{base.x + (static_cast<double>(h % 1000u) / 1000.0 - 0.5) * 30.0,
                   base.z + (static_cast<double>((h >> 10) % 1000u) / 1000.0 - 0.5) * 30.0};
  }
  if (const std::optional<GraphSnap> s = snapToGraph(plan_.graph, p.x, p.z)) return WorldPoint{s->x, s->z};
  return p;
}

void GameSession::removeCharacters(const Value& ids) {
  std::vector<std::string> list;
  for (const Value& v : ids.items()) {
    if (v.isString()) list.push_back(v.asString());
  }
  const auto listed = [&](const std::string& id) { return std::find(list.begin(), list.end(), id) != list.end(); };
  pendingChars_.erase(std::remove_if(pendingChars_.begin(), pendingChars_.end(),
                                     [&](const Value& p) { return listed(p.find("id")->asString()); }),
                      pendingChars_.end());
  std::vector<TravelEvent> events;
  for (const std::string& id : list) {
    Character* ch = find(id);
    if (ch == nullptr) continue;
    trips_.cancel(id, ch->follower, events);
    if (followId_ == id) followId_.reset();
    subscriptions_.resetKey(SubscriptionTopic::CharacterPosition, id);
    subscriptions_.resetKey(SubscriptionTopic::TravelProgress, id);
    lastPosition_.erase(id);
  }
  processTravelEvents(events);
  chars_.erase(std::remove_if(chars_.begin(), chars_.end(), [&](const std::unique_ptr<Character>& c) { return listed(c->id()); }),
               chars_.end());
  dirty_ |= kModels | kPuck;
  wake();
}

void GameSession::setLocationSource(const std::string& source) {
  const std::optional<LocationSourceKind> kind = parseEnum<LocationSourceKind>(source);
  if (!kind) return;
  locationSource_ = *kind;
  applyLocationKind(*kind);
  wake();
}

void GameSession::applyLocationKind(LocationSourceKind kind) {
  if (location_.setKind(kind)) dirty_ |= kPuck;
  if (kind == LocationSourceKind::Device) {
    if (!deviceRunning_) startDevice();
  } else if (deviceRunning_) {
    stopDevice();
  }
}

void GameSession::startDevice() {
  if (!adapter_) return;  // started when an adapter attaches
  deviceRunning_ = true;
  adapter_->startLocationUpdates();
}

void GameSession::stopDevice() {
  if (adapter_) adapter_->stopLocationUpdates();
  deviceRunning_ = false;
}

void GameSession::pushLocation(const Value& fix) {
  if (!worldReady_ || !proj_) return;
  if (const std::optional<ProcessedFix> processed = location_.push(parseFix(fix), *proj_)) onLocationFix(*processed);
}

void GameSession::onLocationFix(const ProcessedFix& fix) {
  for (const auto& ch : chars_) {
    if (ch->followsLocation()) driveToFix(*ch, WorldPoint{fix.fix.x, fix.fix.z});
  }
  dirty_ |= kPuck;
  wake();
}

void GameSession::driveToFix(Character& ch, const WorldPoint& estimate) {
  if (!worldReady_ || trips_.isTraveling(ch.id())) return;
  const FollowerBody& b = ch.follower.body;
  applyLocationDrive(ch.follower, planLocationDrive(plan_.graph, WorldPoint{b.x, b.z}, estimate));
  dirty_ |= kModels | kPuck;
}

void GameSession::travel(const Value& msg) {
  if (!worldReady_) {
    emitError(kNotReadyCode, "travel: no world loaded (send init first)");
    return;
  }
  const std::string requestId = stringMember(msg, "requestId").value_or(std::string());
  const std::string characterId = stringMember(msg, "characterId").value_or(std::string());
  Character* ch = find(characterId);
  if (ch == nullptr) {
    emitError(kUnknownCharacterCode, "travel: unknown character \"" + characterId + "\"");
    return;
  }
  const LngLat to = lngLatMember(msg, "to").value_or(LngLat{});
  const double timeScale = numberMember(msg, "timeScale").value_or(1.0);
  std::vector<TravelEvent> events;
  std::vector<PlannedLeg> legs = trips_.start(plan_, *proj_, requestId, characterId, ch->follower, proj_->toWorld(to),
                                              parseModes(member(msg, "modes")), timeScale, events);
  processTravelEvents(events);
  if (ch->isPlayer() && trips_.isTraveling(characterId)) {
    routes_[characterId] = std::move(legs);
    dirty_ |= kRoute;
  }
  dirty_ |= kModels;
  wake();
}

void GameSession::cancelTravel(const std::string& characterId) {
  Character* ch = find(characterId);
  if (ch == nullptr) {
    emitError(kUnknownCharacterCode, "cancelTravel: unknown character \"" + characterId + "\"");
    return;
  }
  std::vector<TravelEvent> events;
  trips_.cancel(characterId, ch->follower, events);
  processTravelEvents(events);
  dirty_ |= kModels;
  wake();
}

void GameSession::setDropLayer(const Value& msg) {
  DropLayer layer;
  layer.layerId = stringMember(msg, "layerId").value_or(std::string());
  layer.collectRadiusMeters = numberMember(msg, "collectRadiusMeters").value_or(0.0);
  if (const Value* ids = member(msg, "collectorIds"); ids != nullptr && ids->isArray()) {
    std::vector<std::string> collectors;
    for (const Value& id : ids->items()) {
      if (id.isString()) collectors.push_back(id.asString());
    }
    layer.collectorIds = std::move(collectors);
  }
  if (const Value* drops = member(msg, "drops"); drops != nullptr && drops->isArray()) {
    for (const Value& d : drops->items()) {
      DropSpec spec;
      spec.id = stringMember(d, "id").value_or(std::string());
      spec.type = parseEnum<DropType>(stringMember(d, "type").value_or("coin")).value_or(DropType::Coin);
      if (const Value* model = member(d, "model"); model != nullptr && model->isObject()) {
        spec.model = ModelSource{stringMember(*model, "uri").value_or(std::string())};
      }
      spec.coordinate = lngLatMember(d, "coordinate").value_or(LngLat{});
      if (const std::optional<std::string> rarity = stringMember(d, "rarity")) spec.rarity = parseEnum<Rarity>(*rarity);
      spec.value = numberMember(d, "value");
      if (const Value* payload = member(d, "payload")) spec.payload = *payload;
      layer.drops.push_back(std::move(spec));
    }
  }
  // engine-web keeps the command in a Map (a replaced layer keeps its position) and applies it once a world exists.
  auto it = std::find_if(dropLayers_.begin(), dropLayers_.end(), [&](const auto& e) { return e.first == layer.layerId; });
  if (it == dropLayers_.end()) {
    dropLayers_.emplace_back(layer.layerId, layer);
  } else {
    it->second = layer;
  }
  if (worldReady_) applyDropLayer(layer);
}

void GameSession::applyDropLayer(const DropLayer& layer) {
  const LayerDiff diff = collector_.setLayer(layer, *proj_);
  for (const DropState& d : diff.removed) dropVisuals_.erase(dropKey(d.layerId, d.spec.id));
  for (const DropState& d : diff.added) dropVisuals_[dropKey(d.layerId, d.spec.id)] = makeDropVisual(d);
  for (const DropState& d : diff.moved) {
    auto it = dropVisuals_.find(dropKey(d.layerId, d.spec.id));
    if (it != dropVisuals_.end()) it->second.position = d.spec.coordinate;
  }
  dirty_ |= kModels;
  wake();
}

void GameSession::removeDropLayer(const std::string& layerId) {
  dropLayers_.erase(std::remove_if(dropLayers_.begin(), dropLayers_.end(), [&](const auto& e) { return e.first == layerId; }),
                    dropLayers_.end());
  for (const DropState& d : collector_.removeLayer(layerId)) dropVisuals_.erase(dropKey(d.layerId, d.spec.id));
  dirty_ |= kModels;
  wake();
}

void GameSession::setGeofences(const Value& geofences) {
  geofenceSpecs_.clear();
  for (const Value& g : geofences.items()) {
    GeofenceSpec spec;
    spec.id = stringMember(g, "id").value_or(std::string());
    spec.center = lngLatMember(g, "center").value_or(LngLat{});
    spec.radiusMeters = numberMember(g, "radiusMeters").value_or(0.0);
    geofenceSpecs_.push_back(std::move(spec));
  }
  if (worldReady_) applyGeofences();
}

void GameSession::applyGeofences() {
  fences_.set(worldFences(geofenceSpecs_, *proj_));
  dirty_ |= kFences;
  wake();
}

void GameSession::subscribe(SubscriptionTopic topic, std::optional<std::string> id, double throttleMs) {
  subscriptions_.subscribe(topic, std::move(id), throttleMs);
  if (topic == SubscriptionTopic::CharacterPosition) lastPosition_.clear();
  wake();
}

void GameSession::unsubscribe(SubscriptionTopic topic, const std::optional<std::string>& id) {
  subscriptions_.unsubscribe(topic, id);
}

void GameSession::request(const std::string& requestId, RequestMethod method, const Value& params) {
  // engine-web: `requireWorld` / the `route` handler (no command prefix in request errors).
  if (!worldReady_ || !proj_) {
    respondError(requestId, kNotReadyCode, "no world loaded (send init first)");
    return;
  }
  if (method == RequestMethod::Route) {
    const RouteResult r = routeResult(plan_, *proj_, lngLatMember(params, "from").value_or(LngLat{}),
                                      lngLatMember(params, "to").value_or(LngLat{}), parseModes(member(params, "modes")));
    Value legs = Value::array();
    for (const RouteLeg& l : r.legs) {
      Value path = Value::array();
      for (const LngLat& p : l.path) path.push(lngLatValue(p));
      legs.push(Value::object({{"mode", std::string(enumName(l.mode))}, {"meters", l.meters}, {"path", std::move(path)}}));
    }
    respondOk(requestId, Value::object({{"legs", std::move(legs)}, {"meters", r.meters}, {"etaSeconds", r.etaSeconds}}));
    return;
  }
  if (method == RequestMethod::SnapToRoad) {
    const std::optional<SnapToRoadResult> s = snapToRoad(plan_, *proj_, lngLatMember(params, "coordinate").value_or(LngLat{}),
                                                         numberMember(params, "maxDistanceMeters"));
    respondOk(requestId, s ? Value::object({{"coordinate", lngLatValue(s->coordinate)},
                                            {"roadId", s->roadId},
                                            {"distanceMeters", s->distanceMeters}})
                           : Value(nullptr));
    return;
  }
  respondError(requestId, error_codes::kUnsupported, "request method is not handled by the game session");
}

void GameSession::themeChanged() {
  dirty_ |= kModels;
  wake();
}

void GameSession::uiChanged() {
  dirty_ |= kPuck;
  wake();
}

void GameSession::shutdown() {
  if (deviceRunning_ && adapter_) adapter_->stopLocationUpdates();
  deviceRunning_ = false;
  models_.detachAdapter();
  adapter_.reset();
  subscriptions_.clear();
  scheduledAtMs_ = kInf;
}

// ---------------------------------------------------------------------------------------------------
// MapSessionHooks
// ---------------------------------------------------------------------------------------------------

void GameSession::extendSources(Value& sources) {
  const Value game = gameSources();
  for (const json::Member& m : game.members()) sources.set(m.key, m.value);
}

void GameSession::extendLayers(Value& layers, const MapLook& /*look*/) {
  const WorldData* w = world_.world();
  if (w != nullptr) insertGameLayers(layers, w->origin.lat, w->unitMeters);
}

void GameSession::styleSent() {
  // The new style carries empty game sources: re-send every one (at the next frame).
  dirty_ = kAll;
  wake();
}

void GameSession::worldLoaded(const Value& /*initMsg*/, const ProceduralWorld* procedural) {
  // engine-web `Features.worldLoaded`, with the per-kind world model of engine-web `loadWorld`: a procedural
  // world plans on the generator's road graph and stations, spawns at its start, loops the simulated walker
  // through its `loopWays` and stands characters at `groundYFor(layout)`.
  const WorldData& w = *world_.world();
  const Projection& next = *world_.projection();
  std::vector<TravelEvent> events;
  trips_.cancelAll([this](std::string_view id) { return followerOf(id); }, events);
  processTravelEvents(events);
  const double ground = groundYFor(procedural != nullptr ? std::optional<ProceduralLayout>(procedural->layout) : std::nullopt);
  if (proj_) {
    // Characters keep their geographic position (engine-web `CharacterManager.rebase`).
    for (const auto& ch : chars_) {
      FollowerBody& b = ch->follower.body;
      const WorldPoint p = next.toWorld(proj_->toLngLat(WorldPoint{b.x, b.z}));
      ch->follower.setTrip({});
      ch->follower.groundY = ground;
      b.x = p.x;
      b.z = p.z;
      b.y = ground;
    }
  }
  proj_ = next;
  plan_ = procedural != nullptr ? planWorldFromProcedural(*procedural) : planWorldFromData(w);
  spawnBase_ = procedural != nullptr ? procedural->start : (w.plaza ? *w.plaza : WorldPoint{0, 0});
  groundY_ = ground;
  worldReady_ = true;
  if (!pendingChars_.empty()) {
    std::vector<Value> pending = std::move(pendingChars_);
    pendingChars_.clear();
    applyUpsert(pending);
  }
  location_.worldChanged(procedural != nullptr ? buildDemoLoop(plan_.graph, procedural->loopWays, procedural->start)
                                               : buildDemoLoop(plan_.graph, {}, dataWorldStart(w)));
  applyLocationKind(locationSource_);
  for (const std::string& id : collector_.layerIds()) {
    for (const DropState& d : collector_.removeLayer(id)) dropVisuals_.erase(dropKey(d.layerId, d.spec.id));
  }
  for (const auto& entry : dropLayers_) applyDropLayer(entry.second);
  applyGeofences();
  lastPosition_.clear();
  dirty_ = kAll;
  flushVisuals(clock_());
  wake();
}

bool GameSession::setFollow(const std::optional<std::string>& characterId) {
  if (!characterId) {
    followId_.reset();
    followMoving_ = false;
    return true;
  }
  if (find(*characterId) == nullptr) return false;
  followId_ = *characterId;
  followMoving_ = true;
  wake();
  return true;
}

// ---------------------------------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------------------------------

void GameSession::tick(double nowMs) {
  const double elapsed = std::isfinite(lastTickMs_) ? std::max(0.0, (nowMs - lastTickMs_) / 1000.0) : 0.0;
  lastTickMs_ = nowMs;
  if (!worldReady_ || !proj_) return;
  const double started = realMs();
  const double dt = std::min(kMaxDt, elapsed);

  // engine-web `Features.frame` order: location source, characters (+ arrivals), drops, geofences.
  if (const std::optional<ProcessedFix> fix = location_.step(std::min(kMaxWalkerDt, elapsed), nowMs / 1000.0)) {
    onLocationFix(*fix);
  }
  std::vector<TravelEvent> events;
  for (const auto& ch : chars_) {
    Follower& f = ch->follower;
    const FollowerBody before = f.body;
    const double yawBefore = ch->yaw;
    if (f.stepCharacter(dt)) trips_.arrived(ch->id(), events);
    ch->yaw += wrapAngle(f.body.targetYaw - ch->yaw) * std::min(1.0, dt * 10.0);
    ch->visual.step(dt, nowMs / 1000.0, f.body, proj_->unitMeters(), ch->scale());
    if (before.x != f.body.x || before.z != f.body.z || before.mode != f.body.mode || std::fabs(yawBefore - ch->yaw) > 1e-6) {
      dirty_ |= kModels | kPuck;
    }
  }
  processTravelEvents(events);

  std::vector<CharacterPosition> positions;
  positions.reserve(chars_.size());
  for (const auto& ch : chars_) {
    positions.push_back(CharacterPosition{ch->id(), ch->follower.body.x, ch->follower.body.z, ch->isPlayer()});
  }
  DropCheckResult result = collector_.check(positions, *proj_);
  if (result.error) emitError(error_codes::kInternal, "drop:collect: " + *result.error);
  for (const DropCollection& c : result.collected) {
    const std::string key = dropKey(c.layerId, c.dropId);
    const auto visual = dropVisuals_.find(key);
    if (visual != dropVisuals_.end() && !visual->second.popMs) visual->second.popMs = nowMs;
    dirty_ |= kModels;
    emit(Value::object({{"type", "drop:collect"},
                        {"layerId", c.layerId},
                        {"dropId", c.dropId},
                        {"characterId", c.characterId},
                        {"coordinate", lngLatValue(c.coordinate)},
                        {"collectId", c.collectId}}));
  }
  for (const GeofenceTransition& t : fences_.update(positions)) {
    emit(Value::object({{"type", t.enter ? "geofence:enter" : "geofence:exit"},
                        {"geofenceId", t.geofenceId},
                        {"characterId", t.characterId}}));
  }
  // engine-web `DropVisuals.step`: a collected item is removed once its pop has played.
  for (auto it = dropVisuals_.begin(); it != dropVisuals_.end();) {
    if (it->second.popMs && nowMs - *it->second.popMs >= kDropPopSeconds * 1000.0) {
      it = dropVisuals_.erase(it);
      dirty_ |= kModels;
    } else {
      ++it;
    }
  }

  stepFollow(dt);
  emitPositions(nowMs);
  emitProgress(nowMs);
  flushVisuals(nowMs);
  recordTick(realMs() - started);
}

void GameSession::stepFollow(double dt) {
  followMoving_ = false;
  if (!followId_) return;
  Character* ch = find(*followId_);
  if (ch == nullptr) {
    followId_.reset();
    return;
  }
  // engine-web `Features.followPoint` + `CameraController.update`: the ground point on the view ray through the
  // character (airborne on plane legs), approached with `1 - exp(-5 dt)` per frame.
  const FollowerBody& b = ch->follower.body;
  const CameraState& cam = map_.cameraState();
  WorldPoint target{b.x, b.z};
  const double alt = std::max(0.0, b.y - groundY_);
  if (alt >= 0.01) {
    const double pitch = cam.pitch * kPi / 180.0, bearing = cam.bearing * kPi / 180.0;
    const double d = alt * std::tan(pitch);
    target = WorldPoint{b.x + std::sin(bearing) * d, b.z - std::cos(bearing) * d};
  }
  const WorldPoint current = proj_->toWorld(cam.center);
  if (std::fabs(target.x - current.x) <= 1e-5 && std::fabs(target.z - current.z) <= 1e-5) return;
  followMoving_ = true;
  const double k = 1.0 - std::exp(-dt * 5.0);
  const WorldPoint next{current.x + (target.x - current.x) * k, current.z + (target.z - current.z) * k};
  if (std::fabs(next.x - current.x) > 1e-5 || std::fabs(next.z - current.z) > 1e-5) map_.followCenter(proj_->toLngLat(next));
}

void GameSession::emitPositions(double nowMs) {
  subscriptionWaitMs_ = kInf;
  if (!subscriptions_.has(SubscriptionTopic::CharacterPosition)) return;
  for (const auto& ch : chars_) {
    const std::string& id = ch->id();
    if (!subscriptions_.wants(SubscriptionTopic::CharacterPosition, id)) continue;
    const FollowerBody& b = ch->follower.body;
    const double heading = headingFromYaw(ch->yaw);
    const double speed = b.speed * proj_->unitMeters();
    std::string key = positionKey(b.x, b.z, heading, speed);
    const auto last = lastPosition_.find(id);
    if (last != lastPosition_.end() && last->second == key) continue;
    double wait = kInf;
    if (!subscriptions_.due(SubscriptionTopic::CharacterPosition, id, nowMs, &wait)) {
      subscriptionWaitMs_ = std::min(subscriptionWaitMs_, wait);
      continue;
    }
    lastPosition_[id] = std::move(key);
    emit(Value::object({{"type", "character:position"},
                        {"id", id},
                        {"coordinate", lngLatValue(proj_->toLngLat(WorldPoint{b.x, b.z}))},
                        {"headingDeg", heading},
                        {"speedMps", speed}}));
  }
}

void GameSession::emitProgress(double nowMs) {
  if (!subscriptions_.has(SubscriptionTopic::TravelProgress) || trips_.size() == 0) return;
  std::vector<TravelEvent> all;
  trips_.progress(*proj_, [this](std::string_view id) { return followerOf(id); }, all);
  for (const TravelEvent& e : all) {
    if (!subscriptions_.wants(SubscriptionTopic::TravelProgress, e.characterId)) continue;
    if (!subscriptions_.due(SubscriptionTopic::TravelProgress, e.characterId, nowMs)) continue;
    emit(travelEventValue(e));
  }
}

void GameSession::flushVisuals(double nowMs) {
  if (!adapter_ || !worldReady_ || !proj_) return;
  sendNameTags();
  // M3b: models animate, so their frame is re-sent every tick while any is on screen (and once more to clear).
  const bool models = !chars_.empty() || !dropVisuals_.empty() || modelsShown_;
  if (dirty_ == 0 && !models) return;
  const unsigned d = dirty_;
  dirty_ = 0;
  const Projection& projection = *proj_;
  const auto send = [&](const char* source, std::string data) {
    ++stats_.sourceUpdates;
    ++statsWindow_.sourceUpdates;
    stats_.sourceBytes += data.size();
    statsWindow_.sourceBytes += data.size();
    adapter_->setSourceData(source, std::move(data));
  };
  if ((d & kFences) != 0) send(game_style::kSourceFences, fencesGeoJson(fences_.list(), projection));
  if ((d & kRoute) != 0) {
    std::vector<std::vector<PlannedLeg>> routes;
    for (const auto& entry : routes_) routes.push_back(entry.second);
    send(game_style::kSourceRoute, routeGeoJson(routes, projection));
  }
  if ((d & kPuck) != 0) {
    // engine-web: the puck sits under the player while `ui.locationPuck` is on; the accuracy disc shows the last
    // smoothed fix's accuracy while the player follows the location source.
    std::optional<PuckVisual> puck;
    const Character* player = nullptr;
    for (const auto& ch : chars_) {
      if (ch->isPlayer()) {
        player = ch.get();
        break;
      }
    }
    if (player != nullptr && map_.uiSpec().locationPuck.value_or(false)) {
      const FollowerBody& b = player->follower.body;
      PuckVisual p;
      p.position = projection.toLngLat(WorldPoint{b.x, b.z});
      if (player->followsLocation() && location_.last()) {
        const double r = std::max(kPuckAccuracyMin, location_.last()->fix.accuracy * kPuckAccuracyScale);
        std::vector<LngLat> ring;
        for (const Vec2& v : circleRing(b.x, b.z, r, kPuckSegments)) ring.push_back(projection.toLngLat(WorldPoint{v[0], v[1]}));
        p.accuracy = std::move(ring);
      }
      puck = std::move(p);
    }
    send(game_style::kSourcePuck, puckGeoJson(puck));
  }
  if (models) sendModelFrame(nowMs);
}

void GameSession::sendNameTags() {
  // engine-web `CharacterManager.updateTags`: a tag per `showNameTag` character, anchored by `nameTagAnchor` (on the
  // vehicle while riding once it has popped in); the map session projects and hides them with the labels.
  std::vector<NameTag> tags;
  for (const auto& ch : chars_) {
    const Value* show = member(ch->spec, "showNameTag");
    if (show == nullptr || !show->isBoolean() || !show->asBool()) continue;
    const FollowerBody& body = ch->follower.body;
    double vehicle = 0.0;
    if (const int k = vehicleIndex(body.mode); k >= 0) {
      const VehicleState& v = ch->visual.vehicles().vehicles[static_cast<std::size_t>(k)];
      if (v.visible) vehicle = v.p;
    }
    const NameTagOffset a = nameTagAnchor(body.mode, ch->yaw, ch->scale(), vehicle);
    NameTag tag;
    tag.characterId = ch->id();
    tag.text = stringMember(ch->spec, "name").value_or(ch->id());
    tag.player = ch->isPlayer();
    if (tag.player) {
      if (const std::optional<std::string> css = stringMember(ch->spec, "color")) tag.color = parseCssHex(*css).value_or(kPlayerTagColor);
    }
    tag.anchor = proj_->toLngLat(WorldPoint{body.x + a.dx, body.z + a.dz});
    tag.anchorY = body.y + a.dy;
    tag.root = WorldPoint{body.x, body.z};
    tag.rootY = body.y;
    tags.push_back(std::move(tag));
  }
  if (tags.empty() && !tagsShown_) return;
  tagsShown_ = !tags.empty();
  map_.setNameTags(std::move(tags));
}

void GameSession::sendModelFrame(double nowMs) {
  const WorldData* w = world_.world();
  if (w == nullptr || !adapter_ || !proj_) return;
  const Projection& projection = *proj_;
  ModelFrameBuilder builder(projection, w->origin, projection.unitMeters());
  // M4: beyond the zoom-out band (keepGameView / mapColors) characters and drops are icon discs.
  const bool sprites = map_.zoomOut().sprites();
  for (const auto& ch : chars_) {
    const FollowerBody& body = ch->follower.body;
    if (sprites) {
      drawCharacterIcon(builder, body, baseColor(*ch), ch->isPlayer(), ch->scale());
    } else {
      ch->visual.draw(builder, body, ch->yaw, ch->scale(), baseColor(*ch), ch->isPlayer());
    }
    ModelVisual v;
    v.kind = ModelVisual::Kind::Character;
    v.id = ch->id();
    v.position = projection.toLngLat(WorldPoint{body.x, body.z});
    v.altitude = body.y - groundY_;
    v.color = bodyColor(*ch);
    v.scale = ch->scale();
    v.isPlayer = ch->isPlayer();
    v.mode = body.mode;
    v.gltf = ch->visual.hasModel();
    v.animation = ch->visual.animation();
    v.headingDeg = headingFromYaw(ch->yaw);
    builder.visual(std::move(v));
  }
  for (const auto& entry : dropVisuals_) {
    const DropVisual& d = entry.second;
    if (sprites) {
      drawDropIcon(builder, d, projection.toWorld(d.position), groundY_, nowMs);
    } else {
      drawDrop(builder, d, projection.toWorld(d.position), groundY_, nowMs);
    }
    ModelVisual v;
    v.kind = ModelVisual::Kind::Drop;
    v.id = d.dropId;
    v.layerId = d.layerId;
    v.position = d.position;
    v.color = game_style::kRarityColors[static_cast<std::size_t>(d.rarity)];
    v.type = d.type;
    v.rarity = d.rarity;
    v.pop = dropPopProgress(d, nowMs);
    v.gltf = d.model != nullptr;
    builder.visual(std::move(v));
  }
  std::shared_ptr<ModelLayerFrame> frame = builder.finish(buildingLayerLight(map_.look().light), map_.look().tint, ++modelFrameVersion_);
  frame->sprites = sprites;
  modelsShown_ = !frame->visuals.empty();
  ++stats_.modelFrames;
  ++statsWindow_.modelFrames;
  stats_.modelDraws += frame->draws.size();
  statsWindow_.modelDraws += frame->draws.size();
  lastModelFrame_ = frame;
  adapter_->setModelLayer(std::move(frame));
}

bool GameSession::moving() const {
  if (followMoving_) return true;
  // M3b: models in view animate every frame (idle clips and breathing, drop bob / spin, beams), like engine-web's
  // render loop. M4: models out of view and icon discs (zoom-out beyond D2) have no visible idle motion.
  if (!map_.zoomOut().sprites() && modelsInView()) return true;
  const double now = clock_();
  for (const auto& entry : dropVisuals_) {
    const DropVisual& d = entry.second;
    if (d.popMs || now - d.addedMs < kDropAppearSeconds * 1000.0) return true;  // appearing / popping
  }
  for (const auto& ch : chars_) {
    const Follower& f = ch->follower;
    if (f.active() || f.wait > 0 || f.body.speed > 0 || std::fabs(f.body.y - f.groundY) > 0.001 ||
        std::fabs(wrapAngle(f.body.targetYaw - ch->yaw)) > 1e-3) {
      return true;
    }
  }
  return false;
}

namespace {

/// A conservative view test with engine-web's orbit camera (40° vertical field of view, widened by 25 %): the native
/// camera frames the same ground as engine-web for the same `CameraState` (CameraMath.hpp). World units, y up.
struct ViewTest {
  double ex = 0, ey = 0, ez = 0;  // eye
  double fx = 0, fy = -1, fz = 0;  // forward
  double rx = 1, rz = 0;           // right (horizontal)
  double ux = 0, uy = 0, uz = -1;  // up
  double tanV = 0, tanH = 0;

  ViewTest(const Projection& proj, const CameraState& cam, const Viewport& vp) {
    const WorldPoint t = proj.toWorld(cam.center);
    const double d = std::max(1e-6, cam.distance / proj.unitMeters());
    const double p = cam.pitch * kPi / 180.0, b = cam.bearing * kPi / 180.0;
    // Look direction on the ground (bearing clockwise from north, north = −z); the eye sits behind and above.
    const double hx = std::sin(b), hz = -std::cos(b);
    ex = t.x - hx * d * std::sin(p);
    ey = d * std::cos(p);
    ez = t.z - hz * d * std::sin(p);
    fx = (t.x - ex) / d;
    fy = -ey / d;
    fz = (t.z - ez) / d;
    rx = std::cos(b);
    rz = std::sin(b);
    ux = -rz * fy;
    uy = rz * fx - rx * fz;
    uz = rx * fy;
    tanV = std::tan(20.0 * 1.25 * kPi / 180.0);
    tanH = tanV * (vp.height > 0 ? vp.width / vp.height : 1.0);
  }

  bool contains(double x, double y, double z, double margin) const {
    const double vx = x - ex, vy = y - ey, vz = z - ez;
    const double depth = vx * fx + vy * fy + vz * fz;
    if (depth <= -margin) return false;
    const double sx = vx * rx + vz * rz;
    const double sy = vx * ux + vy * uy + vz * uz;
    const double k = std::max(0.0, depth);
    return std::fabs(sx) <= k * tanH + margin && std::fabs(sy) <= k * tanV + margin;
  }
};

/// Models are a few world units tall (vehicles, beams): count them as in view within this margin.
constexpr double kViewMarginUnits = 4.0;

}  // namespace

bool GameSession::modelsInView() const {
  if (chars_.empty() && dropVisuals_.empty()) return false;
  const Viewport& vp = map_.viewport();
  if (!proj_ || vp.width <= 0 || vp.height <= 0) return true;  // no laid-out view yet: assume visible
  const ViewTest view(*proj_, map_.cameraState(), vp);
  for (const auto& ch : chars_) {
    const FollowerBody& b = ch->follower.body;
    if (view.contains(b.x, b.y - groundY_, b.z, kViewMarginUnits)) return true;
  }
  for (const auto& entry : dropVisuals_) {
    const WorldPoint at = proj_->toWorld(entry.second.position);
    if (view.contains(at.x, 1.0, at.z, kViewMarginUnits)) return true;
  }
  return false;
}

void GameSession::zoomOutChanged() {
  // Models <-> icon discs: one new model frame (the next ticks follow the usual schedule).
  dirty_ |= kModels;
  wake();
}

void GameSession::cameraMoved() {
  // Idle models that are not animating (out of view) may have come into view. Icon discs do not depend on the camera.
  if (!worldReady_ || frameScheduled() || map_.zoomOut().sprites()) return;
  if (chars_.empty() && dropVisuals_.empty()) return;
  wake();
}

void GameSession::scheduleNext(double nowMs) {
  if (!adapter_) return;
  double delay = kInf;
  if (dirty_ != 0 || moving()) {
    delay = kGameFrameMs;
  } else if (worldReady_ && location_.kind() == LocationSourceKind::Simulated) {
    delay = kGameIdleWalkerMs;
  }
  delay = std::min(delay, subscriptionWaitMs_);
  if (std::isfinite(delay)) requestFrame(nowMs, delay);
}

void GameSession::wake() {
  if (adapter_) requestFrame(clock_(), 0.0);
}

void GameSession::requestFrame(double nowMs, double delayMs) {
  if (!adapter_) return;
  if (nowMs + delayMs < scheduledAtMs_ - 0.5) {
    scheduledAtMs_ = nowMs + delayMs;
    adapter_->scheduleFrame(delayMs);
  }
}

bool GameSession::frameScheduled() const { return std::isfinite(scheduledAtMs_); }

// ---------------------------------------------------------------------------------------------------
// M3b models
// ---------------------------------------------------------------------------------------------------

void GameSession::setModelLoading(ModelLibrary::AsyncRunner runner, ImageDecoder decoder) {
  models_.setRunner(std::move(runner));
  models_.setImageDecoder(std::move(decoder));
}

void GameSession::onBinaryFetched(std::uint64_t token, bool ok, std::string bytesOrError) {
  models_.onBinaryFetched(token, ok, std::move(bytesOrError));
  wake();
}

void GameSession::afterAsync() { wake(); }

void GameSession::setModel(Character& ch, const std::optional<std::string>& uri) {
  // engine-web `Character.setModel`: nothing to do while this model is shown (or it is the procedural body).
  if (uri == ch.modelUri && (ch.visual.hasModel() || !uri)) return;
  ch.modelUri = uri;
  ch.modelWaiting = false;
  if (!uri) {
    ch.visual.setAsset(nullptr, AnimationClips{});
    return;
  }
  if (std::shared_ptr<const ModelAsset> asset = models_.asset(*uri)) {
    ch.visual.setAsset(std::move(asset), animationMapping(member(ch.spec, "animations")));
    return;
  }
  // The current body (procedural, or the previous model) stays until the new model has loaded.
  ch.modelWaiting = true;
  models_.request(*uri);
}

DropVisual GameSession::makeDropVisual(const DropState& d) {
  DropVisual v;
  v.layerId = d.layerId;
  v.dropId = d.spec.id;
  v.position = d.spec.coordinate;
  v.type = d.spec.type;
  v.rarity = d.spec.rarity.value_or(Rarity::Common);
  v.value = d.spec.value;
  v.addedMs = clock_();
  v.phase = static_cast<double>(hashId(d.spec.id) % 628u) / 100.0;
  if (v.type == DropType::Model && d.spec.model && !d.spec.model->uri.empty()) {
    v.modelUri = d.spec.model->uri;
    v.model = models_.asset(v.modelUri);
    if (!v.model) models_.request(v.modelUri);
  }
  return v;
}

void GameSession::modelReady(const std::string& uri, const std::shared_ptr<const ModelAsset>& asset) {
  for (const auto& ch : chars_) {
    if (!ch->modelWaiting || ch->modelUri != uri) continue;
    ch->modelWaiting = false;
    ch->visual.setAsset(asset, animationMapping(member(ch->spec, "animations")));
  }
  for (auto& entry : dropVisuals_) {
    if (entry.second.modelUri == uri && !entry.second.model) entry.second.model = asset;
  }
  char buf[200];
  std::snprintf(buf, sizeof buf, "engine-native: model loaded (%zu triangles, %zu palette joints, %zu clips, %zu textures): ",
                asset->triangles, asset->joints.size(), asset->clips.size(), asset->mesh->textures.size());
  sink_.onLog(LogLevel::Info, buf + shortUri(uri));
  dirty_ |= kModels;
}

void GameSession::modelFailed(const std::string& uri, const std::string& message) {
  // engine-web `Features`: one `model_load_failed` per character / drop waiting for the model; they keep the
  // procedural body (or the model they showed) / show a coin.
  for (const auto& ch : chars_) {
    if (!ch->modelWaiting || ch->modelUri != uri) continue;
    ch->modelWaiting = false;
    emitError(kModelLoadFailedCode, "character " + ch->id() + ": failed to load " + uri + ": " + message);
  }
  for (auto& entry : dropVisuals_) {
    DropVisual& d = entry.second;
    if (d.modelUri != uri || d.model || d.modelFailed) continue;
    d.modelFailed = true;
    emitError(kModelLoadFailedCode, "drop " + d.layerId + "/" + d.dropId + ": failed to load " + uri + ": " + message);
  }
  dirty_ |= kModels;
}

void GameSession::modelWarning(const std::string& uri, const std::string& message) {
  warnOnce("model:" + message, "engine-native: " + shortUri(uri) + ": " + message);
}

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

GameSession::Character* GameSession::find(const std::string& id) const {
  for (const auto& ch : chars_) {
    if (ch->id() == id) return ch.get();
  }
  return nullptr;
}

Follower* GameSession::followerOf(std::string_view id) const {
  for (const auto& ch : chars_) {
    if (ch->id() == id) return &ch->follower;
  }
  return nullptr;
}

std::uint32_t GameSession::baseColor(const Character& ch) const {
  std::optional<std::uint32_t> color;
  if (const std::optional<std::string> css = stringMember(ch.spec, "color")) color = parseCssHex(*css);
  return color ? *color : ch.isPlayer() ? game_style::kPlayerColor : game_style::kNpcColors[hashId(ch.id()) % game_style::kNpcColors.size()];
}

std::uint32_t GameSession::bodyColor(const Character& ch) const {
  // Characters are lit in engine-web: they follow the time-of-day tint like the rest of the map (the model layer
  // multiplies the same tint into every model colour).
  return applyTint(baseColor(ch), map_.look().tint);
}

std::vector<GameSession::CharacterSnapshot> GameSession::characters() const {
  std::vector<CharacterSnapshot> out;
  for (const auto& ch : chars_) {
    const FollowerBody& b = ch->follower.body;
    out.push_back(CharacterSnapshot{ch->id(), WorldPoint{b.x, b.z}, b.y, headingFromYaw(ch->yaw), b.speed, b.mode,
                                    trips_.isTraveling(ch->id()), ch->isPlayer()});
  }
  return out;
}

void GameSession::processTravelEvents(const std::vector<TravelEvent>& events) {
  for (const TravelEvent& e : events) {
    emit(travelEventValue(e));
    if ((e.type == TravelEvent::Type::Cancel || e.type == TravelEvent::Type::Arrive) && routes_.erase(e.characterId) != 0) {
      dirty_ |= kRoute;
    }
  }
}

void GameSession::emit(Value event) {
  if (events_ != nullptr) events_->emit(std::move(event));
}

void GameSession::emitError(std::string_view code, std::string message) {
  emit(Value::object({{"type", "error"}, {"code", std::string(code)}, {"message", std::move(message)}, {"fatal", false}}));
}

void GameSession::respondOk(const std::string& requestId, Value result) {
  emit(Value::object({{"type", "response"}, {"requestId", requestId}, {"ok", true}, {"result", std::move(result)}}));
}

void GameSession::respondError(const std::string& requestId, std::string_view code, std::string message) {
  emit(Value::object({{"type", "response"},
                      {"requestId", requestId},
                      {"ok", false},
                      {"error", Value::object({{"code", std::string(code)}, {"message", std::move(message)}})}}));
}

void GameSession::warnOnce(const std::string& key, const std::string& message) {
  if (warned_.insert(key).second) sink_.onLog(LogLevel::Warn, message);
}

void GameSession::recordTick(double tickMs) {
  ++stats_.ticks;
  stats_.totalTickMs += tickMs;
  stats_.maxTickMs = std::max(stats_.maxTickMs, tickMs);
  ++statsWindow_.ticks;
  statsWindow_.totalTickMs += tickMs;
  statsWindow_.maxTickMs = std::max(statsWindow_.maxTickMs, tickMs);
  const double now = realMs();
  if (statsWindowStartMs_ < 0) statsWindowStartMs_ = now;
  if (now - statsWindowStartMs_ < kStatsWindowMs) return;
  char buf[384];
  std::snprintf(buf, sizeof buf,
                "engine-native: game ticks %llu in %.1f s: avg %.3f ms, max %.3f ms per tick; %llu source updates (avg %.0f bytes); "
                "%llu model frames (avg %.1f draws, %zu characters, %zu drops)",
                static_cast<unsigned long long>(statsWindow_.ticks), (now - statsWindowStartMs_) / 1000.0,
                statsWindow_.totalTickMs / static_cast<double>(statsWindow_.ticks), statsWindow_.maxTickMs,
                static_cast<unsigned long long>(statsWindow_.sourceUpdates),
                statsWindow_.sourceUpdates > 0
                    ? static_cast<double>(statsWindow_.sourceBytes) / static_cast<double>(statsWindow_.sourceUpdates)
                    : 0.0,
                static_cast<unsigned long long>(statsWindow_.modelFrames),
                statsWindow_.modelFrames > 0 ? static_cast<double>(statsWindow_.modelDraws) / static_cast<double>(statsWindow_.modelFrames) : 0.0,
                chars_.size(), dropVisuals_.size());
  sink_.onLog(LogLevel::Info, buf);
  statsWindow_ = GameFrameStats{};
  statsWindowStartMs_ = now;
}

}  // namespace maprama
