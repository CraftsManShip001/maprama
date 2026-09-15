// Engine / Dispatcher skeleton behaviour. Every emitted envelope is also written to --emit so that
// scripts/verify-emitted-events.mjs can validate it with the TypeScript decodeEvent.
#include <fstream>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "maprama/Dispatcher.hpp"
#include "maprama/Engine.hpp"
#include "maprama/WorldStore.hpp"
#include "maprama/protocol.hpp"
#include "harness.hpp"

namespace {

using maprama::json::Value;
namespace protocol = maprama::protocol;

class RecordingSink final : public maprama::MessageSink {
 public:
  void onEvent(std::string envelopeJson) override { events.push_back(std::move(envelopeJson)); }
  void onLog(maprama::LogLevel level, std::string_view message) override { logs.emplace_back(level, message); }

  std::vector<std::string> events;
  std::vector<std::pair<maprama::LogLevel, std::string>> logs;

  Value eventMsg(std::size_t i) const { return protocol::decodeEvent(events.at(i)).value.msg; }
  std::size_t warnings() const {
    std::size_t n = 0;
    for (const auto& l : logs) n += l.first == maprama::LogLevel::Warn ? 1 : 0;
    return n;
  }
  std::size_t errors() const {
    std::size_t n = 0;
    for (const auto& l : logs) n += l.first == maprama::LogLevel::Error ? 1 : 0;
    return n;
  }
};

void appendEmitted(const maprama::test::Context& ctx, const RecordingSink& sink) {
  if (ctx.emitPath.empty()) return;
  std::ofstream out(ctx.emitPath, std::ios::app);
  for (const std::string& e : sink.events) out << e << "\n";
}

std::string envelope(const Value& msg, std::uint64_t seq) { return protocol::encodeCommand(msg, seq); }

}  // namespace

