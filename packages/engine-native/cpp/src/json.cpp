#include "diorama/json.hpp"

#include <algorithm>
#include <clocale>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unordered_map>

namespace diorama::json {

namespace {

const std::string kEmptyString;

bool isJsonWhitespace(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }
bool isDigit(char c) { return c >= '0' && c <= '9'; }

int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

void appendUtf8(std::string& out, std::uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {  // includes lone surrogates (WTF-8)
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

/// Replaces '.' with the C locale's decimal point so strtod/snprintf agree with JSON text.
char localeDecimalPoint() {
  const lconv* lc = std::localeconv();
  return (lc != nullptr && lc->decimal_point != nullptr && lc->decimal_point[0] != '\0') ? lc->decimal_point[0]
                                                                                           : '.';
}

double toDouble(std::string text) {
  const char dp = localeDecimalPoint();
  if (dp != '.') std::replace(text.begin(), text.end(), '.', dp);
  return std::strtod(text.c_str(), nullptr);
}

/// Orders object members like JS own-property keys: array indices ascending, then insertion order.
void orderMembersJs(std::vector<Member>& members) {
  bool anyIndex = false;
  for (const Member& m : members) {
    if (isArrayIndexKey(m.key)) {
      anyIndex = true;
      break;
    }
  }
  if (!anyIndex) return;
  std::stable_sort(members.begin(), members.end(), [](const Member& a, const Member& b) {
    std::uint32_t ia = 0;
    std::uint32_t ib = 0;
    const bool aIdx = isArrayIndexKey(a.key, &ia);
    const bool bIdx = isArrayIndexKey(b.key, &ib);
    if (aIdx && bIdx) return ia < ib;
    return aIdx && !bIdx;
  });
}

}  // namespace

// ---------------------------------------------------------------------------
// Value
// ---------------------------------------------------------------------------

Value Value::array() {
  Value v;
  v.type_ = Type::Array;
  return v;
}

Value Value::array(std::initializer_list<Value> items) {
  Value v = array();
  v.items_.assign(items.begin(), items.end());
  return v;
}

Value Value::object() {
  Value v;
  v.type_ = Type::Object;
  return v;
}

Value Value::object(std::initializer_list<std::pair<std::string, Value>> members) {
  Value v = object();
  for (const auto& m : members) v.set(m.first, m.second);
  return v;
}

const std::string& Value::asString() const { return type_ == Type::String ? string_ : kEmptyString; }

const Value* Value::find(std::string_view key) const {
  if (type_ != Type::Object) return nullptr;
  for (const Member& m : members_) {
    if (m.key == key) return &m.value;
  }
  return nullptr;
}

Value* Value::find(std::string_view key) {
  return const_cast<Value*>(static_cast<const Value*>(this)->find(key));
}

Value& Value::set(std::string key, Value value) {
  if (type_ != Type::Object) *this = object();
  for (Member& m : members_) {
    if (m.key == key) {
      m.value = std::move(value);
      return m.value;
    }
  }
  std::uint32_t index = 0;
  if (isArrayIndexKey(key, &index)) {
    auto pos = std::find_if(members_.begin(), members_.end(), [index](const Member& m) {
      std::uint32_t other = 0;
      return !isArrayIndexKey(m.key, &other) || other > index;
    });
    return members_.insert(pos, Member{std::move(key), std::move(value)})->value;
  }
  members_.push_back(Member{std::move(key), std::move(value)});
  return members_.back().value;
}

Value& Value::push(Value value) {
  if (type_ != Type::Array) *this = array();
  items_.push_back(std::move(value));
  return items_.back();
}

bool isArrayIndexKey(std::string_view key, std::uint32_t* index) {
  if (key.empty() || key.size() > 10) return false;
  if (key.size() > 1 && key[0] == '0') return false;
  std::uint64_t n = 0;
  for (char c : key) {
    if (!isDigit(c)) return false;
    n = n * 10 + static_cast<std::uint64_t>(c - '0');
  }
  if (n >= 4294967295ULL) return false;
  if (index != nullptr) *index = static_cast<std::uint32_t>(n);
  return true;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
 public:
  Parser(std::string_view text, std::size_t maxDepth) : text_(text), maxDepth_(maxDepth) {}

  ParseResult run() {
    ParseResult result;
    skipWhitespace();
    if (!parseValue(result.value, 0)) {
      result.error = error_;
      result.value = Value();
      return result;
    }
    skipWhitespace();
    if (pos_ != text_.size()) {
      fail("Unexpected non-whitespace character after JSON");
      result.error = error_;
      result.value = Value();
      return result;
    }
    result.ok = true;
    return result;
  }

 private:
  bool fail(const char* message) {
    if (error_.empty()) error_ = std::string(message) + " at position " + std::to_string(pos_);
    return false;
  }

  void skipWhitespace() {
    while (pos_ < text_.size() && isJsonWhitespace(text_[pos_])) ++pos_;
  }

  bool parseValue(Value& out, std::size_t depth) {
    if (pos_ >= text_.size()) return fail("Unexpected end of JSON input");
    switch (text_[pos_]) {
      case '{':
        return parseObject(out, depth + 1);
      case '[':
        return parseArray(out, depth + 1);
      case '"':
        out.type_ = Type::String;
        return parseString(out.string_);
      case 't':
        return parseLiteral("true", out, Value(true));
      case 'f':
        return parseLiteral("false", out, Value(false));
      case 'n':
        return parseLiteral("null", out, Value());
      default:
        if (text_[pos_] == '-' || isDigit(text_[pos_])) {
          out.type_ = Type::Number;
          return parseNumber(out.number_);
        }
        return fail("Unexpected token");
    }
  }

  bool parseLiteral(std::string_view literal, Value& out, Value value) {
    if (text_.substr(pos_, literal.size()) != literal) return fail("Unexpected token");
    pos_ += literal.size();
    out = std::move(value);
    return true;
  }

  bool parseObject(Value& out, std::size_t depth) {
    if (depth > maxDepth_) return fail("Maximum nesting depth exceeded");
    out.type_ = Type::Object;
    ++pos_;  // '{'
    skipWhitespace();
    if (pos_ < text_.size() && text_[pos_] == '}') {
      ++pos_;
      return true;
    }
    std::unordered_map<std::string, std::size_t> index;  // built lazily for large objects
    std::vector<Member>& members = out.members_;
    for (;;) {
      skipWhitespace();
      if (pos_ >= text_.size()) return fail("Unexpected end of JSON input");
      if (text_[pos_] != '"') return fail("Expected property name");
      std::string key;
      if (!parseString(key)) return false;
      skipWhitespace();
      if (pos_ >= text_.size()) return fail("Unexpected end of JSON input");
      if (text_[pos_] != ':') return fail("Expected ':' after property name");
      ++pos_;
      skipWhitespace();
      Value child;
      if (!parseValue(child, depth)) return false;

      // Duplicate keys: keep first position, last value (CreateDataProperty).
      std::size_t existing = members.size();
      if (members.size() < 16) {
        for (std::size_t i = 0; i < members.size(); ++i) {
          if (members[i].key == key) {
            existing = i;
            break;
          }
        }
      } else {
        if (index.empty()) {
          for (std::size_t i = 0; i < members.size(); ++i) index.emplace(members[i].key, i);
        }
        auto it = index.find(key);
        if (it != index.end()) existing = it->second;
      }
      if (existing < members.size()) {
        members[existing].value = std::move(child);
      } else {
        if (!index.empty()) index.emplace(key, members.size());
        members.push_back(Member{std::move(key), std::move(child)});
      }

      skipWhitespace();
      if (pos_ >= text_.size()) return fail("Unexpected end of JSON input");
      if (text_[pos_] == ',') {
        ++pos_;
        continue;
      }
      if (text_[pos_] == '}') {
        ++pos_;
        orderMembersJs(members);
        return true;
      }
      return fail("Expected ',' or '}' after property value");
    }
  }

  bool parseArray(Value& out, std::size_t depth) {
    if (depth > maxDepth_) return fail("Maximum nesting depth exceeded");
    out.type_ = Type::Array;
    ++pos_;  // '['
    skipWhitespace();
    if (pos_ < text_.size() && text_[pos_] == ']') {
      ++pos_;
      return true;
    }
    for (;;) {
      skipWhitespace();
      out.items_.emplace_back();
      if (!parseValue(out.items_.back(), depth)) return false;
      skipWhitespace();
      if (pos_ >= text_.size()) return fail("Unexpected end of JSON input");
      if (text_[pos_] == ',') {
        ++pos_;
        continue;
      }
      if (text_[pos_] == ']') {
        ++pos_;
        return true;
      }
      return fail("Expected ',' or ']' after array element");
    }
  }

  bool readHex4(std::size_t at, std::uint32_t& out) const {
    if (at + 4 > text_.size()) return false;
    std::uint32_t v = 0;
    for (std::size_t i = 0; i < 4; ++i) {
      const int h = hexValue(text_[at + i]);
      if (h < 0) return false;
      v = (v << 4) | static_cast<std::uint32_t>(h);
    }
    out = v;
    return true;
  }

  bool parseString(std::string& out) {
    ++pos_;  // opening quote
    for (;;) {
      if (pos_ >= text_.size()) return fail("Unterminated string in JSON");
      const char c = text_[pos_];
      if (c == '"') {
        ++pos_;
        return true;
      }
      if (static_cast<unsigned char>(c) < 0x20) return fail("Bad control character in string literal");
      if (c != '\\') {
        out.push_back(c);
        ++pos_;
        continue;
      }
      if (pos_ + 1 >= text_.size()) return fail("Unterminated string in JSON");
      const char e = text_[pos_ + 1];
      pos_ += 2;
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          std::uint32_t cu = 0;
          if (!readHex4(pos_, cu)) return fail("Bad Unicode escape in JSON");
          pos_ += 4;
          if (cu >= 0xD800 && cu <= 0xDBFF && pos_ + 6 <= text_.size() && text_[pos_] == '\\' &&
              text_[pos_ + 1] == 'u') {
            std::uint32_t low = 0;
            if (readHex4(pos_ + 2, low) && low >= 0xDC00 && low <= 0xDFFF) {
              pos_ += 6;
              appendUtf8(out, 0x10000 + ((cu - 0xD800) << 10) + (low - 0xDC00));
              break;
            }
          }
          appendUtf8(out, cu);
          break;
        }
        default:
          pos_ -= 1;
          return fail("Bad escaped character in JSON");
      }
    }
  }

