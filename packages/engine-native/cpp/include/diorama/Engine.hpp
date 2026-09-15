// Diorama native core — engine facade used by the platform wrappers
// (iOS `DioramaNativeView` / Android `DioramaNativeView`, `DioramaEngineModule`).
#pragma once

#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "diorama/CameraController.hpp"
#include "diorama/MessageSink.hpp"
#include "diorama/json.hpp"
#include "diorama/types.hpp"

namespace diorama {

class WorldStore;

inline constexpr std::string_view kCoreName = "diorama-native";
inline constexpr std::string_view kCoreVersion = "0.0.0";

struct EngineConfig {
  EngineInfo info{std::string(kCoreName), std::string(kCoreVersion), EngineKind::Native};
  /// Validate outgoing events against the protocol (enable in debug / tests).
  bool validateOutgoingEvents = false;
};

/// One engine instance per map view. All methods are safe to call from any thread
/// (the skeleton serialises with a mutex; the production core posts to its own queue, DESIGN.md §3).
class Engine {
 public:
  virtual ~Engine() = default;

  /// Emits `ready`. Call once after the sink is ready to receive events.
  virtual void start() = 0;

  /// One command envelope as JSON text (`encodeCommand` output).
  virtual void postMessage(std::string_view envelopeJson) = 0;
  /// One pre-parsed envelope (JSI object path).
  virtual void postEnvelope(json::Value envelope) = 0;
  /// A transport batch: envelopes are dispatched in order, each decoded independently.
  virtual void postMessages(const std::vector<std::string>& envelopesJson) = 0;

  virtual void setViewport(const Viewport& viewport) = 0;
  /// Render-thread frame callback (CADisplayLink / Choreographer), milliseconds.
  virtual void frame(double timestampMs) = 0;
  /// Tap from the platform gesture recogniser, density-independent pixels.
  virtual void tap(double x, double y) = 0;

  virtual const WorldStore& worldStore() const = 0;

  /// Stops processing; later calls are ignored.
  virtual void shutdown() = 0;
};

std::unique_ptr<Engine> createEngine(std::shared_ptr<MessageSink> sink, EngineConfig config = {});

}  // namespace diorama