MAPRAMA_TEST(engine_skeleton_behaviour) {
  auto sink = std::make_shared<RecordingSink>();
  maprama::EngineConfig config;
  config.validateOutgoingEvents = true;
  auto engine = maprama::createEngine(sink, config);

  // ready
  engine->start();
  engine->start();  // idempotent
  ctx.check(sink->events.size() == 1, "start() emits exactly one ready");
  protocol::DecodeResult<protocol::Envelope> ready = protocol::decodeEvent(sink->events.at(0));
  ctx.check(ready.ok && ready.value.seq == 0 && ready.value.type() == "ready" &&
                ready.value.msg.find("engine")->find("kind")->asString() == "native" &&
                ready.value.msg.find("engine")->find("name")->asString() == "maprama-native",
            "ready event: " + sink->events.at(0));

  // invalid JSON -> error invalid_message
  engine->postMessage("not json");
  Value err = sink->eventMsg(1);
  ctx.check(err.find("type")->asString() == "error" && err.find("code")->asString() == "invalid_message" &&
                err.find("fatal")->isBoolean() && !err.find("fatal")->asBool() &&
                err.find("message")->asString().rfind("$: invalid JSON: ", 0) == 0,
            "invalid JSON -> error invalid_message: " + sink->events.at(1));

  // validation failure -> exact decodeCommand message
  engine->postMessage(R"({"v":2,"seq":1,"kind":"cmd","msg":{"type":"setUi","ui":{}}})");
  ctx.check(sink->eventMsg(2).find("message")->asString() == "$.v: unsupported protocol version 2 (expected 1)",
            "validation error message is decodeCommand's");

  // every valid command sample from the TS fixture
  const Value fixture = maprama::test::loadFixture(ctx, "decode-command.json");
  std::set<std::string> exercised;
  std::uint64_t seq = 10;
  for (const Value& c : fixture.find("cases")->items()) {
    if (!c.find("ok")->asBool()) continue;
    const std::string& name = c.find("name")->asString();
    if (name.find(": valid") == std::string::npos) continue;
    const std::string& type = c.find("type")->asString();
    exercised.insert(type);

    const std::size_t eventsBefore = sink->events.size();
    const std::size_t warningsBefore = sink->warnings();
    const std::size_t logsBefore = sink->logs.size();
    engine->postMessage(c.find("input")->asString());
    const std::size_t newEvents = sink->events.size() - eventsBefore;
    const Value decoded = protocol::decodeCommand(c.find("input")->asString()).value.msg;
    const Value* topic = decoded.find("topic");

    if (type == "request") {
      // M1: project/unproject need an attached, laid-out native map (none here) -> not_ready; others unsupported.
      const std::string& method = decoded.find("method")->asString();
      const std::string expectedCode = (method == "project" || method == "unproject") ? "not_ready" : "unsupported";
      bool ok = newEvents == 1;
      if (ok) {
        Value res = sink->eventMsg(eventsBefore);
        ok = res.find("type")->asString() == "response" &&
             res.find("requestId")->asString() == decoded.find("requestId")->asString() &&
             !res.find("ok")->asBool() && res.find("error")->find("code")->asString() == expectedCode;
        if (ok && expectedCode == "unsupported") {
          ok = res.find("error")->find("message")->asString().find(method) != std::string::npos;
        }
      }
      ctx.check(ok, "[" + name + "] request -> " + expectedCode + " response");
    } else if (name.rfind("init_url", 0) == 0 || name.rfind("init_procedural", 0) == 0) {
      // url worlds are fetched by the platform adapter (none attached here); procedural worlds are not in M1.
      const bool url = name.rfind("init_url", 0) == 0;
      bool ok = newEvents == 1;
      if (ok) {
        Value e = sink->eventMsg(eventsBefore);
        ok = e.find("type")->asString() == "error" && e.find("fatal")->asBool() &&
             e.find("code")->asString() == (url ? "world_load_failed" : "unsupported");
      }
      ctx.check(ok, "[" + name + "] -> fatal " + (url ? std::string("world_load_failed") : std::string("unsupported")) +
                        " error");
    } else if (type == "setCamera" || (type == "unsubscribe" && topic && topic->asString() == "camera:change")) {
      // Handled by the M1 session: no warning, and no event without a camera:change subscription.
      ctx.check(newEvents == 0 && sink->warnings() == warningsBefore, "[" + name + "] handled silently by the M1 session");
    } else if (type == "init" || type == "setTheme" || type == "setUi" || type == "setBuildingStyle" ||
               type == "setOverlayAnchors") {
      // Handled by the M2a session: no event (building "b1" exists; overlays need a map view, none here) and no
      // "not implemented" warning. Accepted-but-unrendered options (facade / outline / massing looks, labels,
      // location source, roof / decorations / replaceModel overrides, follow) are warn-logged once each.
      ctx.check(newEvents == 0, "[" + name + "] handled without events (got " + std::to_string(newEvents) + ")");
      bool notImplemented = false;
      for (std::size_t i = logsBefore; i < sink->logs.size(); ++i) {
        notImplemented = notImplemented || sink->logs[i].second.find("is not implemented; ignored") != std::string::npos;
      }
      ctx.check(!notImplemented, "[" + name + "] not logged as an ignored command");
      if (type == "init") {
        ctx.check(sink->warnings() > warningsBefore && sink->logs.back().second.find("setCamera.follow") != std::string::npos,
                  "[" + name + "] init.camera.follow warned (characters are M3)");
      }
    } else {
      // The init fixture's camera has `follow: "player"`: the M1 session warns about it (characters are M3)
      // in addition to the not-applied init parts.
      const Value* camera = decoded.find("camera");
      const std::size_t expectedWarnings = (type == "init" && camera && camera->find("follow")) ? 2 : 1;
      ctx.check(newEvents == 0, "[" + name + "] fire-and-forget emits no event (got " + std::to_string(newEvents) + ")");
      ctx.check(sink->warnings() == warningsBefore + expectedWarnings,
                "[" + name + "] logs " + std::to_string(expectedWarnings) + " not-implemented warning(s)");
      const std::string& lastLog = sink->logs.back().second;
      ctx.check(lastLog.find(type == "init" ? std::string("init:") : "\"" + type + "\"") != std::string::npos,
                "[" + name + "] warning names the command");
    }
    ++seq;
  }
  for (std::string_view type : protocol::kEngineCommandTypes) {
    ctx.check(exercised.count(std::string(type)) == 1, "command type exercised: " + std::string(type));
  }

  // init with inline world data loaded the world
  ctx.check(engine->worldStore().loaded() && engine->worldStore().findBuilding("b1") != nullptr,
            "init {world: {kind: data}} loads the WorldStore");

  // object path + batch path
  const std::size_t before = sink->events.size();
  engine->postEnvelope(maprama::json::parse(envelope(Value::object({{"type", "request"},
                                                                    {"requestId", "obj"},
                                                                    {"method", "unproject"},
                                                                    {"params", Value::object({{"x", 1}, {"y", 2}})}}),
                                                     seq++))
                           .value);
  engine->postMessages({envelope(Value::object({{"type", "request"},
                                                {"requestId", "batch-1"},
                                                {"method", "route"},
                                                {"params", Value::object({{"from", Value::object({{"lng", 0}, {"lat", 0}})},
                                                                          {"to", Value::object({{"lng", 1}, {"lat", 1}})},
                                                                          {"modes", Value::array({"walk"})}})}}),
                                 seq++),
                        R"({"v":1,"seq":-5,"kind":"cmd","msg":{"type":"setUi","ui":{}}})"});
  ctx.check(sink->events.size() == before + 3, "postEnvelope + postMessages emit in order");
  if (sink->events.size() == before + 3) {
    ctx.check(sink->eventMsg(before).find("requestId")->asString() == "obj", "object path response");
    ctx.check(sink->eventMsg(before + 1).find("requestId")->asString() == "batch-1", "batch response 1");
    ctx.check(sink->eventMsg(before + 2).find("message")->asString() ==
                  "$.seq: expected non-negative integer, got number",
              "batch element 2 rejected independently");
  }

  // event seq strictly increasing from 0, all valid
  for (std::size_t i = 0; i < sink->events.size(); ++i) {
    protocol::DecodeResult<protocol::Envelope> e = protocol::decodeEvent(sink->events[i]);
    ctx.check(e.ok && e.value.seq == i, "event " + std::to_string(i) + " valid with seq " + std::to_string(i) +
                                            (e.ok ? "" : ": " + e.error));
  }
  ctx.check(sink->errors() == 0, "no error logs (no dropped outgoing events)");

  // tap without a map view is ignored (hit testing goes through the adapter), shutdown stops processing
  const std::size_t eventsBeforeTap = sink->events.size();
  engine->tap(10, 20);
  ctx.check(sink->events.size() == eventsBeforeTap && sink->logs.back().second.find("tap ignored") != std::string::npos,
            "tap without a map view is ignored");
  engine->shutdown();
  const std::size_t afterShutdown = sink->events.size();
  engine->postMessage("not json");
  ctx.check(sink->events.size() == afterShutdown, "messages after shutdown are ignored");

  appendEmitted(ctx, *sink);
}

