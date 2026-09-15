// Maprama native core — message protocol codec (port of messages.ts).
//
// `decodeCommand` reproduces `@maprama/protocol`'s `decodeCommand` exactly:
// same acceptance and the same error strings, except that the text after
// "$: invalid JSON: " (V8's JSON.parse message) is implementation-specific.
// Verified by cpp/tests/fixtures/decode-command.json (exported from the TS
// package on every `npm test`).
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>

#include "maprama/json.hpp"

namespace maprama::protocol {

/// `PROTOCOL_VERSION`.
inline constexpr int kProtocolVersion = 1;
/// `WORLD_DATA_VERSION`.
inline constexpr int kWorldDataVersion = 1;
/// `Number.MAX_SAFE_INTEGER` (upper bound of `seq`).
inline constexpr std::uint64_t kMaxSafeInteger = 9007199254740991ULL;

/// `ENGINE_COMMAND_TYPES`, in declaration order.
inline constexpr std::array<std::string_view, 20> kEngineCommandTypes{
    "init",         "setTheme",         "setLabels",         "setLabelContent", "setUi",
    "setCamera",    "upsertCharacters", "removeCharacters",  "setLocationSource", "pushLocation",
    "travel",       "cancelTravel",     "setDropLayer",      "removeDropLayer", "setGeofences",
    "setBuildingStyle", "setOverlayAnchors", "subscribe",    "unsubscribe",     "request",
};

/// `ENGINE_EVENT_TYPES`, in declaration order.
inline constexpr std::array<std::string_view, 16> kEngineEventTypes{
    "ready",          "error",         "labelsIndex",    "map:press",      "building:press", "drop:collect",
    "travel:start",   "travel:progress", "travel:arrive", "travel:cancel", "geofence:enter", "geofence:exit",
    "character:position", "camera:change", "overlay:positions", "response",
};

struct ValidationResult {
  bool ok = true;
  std::string error;
};

/// A decoded envelope. `msg` is the validated message object (it always has a string `type`).
struct Envelope {
  std::uint64_t seq = 0;
  json::Value msg;

  const std::string& type() const;
};

using CommandEnvelope = Envelope;
using EventEnvelope = Envelope;

template <class T>
struct DecodeResult {
  bool ok = false;
  T value;
  std::string error;
};

/// Parses and validates a command envelope from JSON text. Never throws.
DecodeResult<CommandEnvelope> decodeCommand(std::string_view data);
/// Validates an already-parsed envelope (JSI object fast path); identical to `decodeCommand` after `JSON.parse`.
DecodeResult<CommandEnvelope> decodeCommandValue(json::Value envelope);
/// Parses and validates an event envelope from JSON text. Never throws.
DecodeResult<EventEnvelope> decodeEvent(std::string_view data);
DecodeResult<EventEnvelope> decodeEventValue(json::Value envelope);

/// `validateEngineCommand` / `validateEngineEvent` (message only, no envelope).
ValidationResult validateEngineCommand(const json::Value& message);
ValidationResult validateEngineEvent(const json::Value& message);

/// `validateWorldData` / `validateWorldSource` / `validateThemeSpec` / `validateThemePreset`.
ValidationResult validateWorldData(const json::Value& value);
ValidationResult validateWorldSource(const json::Value& value);
ValidationResult validateThemeSpec(const json::Value& value);
ValidationResult validateThemePreset(const json::Value& value);

/// `encodeCommand` / `encodeEvent`: `{"v":1,"seq":N,"kind":"cmd|evt","msg":...}`. Does not validate.
/// @throws std::range_error if `seq` > `kMaxSafeInteger` (same message as the TS RangeError).
std::string encodeCommand(const json::Value& command, std::uint64_t seq);
std::string encodeEvent(const json::Value& event, std::uint64_t seq);

}  // namespace maprama::protocol
