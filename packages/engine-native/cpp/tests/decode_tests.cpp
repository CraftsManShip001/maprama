// decodeCommand / decodeEvent conformance against golden results from @maprama/protocol.
#include <string>

#include "maprama/protocol.hpp"
#include "harness.hpp"

namespace {

using maprama::json::Value;
namespace json = maprama::json;
namespace protocol = maprama::protocol;

const std::string kInvalidJsonPrefix = "$: invalid JSON: ";

bool startsWith(const std::string& s, const std::string& prefix) { return s.compare(0, prefix.size(), prefix) == 0; }

void runDecodeFixture(maprama::test::Context& ctx, const char* file,
                      protocol::DecodeResult<protocol::Envelope> (*decodeText)(std::string_view),
                      protocol::DecodeResult<protocol::Envelope> (*decodeValue)(Value)) {
  const Value fixture = maprama::test::loadFixture(ctx, file);
  const auto& cases = fixture.find("cases")->items();
  ctx.check(cases.size() > 100, std::string(file) + " has cases");
  long valid = 0;
  long invalidJson = 0;
  for (const Value& c : cases) {
    const std::string& name = c.find("name")->asString();
    const std::string& input = c.find("input")->asString();
    const bool expectOk = c.find("ok")->asBool();
    protocol::DecodeResult<protocol::Envelope> r = decodeText(input);

    if (expectOk) {
      ++valid;
      const bool same = r.ok && static_cast<double>(r.value.seq) == c.find("seq")->asNumber() &&
                        r.value.type() == c.find("type")->asString();
      ctx.check(same, std::string(file) + " [" + name + "]: expected ok, got " +
                          (r.ok ? "ok with seq/type mismatch" : "error " + r.error));
    } else {
      const std::string& expected = c.find("error")->asString();
      const Value* prefixOnly = c.find("errorPrefixOnly");
      if (prefixOnly != nullptr && prefixOnly->asBool()) {
        ++invalidJson;
        ctx.check(!r.ok && startsWith(r.error, kInvalidJsonPrefix),
                  std::string(file) + " [" + name + "]: expected invalid JSON, got " +
                      (r.ok ? std::string("ok") : r.error));
        continue;
      }
      ctx.check(!r.ok && r.error == expected,
                std::string(file) + " [" + name + "]: expected error\n      " + maprama::test::truncate(expected, 400) +
                    "\n      got\n      " + (r.ok ? std::string("ok") : maprama::test::truncate(r.error, 400)));
    }

    // Object path (pre-parsed envelope) must agree with the text path whenever the text is valid JSON.
    json::ParseResult parsed = json::parse(input);
    if (parsed.ok) {
      protocol::DecodeResult<protocol::Envelope> v = decodeValue(std::move(parsed.value));
      ctx.check(v.ok == r.ok && v.error == r.error, std::string(file) + " [" + name + "]: value path disagrees");
    }
  }
  ctx.check(valid > 0 && invalidJson > 0, std::string(file) + " covers valid and invalid-JSON cases");
}

}  // namespace

MAPRAMA_TEST(decode_command_conformance) {
  runDecodeFixture(ctx, "decode-command.json", &protocol::decodeCommand, &protocol::decodeCommandValue);
}

MAPRAMA_TEST(decode_event_conformance) {
  runDecodeFixture(ctx, "decode-event.json", &protocol::decodeEvent, &protocol::decodeEventValue);
}

MAPRAMA_TEST(encode_roundtrip) {
  const Value msg = Value::object({{"type", "cancelTravel"}, {"characterId", "player"}});
  const std::string text = protocol::encodeCommand(msg, 42);
  ctx.check(text == R"({"v":1,"seq":42,"kind":"cmd","msg":{"type":"cancelTravel","characterId":"player"}})",
            "encodeCommand output: " + text);
  protocol::DecodeResult<protocol::Envelope> r = protocol::decodeCommand(text);
  ctx.check(r.ok && r.value.seq == 42 && r.value.type() == "cancelTravel", "encodeCommand round-trips");
  ctx.check(!protocol::decodeEvent(text).ok, "command envelope is not an event");

  bool threw = false;
  try {
    (void)protocol::encodeEvent(Value::object({{"type", "ready"}}), protocol::kMaxSafeInteger + 1);
  } catch (const std::range_error& e) {
    threw = std::string(e.what()) == "encodeEvent: seq must be a non-negative safe integer, got 9007199254740992";
  }
  ctx.check(threw, "encodeEvent rejects unsafe seq with the TS message");
}
