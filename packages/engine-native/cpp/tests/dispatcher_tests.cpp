// Engine / Dispatcher skeleton behaviour. Every emitted envelope is also written to --emit so that
// scripts/verify-emitted-events.mjs can validate it with the TypeScript decodeEvent.
#include <fstream>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "diorama/Dispatcher.hpp"
#include "diorama/Engine.hpp"
#include "diorama/WorldStore.hpp"
#include "diorama/protocol.hpp"
#include "harness.hpp"

namespace {

using diorama::json::Value;
namespace protocol = diorama::protocol;

class RecordingSink final : public diorama::MessageSink {
 public:
  void onEvent(std::string envelopeJson) override { events.push_back(std::move(envelopeJson)); }
  void onLog(diorama::LogLevel level, std::string_view message) override { logs.emplace_back(level, message); }

  std::vector<std::string> events;
  std::vector<std::pair<diorama::LogLevel, std::string>> logs;

  Value eventMsg(std::size_t i) const { return protocol::decodeEvent(events.at(i)).value.msg; }
  std::size_t warnings() const {
    std::size_t n = 0;
    for (const auto& l : logs) n += l.first == diorama::LogLevel::Warn ? 1 : 0;
    return n;
  }
  std::size_t errors() const {
    std::size_t n = 0;
    for (const auto& l : logs) n += l.first == diorama::LogLevel::Error ? 1 : 0;
    return n;
  }
};

void appendEmitted(const diorama::test::Context& ctx, const RecordingSink& sink) {
  if (ctx.emitPath.empty()) return;
  std::ofstream out(ctx.emitPath, std::ios::app);
  for (const std::string& e : sink.events) out << e << "\n";
}

std::string envelope(const Value& msg, std::uint64_t seq) { return protocol::encodeCommand(msg, seq); }

}  // namespace

DIORAMA_TEST(engine_skeleton_behaviour) {
  if (!ctx.emitPath.empty()) std::ofstream(ctx.emitPath, std::ios::trunc).flush();

  auto sink = std::make_shared<RecordingSink>();
  diorama::EngineConfig config;
  config.validateOutgoingEvents = true;
  auto engine = diorama::createEngine(sink, config);

  // ready
  engine->start();
  engine->start();  // idempotent
  ctx.check(sink->events.size() == 1, "start() emits exactly one ready");
  protocol::DecodeResult<protocol::Envelope> ready = protocol::decodeEvent(sink->events.at(0));
  ctx.check(ready.ok && ready.value.seq == 0 && ready.value.type() == "ready" &&
                ready.value.msg.find("engine")->find("kind")->asString() == "native" &&
                ready.value.msg.find("engine")->find("name")->asString() == "diorama-native",
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
  const Value fixture = diorama::test::loadFixture(ctx, "decode-command.json");
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
    engine->postMessage(c.find("input")->asString());
    const std::size_t newEvents = sink->events.size() - eventsBefore;

    if (type == "request") {
      Value decoded = protocol::decodeCommand(c.find("input")->asString()).value.msg;
      bool ok = newEvents == 1;
      if (ok) {
        Value res = sink->eventMsg(eventsBefore);
        ok = res.find("type")->asString() == "response" &&
             res.find("requestId")->asString() == decoded.find("requestId")->asString() &&
             !res.find("ok")->asBool() && res.find("error")->find("code")->asString() == "unsupported" &&
             res.find("error")->find("message")->asString().find(decoded.find("method")->asString()) !=
                 std::string::npos;
      }
      ctx.check(ok, "[" + name + "] request -> unsupported response");
    } else {
      ctx.check(newEvents == 0, "[" + name + "] fire-and-forget emits no event (got " + std::to_string(newEvents) + ")");
      ctx.check(sink->warnings() == warningsBefore + 1, "[" + name + "] logs one not-implemented warning");
      const std::string& lastLog = sink->logs.back().second;
      ctx.check(lastLog.find("\"" + type + "\"") != std::string::npos, "[" + name + "] warning names the command");
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
  engine->postEnvelope(diorama::json::parse(envelope(Value::object({{"type", "request"},
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

  // tap is logged, shutdown stops processing
  engine->tap(10, 20);
  ctx.check(sink->logs.back().second.find("tap(10, 20)") != std::string::npos, "tap logged as not implemented");
  engine->shutdown();
  const std::size_t afterShutdown = sink->events.size();
  engine->postMessage("not json");
  ctx.check(sink->events.size() == afterShutdown, "messages after shutdown are ignored");

  appendEmitted(ctx, *sink);
}

DIORAMA_TEST(dispatcher_drops_invalid_outgoing_events) {
  RecordingSink sink;
  auto world = diorama::createWorldStore();
  diorama::Subsystems subsystems;
  subsystems.world = world.get();
  diorama::DispatcherOptions options;
  options.validateOutgoingEvents = true;
  diorama::Dispatcher dispatcher(sink, subsystems, options);

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
