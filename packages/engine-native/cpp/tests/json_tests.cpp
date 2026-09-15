// JS-compatible JSON parsing and formatting.
#include <string>

#include "maprama/json.hpp"
#include "harness.hpp"

namespace {
using maprama::json::Value;
namespace json = maprama::json;
}  // namespace

MAPRAMA_TEST(json_number_formatting_matches_js) {
  const Value fixture = maprama::test::loadFixture(ctx, "json-format.json");
  for (const Value& c : fixture.find("numbers")->items()) {
    const std::string& text = c.find("text")->asString();
    json::ParseResult parsed = json::parse(text);
    if (!ctx.check(parsed.ok && parsed.value.isNumber(), "parse number " + text)) continue;
    const std::string asString = json::numberToString(parsed.value.asNumber());
    ctx.check(asString == c.find("string")->asString(),
              "String(" + text + "): expected " + c.find("string")->asString() + ", got " + asString);
    const std::string asJson = json::stringify(parsed.value);
    ctx.check(asJson == c.find("json")->asString(),
              "JSON.stringify(" + text + "): expected " + c.find("json")->asString() + ", got " + asJson);
  }
}

MAPRAMA_TEST(json_value_stringify_matches_js) {
  const Value fixture = maprama::test::loadFixture(ctx, "json-format.json");
  for (const Value& c : fixture.find("values")->items()) {
    const std::string& text = c.find("text")->asString();
    json::ParseResult parsed = json::parse(text);
    if (!ctx.check(parsed.ok, "parse " + text + ": " + parsed.error)) continue;
    const std::string out = json::stringify(parsed.value);
    ctx.check(out == c.find("json")->asString(),
              "JSON.stringify(JSON.parse(" + text + ")): expected " + c.find("json")->asString() + ", got " + out);
  }
}

MAPRAMA_TEST(json_parser_limits_and_ordering) {
  const auto nested = [](std::size_t depth) { return std::string(depth, '[') + std::string(depth, ']'); };
  ctx.check(json::parse(nested(json::kDefaultMaxDepth)).ok, "nesting at the depth limit parses");
  json::ParseResult tooDeep = json::parse(nested(json::kDefaultMaxDepth + 1));
  ctx.check(!tooDeep.ok && tooDeep.error.find("Maximum nesting depth") != std::string::npos,
            "nesting beyond the depth limit fails cleanly: " + tooDeep.error);

  Value obj = Value::object();
  obj.set("b", 1);
  obj.set("10", 2);
  obj.set("a", 3);
  obj.set("2", 4);
  obj.set("b", 5);
  ctx.check(json::stringify(obj) == R"({"2":4,"10":2,"b":5,"a":3})", "Value::set keeps JS own-key order");

  // Large objects use the hashed duplicate-key path.
  std::string big = "{";
  for (int i = 0; i < 40; ++i) big += "\"k" + std::to_string(i) + "\":" + std::to_string(i) + ",";
  big += "\"k3\":99}";
  json::ParseResult bigParsed = json::parse(big);
  ctx.check(bigParsed.ok && bigParsed.value.members().size() == 40 && bigParsed.value.find("k3")->asNumber() == 99 &&
                bigParsed.value.members()[3].key == "k3",
            "duplicate key in a large object keeps first position and last value");

  ctx.check(!json::parse("").ok, "empty input rejected");
  ctx.check(!json::parse("\"\\ud800").ok, "unterminated string after escape rejected");
  ctx.check(json::quote(std::string("a\0b", 3)) == "\"a\\u0000b\"", "quote escapes NUL");
}
