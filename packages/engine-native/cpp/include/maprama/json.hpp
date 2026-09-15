// Maprama native core — minimal JSON value with JavaScript semantics.
//
// The core must decode envelopes *identically* to `decodeCommand` in
// `@maprama/protocol`, including error strings. That requires JS semantics
// that off-the-shelf C++ JSON libraries do not provide:
//   - every number is an IEEE-754 double; `1e400` parses to Infinity (V8
//     `JSON.parse` accepts it) instead of failing;
//   - object members keep JS own-property order: array-index keys ascending
//     first, then string keys in insertion order; duplicate keys keep the
//     first position and the last value;
//   - `stringify` / `quote` / `numberToString` match `JSON.stringify` and
//     `String(number)` byte for byte (lone UTF-16 surrogates are carried as
//     WTF-8 and re-escaped as `\udXXX`).
//
// Strings are UTF-8 (WTF-8 for lone surrogates). Input bytes >= 0x80 are
// copied through without UTF-8 validation (JSI strings are always valid).
#pragma once

#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace maprama::json {

enum class Type : std::uint8_t { Null, Boolean, Number, String, Array, Object };

struct Member;

/// A JSON value. Default-constructed value is `null`.
///
/// The converting constructors are defined after `Member` (below): under C++20, libc++'s constexpr
/// `std::vector<Member>` needs `Member` to be complete wherever a constructor body may have to destroy
/// `members_`, and in-class bodies are compiled at the end of `Value`, before `Member` exists.
class Value {
 public:
  Value() = default;
  Value(std::nullptr_t);  // NOLINT(google-explicit-constructor)
  Value(bool b);  // NOLINT
  template <class T, std::enable_if_t<std::is_arithmetic_v<T> && !std::is_same_v<T, bool>, int> = 0>
  Value(T n);  // NOLINT
  Value(const char* s);  // NOLINT
  Value(std::string s);  // NOLINT
  Value(std::string_view s);  // NOLINT

  static Value array();
  static Value array(std::initializer_list<Value> items);
  static Value object();
  /// Builds an object; later duplicate keys replace earlier values (JS semantics).
  static Value object(std::initializer_list<std::pair<std::string, Value>> members);

  Type type() const { return type_; }
  bool isNull() const { return type_ == Type::Null; }
  bool isBoolean() const { return type_ == Type::Boolean; }
  bool isNumber() const { return type_ == Type::Number; }
  bool isString() const { return type_ == Type::String; }
  bool isArray() const { return type_ == Type::Array; }
  bool isObject() const { return type_ == Type::Object; }

  /// Accessors; calling one for the wrong type returns a default (false / 0 / empty).
  bool asBool() const { return type_ == Type::Boolean && bool_; }
  double asNumber() const { return type_ == Type::Number ? number_ : 0.0; }
  const std::string& asString() const;

  const std::vector<Value>& items() const { return items_; }
  std::vector<Value>& items() { return items_; }
  const std::vector<Member>& members() const { return members_; }

  /// Own member lookup (nullptr when absent or not an object).
  const Value* find(std::string_view key) const;
  Value* find(std::string_view key);

  /// Sets a member with JS `CreateDataProperty` ordering. Converts a non-object to an empty object first.
  Value& set(std::string key, Value value);
  /// Appends to an array. Converts a non-array to an empty array first.
  Value& push(Value value);

  friend class Parser;

 private:
  Type type_ = Type::Null;
  bool bool_ = false;
  double number_ = 0.0;
  std::string string_;
  std::vector<Value> items_;
  std::vector<Member> members_;
};

struct Member {
  std::string key;
  Value value;
};

inline Value::Value(std::nullptr_t) {}
inline Value::Value(bool b) : type_(Type::Boolean), bool_(b) {}
template <class T, std::enable_if_t<std::is_arithmetic_v<T> && !std::is_same_v<T, bool>, int>>
inline Value::Value(T n) : type_(Type::Number), number_(static_cast<double>(n)) {}
inline Value::Value(const char* s) : type_(Type::String), string_(s) {}
inline Value::Value(std::string s) : type_(Type::String), string_(std::move(s)) {}
inline Value::Value(std::string_view s) : type_(Type::String), string_(s) {}

/// Default maximum container nesting accepted by `parse` (V8 has no fixed limit; see DESIGN.md §6.4).
inline constexpr std::size_t kDefaultMaxDepth = 512;

struct ParseResult {
  bool ok = false;
  Value value;
  /// Human-readable message (not V8-identical) including the byte offset.
  std::string error;
};

/// Strict RFC 8259 parse with `JSON.parse` value semantics. Never throws.
ParseResult parse(std::string_view text, std::size_t maxDepth = kDefaultMaxDepth);

/// `JSON.stringify(value)` (compact). Non-finite numbers serialise as `null`.
std::string stringify(const Value& value);

/// `JSON.stringify(string)`.
std::string quote(std::string_view utf8);

/// `String(number)` (ECMAScript Number::toString, radix 10).
std::string numberToString(double number);

/// True when `key` is a canonical array index ("0".."4294967294"), which JS orders first.
bool isArrayIndexKey(std::string_view key, std::uint32_t* index = nullptr);

}  // namespace maprama::json
