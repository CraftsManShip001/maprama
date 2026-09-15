#include "maprama/protocol.hpp"

#include <stdexcept>
#include <utility>

#include "schemas.hpp"
#include "validate.hpp"

namespace maprama::protocol {

namespace {

const std::string kEmpty;

template <class T>
DecodeResult<T> failure(std::string error) {
  DecodeResult<T> result;
  result.error = std::move(error);
  return result;
}

DecodeResult<Envelope> decodeParsed(json::Value parsed, std::string_view kind, const validate::Check& msgCheck) {
  if (!parsed.isObject()) return failure<Envelope>("$: expected envelope object");

  const json::Value* v = parsed.find("v");
  if (v == nullptr || !v->isNumber() || v->asNumber() != kProtocolVersion) {
    return failure<Envelope>("$.v: unsupported protocol version " + validate::stringifyOrUndefined(v) +
                             " (expected " + std::to_string(kProtocolVersion) + ")");
  }

  const json::Value* k = parsed.find("kind");
  if (k == nullptr || !k->isString() || k->asString() != kind) {
    return failure<Envelope>("$.kind: expected " + json::quote(kind) + ", got " + validate::stringifyOrUndefined(k));
  }

  const json::Value* seq = parsed.find("seq");
  validate::RunResult seqResult = validate::run(validate::nonNegativeInteger, seq, "$.seq");
  if (!seqResult.ok) return failure<Envelope>(std::move(seqResult.error));

  json::Value* msg = parsed.find("msg");
  if (msg == nullptr) return failure<Envelope>("$.msg: required field is missing");
  validate::RunResult msgResult = validate::run(msgCheck, msg, "$.msg");
  if (!msgResult.ok) return failure<Envelope>(std::move(msgResult.error));

  DecodeResult<Envelope> result;
  result.ok = true;
  result.value.seq = static_cast<std::uint64_t>(seq->asNumber());
  result.value.msg = std::move(*msg);
  return result;
}

DecodeResult<Envelope> decodeText(std::string_view data, std::string_view kind, const validate::Check& msgCheck) {
  json::ParseResult parsed = json::parse(data);
  if (!parsed.ok) return failure<Envelope>("$: invalid JSON: " + parsed.error);
  return decodeParsed(std::move(parsed.value), kind, msgCheck);
}

ValidationResult toValidation(validate::RunResult r) { return ValidationResult{r.ok, std::move(r.error)}; }

std::string encode(const char* fn, std::string_view kind, const json::Value& msg, std::uint64_t seq) {
  if (seq > kMaxSafeInteger) {
    throw std::range_error(std::string(fn) + ": seq must be a non-negative safe integer, got " + std::to_string(seq));
  }
  std::string out = "{\"v\":" + std::to_string(kProtocolVersion) + ",\"seq\":" + std::to_string(seq) +
                    ",\"kind\":" + json::quote(kind) + ",\"msg\":";
  out += json::stringify(msg);
  out.push_back('}');
  return out;
}

}  // namespace

const std::string& Envelope::type() const {
  const json::Value* t = msg.find("type");
  return t != nullptr ? t->asString() : kEmpty;
}

DecodeResult<CommandEnvelope> decodeCommand(std::string_view data) {
  return decodeText(data, "cmd", schemas::engineCommand());
}

DecodeResult<CommandEnvelope> decodeCommandValue(json::Value envelope) {
  return decodeParsed(std::move(envelope), "cmd", schemas::engineCommand());
}

DecodeResult<EventEnvelope> decodeEvent(std::string_view data) {
  return decodeText(data, "evt", schemas::engineEvent());
}

DecodeResult<EventEnvelope> decodeEventValue(json::Value envelope) {
  return decodeParsed(std::move(envelope), "evt", schemas::engineEvent());
}

ValidationResult validateEngineCommand(const json::Value& message) {
  return toValidation(validate::run(schemas::engineCommand(), &message));
}

ValidationResult validateEngineEvent(const json::Value& message) {
  return toValidation(validate::run(schemas::engineEvent(), &message));
}

ValidationResult validateWorldData(const json::Value& value) {
  return toValidation(validate::run(schemas::worldData(), &value));
}

ValidationResult validateWorldSource(const json::Value& value) {
  return toValidation(validate::run(schemas::worldSource(), &value));
}

ValidationResult validateThemeSpec(const json::Value& value) {
  return toValidation(validate::run(schemas::themeSpec(), &value));
}

ValidationResult validateThemePreset(const json::Value& value) {
  return toValidation(validate::run(schemas::themePreset(), &value));
}

std::string encodeCommand(const json::Value& command, std::uint64_t seq) {
  return encode("encodeCommand", "cmd", command, seq);
}

std::string encodeEvent(const json::Value& event, std::uint64_t seq) {
  return encode("encodeEvent", "evt", event, seq);
}

}  // namespace maprama::protocol
