#include "maprama/Dispatcher.hpp"

#include <optional>
#include <utility>

#include "maprama/GameSession.hpp"
#include "maprama/MapSession.hpp"
#include "maprama/WorldStore.hpp"

namespace maprama {

namespace {

using json::Value;

constexpr std::size_t commandIndex(std::string_view type) {
  for (std::size_t i = 0; i < protocol::kEngineCommandTypes.size(); ++i) {
    if (protocol::kEngineCommandTypes[i] == type) return i;
  }
  return protocol::kEngineCommandTypes.size();
}

}  // namespace

Dispatcher::Dispatcher(MessageSink& sink, Subsystems subsystems, DispatcherOptions options)
    : sink_(sink), subsystems_(subsystems), options_(std::move(options)) {}

void Dispatcher::emitReady() {
  emit(Value::object({
      {"type", "ready"},
      {"engine", Value::object({
                     {"name", options_.info.name},
                     {"version", options_.info.version},
                     {"kind", std::string(enumName(options_.info.kind))},
                 })},
  }));
}

void Dispatcher::dispatch(std::string_view envelopeJson) { handleDecoded(protocol::decodeCommand(envelopeJson)); }

void Dispatcher::dispatchValue(Value envelope) { handleDecoded(protocol::decodeCommandValue(std::move(envelope))); }

void Dispatcher::handleDecoded(protocol::DecodeResult<protocol::CommandEnvelope> decoded) {
  ++stats_.received;
  if (!decoded.ok) {
    ++stats_.rejected;
    emit(Value::object({
        {"type", "error"},
        {"code", std::string(error_codes::kInvalidMessage)},
        {"message", std::move(decoded.error)},
        {"fatal", false},
    }));
    return;
  }
  route(decoded.value);
}

void Dispatcher::emit(Value event) {
  if (options_.validateOutgoingEvents) {
    protocol::ValidationResult checked = protocol::validateEngineEvent(event);
    if (!checked.ok) {
      ++stats_.eventsDropped;
      sink_.onLog(LogLevel::Error, "engine-native: dropped invalid outgoing event: " + checked.error);
      return;
    }
  }
  ++stats_.eventsEmitted;
  sink_.onEvent(protocol::encodeEvent(event, nextEventSeq_++));
}

void Dispatcher::route(const protocol::CommandEnvelope& envelope) {
  // One case per ENGINE_COMMAND_TYPES entry, in declaration order; the owning subsystem is noted per case
  // (DESIGN.md §4). Typed spec decoding + subsystem calls land milestone by milestone (DESIGN.md §10).
  MapSession* session = subsystems_.session;
  GameSession* game = subsystems_.game;
  const json::Value& msg = envelope.msg;
  switch (commandIndex(envelope.type())) {
    case 0:  // init -> WorldStore + MapSession (M1: world style + camera, M2a look); GameSession (M3a location source)
      if (session != nullptr) {
        ++stats_.handled;
        if (game != nullptr) game->init(msg);
        session->init(envelope.msg);
      } else {
        handleInit(envelope);
      }
      return;
    case 5:  // setCamera -> MapSession camera (M1)
      if (session != nullptr) {
        ++stats_.handled;
        session->setCamera(*envelope.msg.find("camera"));
        return;
      }
      ignoreNotImplemented(envelope);
      return;
    case 17:  // subscribe -> MapSession (camera:change M1, camera:idle), GameSession (character:position, travel:progress, M3a)
    case 18: {  // unsubscribe
      const bool subscribe = commandIndex(envelope.type()) == 17;
      const std::optional<SubscriptionTopic> topic = parseEnum<SubscriptionTopic>(msg.find("topic")->asString());
      if (session != nullptr && (topic == SubscriptionTopic::CameraChange || topic == SubscriptionTopic::CameraIdle)) {
        ++stats_.handled;
        const bool idle = topic == SubscriptionTopic::CameraIdle;
        if (subscribe) {
          const double throttleMs = msg.find("throttleMs")->asNumber();
          if (idle) {
            session->subscribeCameraIdle(throttleMs);
          } else {
            session->subscribeCamera(throttleMs);
          }
        } else if (idle) {
          session->unsubscribeCameraIdle();
        } else {
          session->unsubscribeCamera();
        }
        return;
      }
      if (game != nullptr && topic) {
        ++stats_.handled;
        const json::Value* id = msg.find("id");
        std::optional<std::string> key = id != nullptr && id->isString() ? std::optional<std::string>(id->asString()) : std::nullopt;
        if (subscribe) {
          game->subscribe(*topic, std::move(key), msg.find("throttleMs")->asNumber());
        } else {
          game->unsubscribe(*topic, key);
        }
        return;
      }
      ignoreNotImplemented(envelope);
      return;
    }
    case 19: {  // request -> MapSession (project/unproject, M1), GameSession (snapToRoad/route, M3a)
      const std::optional<RequestMethod> method = parseEnum<RequestMethod>(msg.find("method")->asString());
      if (session != nullptr && method &&
          (*method == RequestMethod::Project || *method == RequestMethod::Unproject ||
           *method == RequestMethod::FitBounds)) {
        ++stats_.handled;
        session->request(msg.find("requestId")->asString(), *method, *msg.find("params"));
        return;
      }
      if (game != nullptr && method && (*method == RequestMethod::SnapToRoad || *method == RequestMethod::Route)) {
        ++stats_.handled;
        game->request(msg.find("requestId")->asString(), *method, *msg.find("params"));
        return;
      }
      respondNotImplemented(envelope);
      return;
    }
    case 1:  // setTheme -> ThemeResolver + MapSession style (M2a)
    case 4:  // setUi -> MapSession map UI ornaments (M2a)
    case 15:  // setBuildingStyle -> MapSession building overrides (M2a: color, captured state)
    case 16:  // setOverlayAnchors -> MapSession overlay:positions (M2a)
      if (session == nullptr) {
        ignoreNotImplemented(envelope);
        return;
      }
      ++stats_.handled;
      switch (commandIndex(envelope.type())) {
        case 1:
          session->setTheme(*envelope.msg.find("theme"));
          if (game != nullptr) game->themeChanged();
          break;
        case 4:
          session->setUi(*envelope.msg.find("ui"));
          if (game != nullptr) game->uiChanged();
          break;
        case 15:
          session->setBuildingStyle(envelope.msg.find("buildingId")->asString(), *envelope.msg.find("style"));
          break;
        default:
          session->setOverlayAnchors(*envelope.msg.find("anchors"));
          break;
      }
      return;
    case 2:  // setLabels -> MapSession LabelSystem (M2b)
    case 3:  // setLabelContent -> MapSession LabelSystem (M2b)
      if (session == nullptr) {
        ignoreNotImplemented(envelope);
        return;
      }
      ++stats_.handled;
      if (commandIndex(envelope.type()) == 2) {
        session->setLabels(*envelope.msg.find("labels"));
      } else {
        session->setLabelContent(*envelope.msg.find("entries"));
      }
      return;
    case 6:  // upsertCharacters -> GameSession (M3a)
    case 7:  // removeCharacters -> GameSession
    case 8:  // setLocationSource -> GameSession (+ MapAdapter location feed)
    case 9:  // pushLocation -> GameSession
    case 10:  // travel -> GameSession (TravelTrips)
    case 11:  // cancelTravel -> GameSession
    case 12:  // setDropLayer -> GameSession (DropCollector)
    case 13:  // removeDropLayer -> GameSession
    case 14:  // setGeofences -> GameSession (GeofenceTracker)
      if (game == nullptr) {
        ignoreNotImplemented(envelope);
        return;
      }
      ++stats_.handled;
      switch (commandIndex(envelope.type())) {
        case 6:
          game->upsertCharacters(*msg.find("characters"));
          break;
        case 7:
          game->removeCharacters(*msg.find("ids"));
          break;
        case 8:
          game->setLocationSource(msg.find("source")->asString());
          break;
        case 9:
          game->pushLocation(*msg.find("fix"));
          break;
        case 10:
          game->travel(msg);
          break;
        case 11:
          game->cancelTravel(msg.find("characterId")->asString());
          break;
        case 12:
          game->setDropLayer(msg);
          break;
        case 13:
          game->removeDropLayer(msg.find("layerId")->asString());
          break;
        default:
          game->setGeofences(*msg.find("geofences"));
          break;
      }
      return;
    case 20:  // setMarkerLayer -> MapSession MarkerSystem (M5: marker cards on the label view pool)
    case 21:  // removeMarkerLayer
      if (session == nullptr) {
        ignoreNotImplemented(envelope);
        return;
      }
      ++stats_.handled;
      if (commandIndex(envelope.type()) == 20) {
        session->setMarkerLayer(msg);
      } else {
        session->removeMarkerLayer(msg.find("layerId")->asString());
      }
      return;
    case 22:  // setInfoCard -> holographic info cards (engine-web v1; the native views are a follow-up)
    case 23:  // removeInfoCard
      ignoreNotImplemented(envelope);
      return;
    case 24:  // setView -> 2D / 2.5D view mode (engine-web v1; the native flat mode is a follow-up)
      ignoreNotImplemented(envelope);
      return;
    default:  // unreachable: decodeCommand rejects unknown types
      ignoreNotImplemented(envelope, "unknown command type");
      return;
  }
}

void Dispatcher::handleInit(const protocol::CommandEnvelope& envelope) {
  const Value& source = *envelope.msg.find("world");
  const std::string& kind = source.find("kind")->asString();
  bool worldHandled = false;
  if (kind == "data" && subsystems_.world != nullptr) {
    Result<WorldLoadReport> loaded = subsystems_.world->load(*source.find("world"));
    if (!loaded.ok()) {
      emit(Value::object({
          {"type", "error"},
          {"code", std::string(error_codes::kWorldLoadFailed)},
          {"message", loaded.error},
          {"fatal", true},
      }));
      ++stats_.handled;
      return;
    }
    const WorldLoadReport& report = *loaded.value;
    for (const std::string& warning : report.warnings) {
      sink_.onLog(LogLevel::Warn, "engine-native: init world: " + warning);
    }
    sink_.onLog(LogLevel::Info, "engine-native: world loaded (" + std::to_string(report.roads) + " roads, " +
                                    std::to_string(report.buildings) + " buildings, " +
                                    std::to_string(report.pois) + " pois)");
    worldHandled = true;
  }
  ++stats_.handled;
  ignoreNotImplemented(envelope, worldHandled ? "theme, labels, ui, camera and locationSource are not applied yet"
                                              : "world source kind " + json::quote(kind) +
                                                    " and theme, labels, ui, camera, locationSource are not applied yet");
}

void Dispatcher::respondNotImplemented(const protocol::CommandEnvelope& envelope) {
  ++stats_.notImplemented;
  const std::string& method = envelope.msg.find("method")->asString();
  emit(Value::object({
      {"type", "response"},
      {"requestId", envelope.msg.find("requestId")->asString()},
      {"ok", false},
      {"error", Value::object({
                    {"code", std::string(kNotImplementedCode)},
                    {"message", "request method " + json::quote(method) + " is not implemented by the " +
                                    options_.info.name + " core yet"},
                })},
  }));
}

void Dispatcher::ignoreNotImplemented(const protocol::CommandEnvelope& envelope, std::string_view detail) {
  ++stats_.notImplemented;
  std::string message = "engine-native: command " + json::quote(envelope.type()) + " (seq " +
                        std::to_string(envelope.seq) + ") ";
  message += detail.empty() ? std::string("is not implemented; ignored") : std::string(detail);
  sink_.onLog(LogLevel::Warn, message);
}

}  // namespace maprama