MAPRAMA_TEST(dispatcher_drops_invalid_outgoing_events) {
  RecordingSink sink;
  auto world = maprama::createWorldStore();
  maprama::Subsystems subsystems;
  subsystems.world = world.get();
  maprama::DispatcherOptions options;
  options.validateOutgoingEvents = true;
  maprama::Dispatcher dispatcher(sink, subsystems, options);

  dispatcher.emit(Value::object({{"type", "travel:arrive"}, {"requestId", ""}, {"characterId", "p"}}));
  ctx.check(sink.events.empty() && dispatcher.stats().eventsDropped == 1 && sink.errors() == 1 &&
                sink.logs.back().second.find("$.requestId: expected non-empty string, got string") != std::string::npos,
            "invalid outgoing event dropped with the validation error logged");

  dispatcher.emit(Value::object({{"type", "travel:arrive"}, {"requestId", "t"}, {"characterId", "p"}}));
  ctx.check(sink.events.size() == 1 && dispatcher.stats().eventsEmitted == 1, "valid event emitted");
  ctx.check(protocol::decodeEvent(sink.events[0]).value.seq == 0, "dropped events do not consume seq");

  // init with a url world: not loaded, warning names the source kind.
  dispatcher.dispatch(envelope(Value::object({{"type", "init"},
                                              {"world", Value::object({{"kind", "url"}, {"url", "https://x/w.json"}})},
                                              {"theme", Value::object()},
                                              {"labels", Value::object()},
                                              {"ui", Value::object()},
                                              {"locationSource", "device"}}),
                               1));
  ctx.check(!world->loaded() && sink.logs.back().second.find("world source kind \"url\"") != std::string::npos,
            "init with url world logs not implemented");
  ctx.check(dispatcher.stats().received == 1 && dispatcher.stats().rejected == 0, "stats counted");
  appendEmitted(ctx, sink);
}
