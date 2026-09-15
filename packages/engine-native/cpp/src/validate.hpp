// Internal: port of packages/protocol/src/internal/validate.ts.
//
// A Check returns std::nullopt when valid, or an error string prefixed with
// the JSON path — the exact strings the TypeScript combinators produce.
// `const Value*` == nullptr models JS `undefined` (absent field).
#pragma once

#include <cstddef>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama::validate {

using json::Value;
using Error = std::optional<std::string>;
using Check = std::function<Error(const Value* value, const std::string& path)>;
using Fields = std::vector<std::pair<std::string, Check>>;

/// Maximum nesting depth accepted for arbitrary JSON payloads (`MAX_JSON_DEPTH`).
inline constexpr int kMaxJsonDepth = 64;

bool isRecord(const Value* v);
/// `describe()` in validate.ts: null | array | Infinity | typeof.
std::string describe(const Value* v);
std::string fail(const std::string& path, std::string_view expected, const Value* v);
/// `JSON.stringify(value)`, or "undefined" for an absent value.
std::string stringifyOrUndefined(const Value* v);

// Primitive checks (validate.ts names; `string` -> `str`, `json` -> `jsonValue`).
Error str(const Value* v, const std::string& p);
Error nonEmptyString(const Value* v, const std::string& p);
Error boolean(const Value* v, const std::string& p);
Error number(const Value* v, const std::string& p);
Error integer(const Value* v, const std::string& p);
Error positiveNumber(const Value* v, const std::string& p);
Error nonNegativeInteger(const Value* v, const std::string& p);
Error hexColorNumber(const Value* v, const std::string& p);
Error jsonValue(const Value* v, const std::string& p);

Check range(double min, double max);
/// `range(0, Number.MAX_VALUE)`.
Check nonNegativeNumber();
Check oneOf(std::vector<std::string_view> values);
Check literal(double value);
Check array(Check item, std::optional<std::size_t> min = std::nullopt);
Check tuple(std::vector<Check> items);
Check object(Fields required, Fields optional = {});
Check nullable(Check check);
Check anyOf(std::vector<Check> checks);
Check record(Check value);
Check discriminated(std::string key, Fields variants);

template <class E>
Check oneOfEnum() {
  const auto& names = EnumNames<E>::values;
  return oneOf(std::vector<std::string_view>(names.begin(), names.end()));
}

struct RunResult {
  bool ok = true;
  std::string error;
};

RunResult run(const Check& check, const Value* value, const std::string& path = "$");

}  // namespace maprama::validate
