#include "validate.hpp"

#include <cfloat>
#include <cmath>

namespace maprama::validate {

namespace {

constexpr double kMaxSafeInteger = 9007199254740991.0;

bool isFiniteNumber(const Value* v) { return v != nullptr && v->isNumber() && std::isfinite(v->asNumber()); }

/// `Number.isInteger(v)`.
bool isInteger(const Value* v) { return isFiniteNumber(v) && std::trunc(v->asNumber()) == v->asNumber(); }

/// `Number.isSafeInteger(v)`.
bool isSafeInteger(const Value* v) { return isInteger(v) && std::fabs(v->asNumber()) <= kMaxSafeInteger; }

Error jsonAt(const Value* v, const std::string& p, int depth) {
  if (depth > kMaxJsonDepth) return p + ": JSON value nested deeper than " + std::to_string(kMaxJsonDepth);
  if (v == nullptr) return fail(p, "JSON value", v);
  switch (v->type()) {
    case json::Type::Null:
    case json::Type::String:
    case json::Type::Boolean:
      return std::nullopt;
    case json::Type::Number:
      return std::isfinite(v->asNumber()) ? Error() : fail(p, "finite number", v);
    case json::Type::Array: {
      const auto& items = v->items();
      for (std::size_t i = 0; i < items.size(); ++i) {
        if (Error err = jsonAt(&items[i], p + "[" + std::to_string(i) + "]", depth + 1)) return err;
      }
      return std::nullopt;
    }
    case json::Type::Object:
      for (const json::Member& m : v->members()) {
        if (Error err = jsonAt(&m.value, p + "[" + json::quote(m.key) + "]", depth + 1)) return err;
      }
      return std::nullopt;
  }
  return fail(p, "JSON value", v);
}

}  // namespace

bool isRecord(const Value* v) { return v != nullptr && v->isObject(); }

std::string describe(const Value* v) {
  if (v == nullptr) return "undefined";
  switch (v->type()) {
    case json::Type::Null: return "null";
    case json::Type::Array: return "array";
    case json::Type::Number: return std::isfinite(v->asNumber()) ? "number" : json::numberToString(v->asNumber());
    case json::Type::String: return "string";
    case json::Type::Boolean: return "boolean";
    case json::Type::Object: return "object";
  }
  return "undefined";
}

std::string fail(const std::string& path, std::string_view expected, const Value* v) {
  std::string out = path;
  out += ": expected ";
  out += expected;
  out += ", got ";
  out += describe(v);
  return out;
}

std::string stringifyOrUndefined(const Value* v) { return v == nullptr ? "undefined" : json::stringify(*v); }

Error str(const Value* v, const std::string& p) {
  return (v != nullptr && v->isString()) ? Error() : fail(p, "string", v);
}

Error nonEmptyString(const Value* v, const std::string& p) {
  return (v != nullptr && v->isString() && !v->asString().empty()) ? Error() : fail(p, "non-empty string", v);
}

Error boolean(const Value* v, const std::string& p) {
  return (v != nullptr && v->isBoolean()) ? Error() : fail(p, "boolean", v);
}

Error number(const Value* v, const std::string& p) { return isFiniteNumber(v) ? Error() : fail(p, "finite number", v); }

Error integer(const Value* v, const std::string& p) { return isInteger(v) ? Error() : fail(p, "integer", v); }

Error positiveNumber(const Value* v, const std::string& p) {
  return (isFiniteNumber(v) && v->asNumber() > 0) ? Error() : fail(p, "positive number", v);
}

Error nonNegativeInteger(const Value* v, const std::string& p) {
  return (isSafeInteger(v) && v->asNumber() >= 0) ? Error() : fail(p, "non-negative integer", v);
}

Error hexColorNumber(const Value* v, const std::string& p) {
  return (isInteger(v) && v->asNumber() >= 0 && v->asNumber() <= 0xFFFFFF)
             ? Error()
             : fail(p, "integer color in [0x000000, 0xFFFFFF]", v);
}

Error jsonValue(const Value* v, const std::string& p) { return jsonAt(v, p, 0); }

Check range(double min, double max) {
  std::string expected = "number in [" + json::numberToString(min) + ", " + json::numberToString(max) + "]";
  return [min, max, expected](const Value* v, const std::string& p) -> Error {
    return (isFiniteNumber(v) && v->asNumber() >= min && v->asNumber() <= max) ? Error() : fail(p, expected, v);
  };
}

Check nonNegativeNumber() { return range(0, DBL_MAX); }

Check oneOf(std::vector<std::string_view> values) {
  std::string list;
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i > 0) list += " | ";
    list += json::quote(values[i]);
  }
  return [values, list](const Value* v, const std::string& p) -> Error {
    if (v != nullptr && v->isString()) {
      for (std::string_view candidate : values) {
        if (candidate == v->asString()) return std::nullopt;
      }
    }
    return p + ": expected one of " + list + ", got " +
           ((v != nullptr && v->isString()) ? json::quote(v->asString()) : describe(v));
  };
}

