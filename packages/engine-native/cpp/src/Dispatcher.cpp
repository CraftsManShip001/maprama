#include "maprama/Dispatcher.hpp"

#include <optional>
#include <utility>

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
  switch (commandIndex(envelope.type())) {
    case 0:  // init -> WorldStore + MapSession (M1: world style + camera); ThemeResolver, LabelSystem (M2)
      if (session != nullptr) {
        ++stats_.handled;
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
    case 17:  // subscribe -> subscription registry (M1: camera:change)
    case 18: {  // unsubscribe
      const std::string& topic = envelope.msg.find("topic")->asString();
      if (session != nullptr && topic == enumName(SubscriptionTopic::CameraChange)) {
        ++stats_.handled;
        if (commandIndex(envelope.type()) == 17) {
          session->subscribeCamera(envelope.msg.find("throttleMs")->asNumber());
        } else {
          session->unsubscribeCamera();
        }
        return;
      }
      ignoreNotImplemented(envelope, session != nullptr ? "topic " + json::quote(topic) +
                                                              " is not implemented yet (M3); ignored"
                                                        : std::string());
      return;
    }
    case 19: {  // request -> MapSession (project/unproject, M1), TravelPlanner (snapToRoad/route, M3)
      const std::optional<RequestMethod> method = parseEnum<RequestMethod>(envelope.msg.find("method")->asString());
      if (session != nullptr && method && (*method == RequestMethod::Project || *method == RequestMethod::Unproject)) {
        ++stats_.handled;
        session->request(envelope.msg.find("requestId")->asString(), *method, *envelope.msg.find("params"));
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
          break;
        case 4:
          session->setUi(*envelope.msg.find("ui"));
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
    case 6:  // upsertCharacters -> CharacterSystem
    case 7:  // removeCharacters -> CharacterSystem
    case 8:  // setLocationSource -> CharacterSystem
    case 9:  // pushLocation -> CharacterSystem
    case 10:  // travel -> TravelPlanner
    case 11:  // cancelTravel -> TravelPlanner
    case 12:  // setDropLayer -> DropSystem
    case 13:  // removeDropLayer -> DropSystem
    case 14:  // setGeofences -> GeofenceSystem
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
