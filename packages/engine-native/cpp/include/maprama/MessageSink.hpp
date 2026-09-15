// Maprama native core — outbound message path (engine -> host).
#pragma once

#include <cstdint>
#include <string>
#include <string_view>

#include "maprama/json.hpp"

namespace maprama {

enum class LogLevel : std::uint8_t { Debug, Info, Warn, Error };

/// Implemented by the platform layer (Obj-C++ / JNI) to receive engine output.
///
/// Threading: called on the core thread that produced the output (see
/// DESIGN.md §3). Implementations must not block; they enqueue onto the JS
/// thread via `CallInvoker::invokeAsync` and batch per frame.
class MessageSink {
 public:
  virtual ~MessageSink() = default;

  /// One encoded event envelope: `{"v":1,"seq":N,"kind":"evt","msg":{...}}`.
  virtual void onEvent(std::string envelopeJson) = 0;

  /// Diagnostics that have no protocol event (e.g. ignored, unimplemented commands).
  virtual void onLog(LogLevel level, std::string_view message) = 0;
};

/// Subsystems emit protocol events (message objects, no envelope) through this.
/// The dispatcher assigns `seq`, optionally validates, encodes and forwards to the sink.
class EventEmitter {
 public:
  virtual ~EventEmitter() = default;
  virtual void emit(json::Value event) = 0;
};

}  // namespace maprama
