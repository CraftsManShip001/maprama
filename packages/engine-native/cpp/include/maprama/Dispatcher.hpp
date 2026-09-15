// Maprama native core — command dispatcher.
//
// Decodes envelopes exactly like `decodeCommand`, then routes each command to
// its subsystem (DESIGN.md §5 mapping table).
//   - decode failure            -> `error` event {code: "invalid_message", fatal: false}
//   - with a MapSession (M1): `init`, `setCamera`, `subscribe`/`unsubscribe` of `camera:change` and
//     `request` `project`/`unproject` go to the session
//   - `request` (other methods, or no session) -> `response` {ok: false, error.code: "unsupported"}
//   - `init` without a session  -> WorldStore::load (M0 path; other init parts logged as not implemented)
//   - other fire-and-forget     -> ignored with a LogLevel::Warn log (the protocol has no warning event)
#pragma once

#include <cstdint>
#include <string>
#include <string_view>

#include "maprama/MessageSink.hpp"
#include "maprama/json.hpp"
#include "maprama/protocol.hpp"
#include "maprama/types.hpp"

namespace maprama {

class WorldStore;
class ThemeResolver;
class CharacterSystem;
class TravelPlanner;
class DropSystem;
class GeofenceSystem;
class LabelSystem;
class CameraController;
class MapSession;

/// Non-owning subsystem pointers; nullptr = not implemented yet.
struct Subsystems {
  WorldStore* world = nullptr;
  /// M1 map session (world style, camera, camera:change, project/unproject). nullptr = M0 behaviour.
  MapSession* session = nullptr;
  ThemeResolver* theme = nullptr;
  CharacterSystem* characters = nullptr;
  TravelPlanner* travel = nullptr;
  DropSystem* drops = nullptr;
  GeofenceSystem* geofences = nullptr;
  LabelSystem* labels = nullptr;
  CameraController* camera = nullptr;
};

struct DispatcherOptions {
  EngineInfo info{"maprama-native", "0.0.0", EngineKind::Native};
  /// Validate every outgoing event with `validateEngineEvent`; invalid events are dropped and logged (debug builds).
  bool validateOutgoingEvents = false;
};

struct DispatchStats {
  std::uint64_t received = 0;
  std::uint64_t rejected = 0;
  std::uint64_t handled = 0;
  std::uint64_t notImplemented = 0;
  std::uint64_t eventsEmitted = 0;
  std::uint64_t eventsDropped = 0;
};

/// Error code used by the skeleton for request methods that have no implementation yet.
inline constexpr std::string_view kNotImplementedCode = "unsupported";

/// Not thread-safe: owned by the core thread (the Engine serialises access).
class Dispatcher final : public EventEmitter {
 public:
  Dispatcher(MessageSink& sink, Subsystems subsystems, DispatcherOptions options = {});

  /// Emits `ready` (the host sends `init` next).
  void emitReady();

  /// JSON text path (JSI string / WebView-compatible).
  void dispatch(std::string_view envelopeJson);
  /// Pre-parsed path (JSI object converted to json::Value without re-serialising).
  void dispatchValue(json::Value envelope);

  /// EventEmitter: assigns the next event `seq`, encodes and forwards to the sink.
  void emit(json::Value event) override;

  const DispatchStats& stats() const { return stats_; }

 private:
  void handleDecoded(protocol::DecodeResult<protocol::CommandEnvelope> decoded);
  void route(const protocol::CommandEnvelope& envelope);
  void handleInit(const protocol::CommandEnvelope& envelope);
  void respondNotImplemented(const protocol::CommandEnvelope& envelope);
  void ignoreNotImplemented(const protocol::CommandEnvelope& envelope, std::string_view detail = {});

  MessageSink& sink_;
  Subsystems subsystems_;
  DispatcherOptions options_;
  std::uint64_t nextEventSeq_ = 0;
  DispatchStats stats_;
};

}  // namespace maprama