Check literal(double value) {
  std::string message = ": expected " + json::numberToString(value);
  return [value, message](const Value* v, const std::string& p) -> Error {
    return (v != nullptr && v->isNumber() && v->asNumber() == value) ? Error() : p + message;
  };
}

Check array(Check item, std::optional<std::size_t> min) {
  return [item = std::move(item), min](const Value* v, const std::string& p) -> Error {
    if (v == nullptr || !v->isArray()) return fail(p, "array", v);
    const auto& items = v->items();
    if (min.has_value() && items.size() < *min) {
      return p + ": expected at least " + std::to_string(*min) + " item(s), got " + std::to_string(items.size());
    }
    for (std::size_t i = 0; i < items.size(); ++i) {
      if (Error err = item(&items[i], p + "[" + std::to_string(i) + "]")) return err;
    }
    return std::nullopt;
  };
}

Check tuple(std::vector<Check> checks) {
  return [checks = std::move(checks)](const Value* v, const std::string& p) -> Error {
    const std::string n = std::to_string(checks.size());
    if (v == nullptr || !v->isArray()) return fail(p, "array of length " + n, v);
    const auto& items = v->items();
    if (items.size() != checks.size()) {
      return p + ": expected array of length " + n + ", got length " + std::to_string(items.size());
    }
    for (std::size_t i = 0; i < checks.size(); ++i) {
      if (Error err = checks[i](&items[i], p + "[" + std::to_string(i) + "]")) return err;
    }
    return std::nullopt;
  };
}

Check object(Fields required, Fields optional) {
  return [required = std::move(required), optional = std::move(optional)](const Value* v,
                                                                           const std::string& p) -> Error {
    if (!isRecord(v)) return fail(p, "object", v);
    for (const auto& [key, check] : required) {
      const Value* value = v->find(key);
      if (value == nullptr) return p + "." + key + ": required field is missing";
      if (Error err = check(value, p + "." + key)) return err;
    }
    for (const auto& [key, check] : optional) {
      const Value* value = v->find(key);
      if (value == nullptr) continue;
      if (Error err = check(value, p + "." + key)) return err;
    }
    return std::nullopt;
  };
}

Check nullable(Check check) {
  return [check = std::move(check)](const Value* v, const std::string& p) -> Error {
    return (v != nullptr && v->isNull()) ? Error() : check(v, p);
  };
}

Check anyOf(std::vector<Check> checks) {
  return [checks = std::move(checks)](const Value* v, const std::string& p) -> Error {
    Error last = p + ": no alternatives";
    for (const Check& check : checks) {
      last = check(v, p);
      if (!last.has_value()) return std::nullopt;
    }
    return last;
  };
}

Check record(Check value) {
  return [value = std::move(value)](const Value* v, const std::string& p) -> Error {
    if (!isRecord(v)) return fail(p, "object", v);
    for (const json::Member& m : v->members()) {
      if (Error err = value(&m.value, p + "[" + json::quote(m.key) + "]")) return err;
    }
    return std::nullopt;
  };
}

Check discriminated(std::string key, Fields variants) {
  std::string known;
  for (std::size_t i = 0; i < variants.size(); ++i) {
    if (i > 0) known += " | ";
    known += json::quote(variants[i].first);
  }
  return [key = std::move(key), variants = std::move(variants), known](const Value* v,
                                                                       const std::string& p) -> Error {
    if (!isRecord(v)) return fail(p, "object", v);
    const Value* tag = v->find(key);
    if (tag == nullptr || !tag->isString()) return fail(p + "." + key, "string", tag);
    for (const auto& [name, check] : variants) {
      if (name == tag->asString()) return check(v, p);
    }
    return p + "." + key + ": unknown " + key + " " + json::quote(tag->asString()) + " (expected one of " + known +
           ")";
  };
}

RunResult run(const Check& check, const Value* value, const std::string& path) {
  Error err = check(value, path);
  if (!err.has_value()) return RunResult{};
  return RunResult{false, std::move(*err)};
}

}  // namespace maprama::validate