  bool parseNumber(double& out) {
    const std::size_t start = pos_;
    if (text_[pos_] == '-') ++pos_;
    if (pos_ >= text_.size()) return fail("No number after minus sign in JSON");
    if (text_[pos_] == '0') {
      ++pos_;
    } else if (isDigit(text_[pos_])) {
      while (pos_ < text_.size() && isDigit(text_[pos_])) ++pos_;
    } else {
      return fail("No number after minus sign in JSON");
    }
    if (pos_ < text_.size() && text_[pos_] == '.') {
      ++pos_;
      if (pos_ >= text_.size() || !isDigit(text_[pos_])) return fail("Unterminated fractional number in JSON");
      while (pos_ < text_.size() && isDigit(text_[pos_])) ++pos_;
    }
    if (pos_ < text_.size() && (text_[pos_] == 'e' || text_[pos_] == 'E')) {
      ++pos_;
      if (pos_ < text_.size() && (text_[pos_] == '+' || text_[pos_] == '-')) ++pos_;
      if (pos_ >= text_.size() || !isDigit(text_[pos_])) return fail("Exponent part is missing a number in JSON");
      while (pos_ < text_.size() && isDigit(text_[pos_])) ++pos_;
    }
    out = toDouble(std::string(text_.substr(start, pos_ - start)));
    return true;
  }

  std::string_view text_;
  std::size_t maxDepth_;
  std::size_t pos_ = 0;
  std::string error_;
};

ParseResult parse(std::string_view text, std::size_t maxDepth) { return Parser(text, maxDepth).run(); }

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

namespace {

bool roundTrips(const char* text, double value) { return std::strtod(text, nullptr) == value; }

/// Shortest round-trip decimal digits (no trailing zeros) and exponent n with value = 0.d1d2.. x 10^n.
void shortestDigits(double v, std::string& digits, int& n) {
  char buf[64];
  const char dp = localeDecimalPoint();
  for (int precision = 1; precision <= 17; ++precision) {
    std::snprintf(buf, sizeof buf, "%.*e", precision - 1, v);
    std::string mantissa;
    const char* p = buf;
    for (; *p != '\0' && *p != 'e'; ++p) {
      if (isDigit(*p)) mantissa.push_back(*p);
    }
    const int exp10 = std::atoi(p + 1);
    std::string candidate;
    int candidateExp = exp10;
    if (roundTrips(buf, v)) {
      candidate = mantissa;
    } else if (precision < 17) {
      // The correctly rounded neighbour can miss the (asymmetric) rounding interval at a power of two;
      // a digit string one ulp away in decimal may still round-trip.
      const unsigned long long m = std::strtoull(mantissa.c_str(), nullptr, 10);
      for (unsigned long long alt : {m + 1, m - 1}) {
        if (alt == 0) continue;
        std::string altDigits = std::to_string(alt);
        const int altExp = exp10 + static_cast<int>(altDigits.size()) - precision;
        std::string text = altDigits.substr(0, 1);
        if (altDigits.size() > 1) {
          text.push_back(dp);
          text += altDigits.substr(1);
        }
        text += "e" + std::to_string(altExp);
        if (roundTrips(text.c_str(), v)) {
          candidate = altDigits;
          candidateExp = altExp;
          break;
        }
      }
      if (candidate.empty()) continue;
    } else {
      candidate = mantissa;
    }
    while (candidate.size() > 1 && candidate.back() == '0') candidate.pop_back();
    digits = candidate;
    n = candidateExp + 1;
    return;
  }
}

}  // namespace

std::string numberToString(double v) {
  if (std::isnan(v)) return "NaN";
  if (v == 0) return "0";
  if (std::isinf(v)) return v < 0 ? "-Infinity" : "Infinity";
  std::string out;
  if (v < 0) {
    out.push_back('-');
    v = -v;
  }
  std::string digits;
  int n = 0;
  shortestDigits(v, digits, n);
  const int k = static_cast<int>(digits.size());
  if (k <= n && n <= 21) {
    out += digits;
    out.append(static_cast<std::size_t>(n - k), '0');
  } else if (0 < n && n <= 21) {
    out += digits.substr(0, static_cast<std::size_t>(n));
    out.push_back('.');
    out += digits.substr(static_cast<std::size_t>(n));
  } else if (-6 < n && n <= 0) {
    out += "0.";
    out.append(static_cast<std::size_t>(-n), '0');
    out += digits;
  } else {
    const int e = n - 1;
    out.push_back(digits[0]);
    if (k > 1) {
      out.push_back('.');
      out += digits.substr(1);
    }
    out.push_back('e');
    out.push_back(e < 0 ? '-' : '+');
    out += std::to_string(e < 0 ? -e : e);
  }
  return out;
}

std::string quote(std::string_view s) {
  static const char* kHex = "0123456789abcdef";
  std::string out;
  out.reserve(s.size() + 2);
  out.push_back('"');
  for (std::size_t i = 0; i < s.size(); ++i) {
    const auto c = static_cast<unsigned char>(s[i]);
    switch (c) {
      case '"': out += "\\\""; continue;
      case '\\': out += "\\\\"; continue;
      case '\b': out += "\\b"; continue;
      case '\f': out += "\\f"; continue;
      case '\n': out += "\\n"; continue;
      case '\r': out += "\\r"; continue;
      case '\t': out += "\\t"; continue;
      default: break;
    }
    if (c < 0x20) {
      out += "\\u00";
      out.push_back(kHex[c >> 4]);
      out.push_back(kHex[c & 0xF]);
      continue;
    }
    // WTF-8 lone surrogate: ED A0..BF 80..BF -> \udXXX (well-formed JSON.stringify).
    if (c == 0xED && i + 2 < s.size() && (static_cast<unsigned char>(s[i + 1]) & 0xE0) == 0xA0 &&
        (static_cast<unsigned char>(s[i + 2]) & 0xC0) == 0x80) {
      const std::uint32_t cu = 0xD000 | ((static_cast<unsigned char>(s[i + 1]) & 0x3Fu) << 6) |
                               (static_cast<unsigned char>(s[i + 2]) & 0x3Fu);
      out += "\\u";
      out.push_back(kHex[(cu >> 12) & 0xF]);
      out.push_back(kHex[(cu >> 8) & 0xF]);
      out.push_back(kHex[(cu >> 4) & 0xF]);
      out.push_back(kHex[cu & 0xF]);
      i += 2;
      continue;
    }
    out.push_back(static_cast<char>(c));
  }
  out.push_back('"');
  return out;
}

namespace {

void stringifyInto(std::string& out, const Value& v) {
  switch (v.type()) {
    case Type::Null:
      out += "null";
      return;
    case Type::Boolean:
      out += v.asBool() ? "true" : "false";
      return;
    case Type::Number:
      out += std::isfinite(v.asNumber()) ? numberToString(v.asNumber()) : "null";
      return;
    case Type::String:
      out += quote(v.asString());
      return;
    case Type::Array: {
      out.push_back('[');
      bool first = true;
      for (const Value& item : v.items()) {
        if (!first) out.push_back(',');
        first = false;
        stringifyInto(out, item);
      }
      out.push_back(']');
      return;
    }
    case Type::Object: {
      out.push_back('{');
      bool first = true;
      for (const Member& m : v.members()) {
        if (!first) out.push_back(',');
        first = false;
        out += quote(m.key);
        out.push_back(':');
        stringifyInto(out, m.value);
      }
      out.push_back('}');
      return;
    }
  }
}

}  // namespace

std::string stringify(const Value& value) {
  std::string out;
  stringifyInto(out, value);
  return out;
}

}  // namespace diorama::json
