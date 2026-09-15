#include "maprama/ThemeResolver.hpp"

#include <cstdlib>
#include <utility>

#include "theme_data.hpp"

namespace maprama {

namespace {

using json::Value;

const Value* member(const Value& object, std::string_view key) { return object.isObject() ? object.find(key) : nullptr; }

bool boolOr(const Value& object, std::string_view key, bool fallback) {
  const Value* v = member(object, key);
  return v != nullptr && v->isBoolean() ? v->asBool() : fallback;
}

std::optional<bool> optBool(const Value& object, std::string_view key) {
  const Value* v = member(object, key);
  return v != nullptr && v->isBoolean() ? std::optional<bool>(v->asBool()) : std::nullopt;
}

double numberOr(const Value& object, std::string_view key, double fallback) {
  const Value* v = member(object, key);
  return v != nullptr && v->isNumber() ? v->asNumber() : fallback;
}

std::uint32_t colorOr(const Value& object, std::string_view key, std::uint32_t fallback = 0) {
  const Value* v = member(object, key);
  return v != nullptr && v->isNumber() ? static_cast<std::uint32_t>(v->asNumber()) : fallback;
}

std::string stringOr(const Value& object, std::string_view key, std::string fallback = {}) {
  const Value* v = member(object, key);
  return v != nullptr && v->isString() ? v->asString() : std::move(fallback);
}

template <class E>
E enumOr(const Value& object, std::string_view key, E fallback) {
  const Value* v = member(object, key);
  if (v == nullptr || !v->isString()) return fallback;
  return parseEnum<E>(v->asString()).value_or(fallback);
}

/// Applies every member present in `o` (a full `TimeOfDayPreset` or a partial `CINE` entry).
void applyTime(TimeOfDayPreset& t, const Value& o) {
  t.fog = colorOr(o, "fog", t.fog);
  t.fogNear = numberOr(o, "fogNear", t.fogNear);
  t.fogFar = numberOr(o, "fogFar", t.fogFar);
  t.sun = colorOr(o, "sun", t.sun);
  t.sunI = numberOr(o, "sunI", t.sunI);
  t.hemiSky = colorOr(o, "hemiSky", t.hemiSky);
  t.hemiGround = colorOr(o, "hemiGround", t.hemiGround);
  t.hemiI = numberOr(o, "hemiI", t.hemiI);
  if (const Value* dir = member(o, "dir"); dir != nullptr && dir->isArray() && dir->items().size() == 3) {
    for (std::size_t i = 0; i < 3; ++i) t.dir[i] = dir->items()[i].asNumber();
  }
  t.lights = numberOr(o, "lights", t.lights);
  t.exposure = numberOr(o, "exposure", t.exposure);
  if (const std::optional<bool> rays = optBool(o, "rays")) t.rays = rays;
  t.haze = stringOr(o, "haze", t.haze);
  t.vignette = stringOr(o, "vignette", t.vignette);
  if (const Value* grade = member(o, "grade"); grade != nullptr && grade->isString()) t.grade = grade->asString();
}

PresetDefaults parseDefaults(const Value& o) {
  PresetDefaults d;
  d.facade = boolOr(o, "facade", false);
  d.outline = boolOr(o, "outline", false);
  d.massing = enumOr(o, "massing", Massing::Box);
  d.lanes = boolOr(o, "lanes", false);
  d.crosswalks = boolOr(o, "crosswalks", false);
  d.props = boolOr(o, "props", false);
  d.parked = boolOr(o, "parked", false);
  d.traffic = boolOr(o, "traffic", false);
  d.cine = optBool(o, "cine");
  d.details = optBool(o, "details");
  return d;
}

Value colorValue(std::uint32_t c) { return Value(static_cast<double>(c)); }

}  // namespace

ThemePreset parseThemePreset(const Value& o) {
  ThemePreset p;
  p.shading = enumOr(o, "shading", ShadingModel::Standard);
  p.textured = boolOr(o, "textured", false);
  p.facade = enumOr(o, "facade", FacadeSet::Real);
  p.toneMapped = boolOr(o, "toneMapped", false);
  p.streetLife = boolOr(o, "streetLife", false);
  p.edgeLines = boolOr(o, "edgeLines", false);
  p.flatRoofs = boolOr(o, "flatRoofs", false);
  if (const Value* h = member(o, "heightScale"); h != nullptr && h->isNumber()) p.heightScale = h->asNumber();
  p.hazeOpacity = numberOr(o, "hazeOpacity", 0.0);
  p.grade = numberOr(o, "grade", 0.0);
  if (const Value* palette = member(o, "palette"); palette != nullptr && palette->isArray()) {
    for (const Value& c : palette->items()) p.palette.push_back(c.asString());
  }
  p.ground = colorOr(o, "ground");
  p.road = colorOr(o, "road");
  p.pad = colorOr(o, "pad");
  p.plaza = colorOr(o, "plaza");
  p.park = colorOr(o, "park");
  p.water = colorOr(o, "water");
  p.rim = colorOr(o, "rim");
  p.trunk = colorOr(o, "trunk");
  p.leafA = colorOr(o, "leafA");
  p.leafB = colorOr(o, "leafB");
  p.centerLine = colorOr(o, "centerLine");
  p.crosswalkColor = colorOr(o, "crosswalkColor");
  if (const Value* l = member(o, "landmark")) {
    p.landmark.base = colorOr(*l, "base");
    p.landmark.a = colorOr(*l, "a");
    p.landmark.b = colorOr(*l, "b");
    p.landmark.cone = colorOr(*l, "cone");
    if (const Value* glass = member(*l, "glass"); glass != nullptr && glass->isString()) {
      p.landmark.glass = parseEnum<LandmarkGlass>(glass->asString());
    }
  }
  p.hemiMul = numberOr(o, "hemiMul", 1.0);
  p.sunMul = numberOr(o, "sunMul", 1.0);
  return p;
}

Value resolvedThemeToJson(const ResolvedTheme& t) {
  const ThemePreset& p = t.preset;
  Value palette = Value::array();
  for (const std::string& c : p.palette) palette.push(c);
  Value landmark = Value::object(
      {{"base", colorValue(p.landmark.base)}, {"a", colorValue(p.landmark.a)}, {"b", colorValue(p.landmark.b)}, {"cone", colorValue(p.landmark.cone)}});
  if (p.landmark.glass) landmark.set("glass", std::string(enumName(*p.landmark.glass)));
  Value preset = Value::object({
      {"shading", std::string(enumName(p.shading))},
      {"textured", p.textured},
      {"facade", std::string(enumName(p.facade))},
      {"toneMapped", p.toneMapped},
      {"streetLife", p.streetLife},
      {"edgeLines", p.edgeLines},
      {"flatRoofs", p.flatRoofs},
      {"hazeOpacity", p.hazeOpacity},
      {"grade", p.grade},
      {"palette", std::move(palette)},
      {"ground", colorValue(p.ground)},
      {"road", colorValue(p.road)},
      {"pad", colorValue(p.pad)},
      {"plaza", colorValue(p.plaza)},
      {"park", colorValue(p.park)},
      {"water", colorValue(p.water)},
      {"rim", colorValue(p.rim)},
      {"trunk", colorValue(p.trunk)},
      {"leafA", colorValue(p.leafA)},
      {"leafB", colorValue(p.leafB)},
      {"centerLine", colorValue(p.centerLine)},
      {"crosswalkColor", colorValue(p.crosswalkColor)},
      {"landmark", std::move(landmark)},
      {"hemiMul", p.hemiMul},
      {"sunMul", p.sunMul},
  });
  if (p.heightScale) preset.set("heightScale", *p.heightScale);

  const TimeOfDayPreset& tm = t.time;
  Value time = Value::object({
      {"fog", colorValue(tm.fog)},
      {"fogNear", tm.fogNear},
      {"fogFar", tm.fogFar},
      {"sun", colorValue(tm.sun)},
      {"sunI", tm.sunI},
      {"hemiSky", colorValue(tm.hemiSky)},
      {"hemiGround", colorValue(tm.hemiGround)},
      {"hemiI", tm.hemiI},
      {"dir", Value::array({tm.dir[0], tm.dir[1], tm.dir[2]})},
      {"lights", tm.lights},
      {"exposure", tm.exposure},
      {"haze", tm.haze},
      {"vignette", tm.vignette},
  });
  if (tm.rays) time.set("rays", *tm.rays);
  if (tm.grade) time.set("grade", *tm.grade);

  return Value::object({
      {"presetName", t.presetName ? Value(std::string(enumName(*t.presetName))) : Value(nullptr)},
      {"preset", std::move(preset)},
      {"timeOfDay", std::string(enumName(t.timeOfDay))},
      {"time", std::move(time)},
      {"cinematic", t.cinematic},
      {"shadows", t.shadows},
      {"buildings", Value::object({{"facade", t.buildings.facade},
                                   {"outline", t.buildings.outline},
                                   {"massing", std::string(enumName(t.buildings.massing))},
                                   {"details", t.buildings.details},
                                   {"heightScale", t.buildings.heightScale}})},
      {"roads", Value::object({{"laneMarkings", t.roads.laneMarkings}, {"crosswalks", t.roads.crosswalks}})},
      {"street", Value::object({{"props", t.street.props}, {"parked", t.street.parked}, {"traffic", t.street.traffic}})},
      {"zoomOut", std::string(enumName(t.zoomOut))},
  });
}

Result<ThemeResolver> ThemeResolver::fromJson(const Value& data) {
  const Value* presets = member(data, "presets");
  const Value* times = member(data, "times");
  const Value* cine = member(data, "cine");
  const Value* defaults = member(data, "presetDefaults");
  const Value* base = member(data, "baseDefaults");
  if (presets == nullptr || times == nullptr || cine == nullptr || defaults == nullptr || base == nullptr) {
    return Result<ThemeResolver>::failure("theme data: expected {presets, times, cine, presetDefaults, baseDefaults}");
  }
  ThemeResolver r;
  for (std::size_t i = 0; i < EnumNames<PresetName>::values.size(); ++i) {
    const std::string_view name = EnumNames<PresetName>::values[i];
    const Value* p = presets->find(name);
    const Value* d = defaults->find(name);
    if (p == nullptr || d == nullptr) {
      return Result<ThemeResolver>::failure("theme data: missing preset " + json::quote(name));
    }
    r.presets_[i] = parseThemePreset(*p);
    r.defaults_[i] = parseDefaults(*d);
  }
  for (std::size_t i = 0; i < EnumNames<TimeOfDay>::values.size(); ++i) {
    const std::string_view name = EnumNames<TimeOfDay>::values[i];
    const Value* t = times->find(name);
    if (t == nullptr) return Result<ThemeResolver>::failure("theme data: missing time of day " + json::quote(name));
    applyTime(r.times_[i], *t);
    if (const Value* c = cine->find(name)) r.cine_[i] = *c;
  }
  r.baseCinematic_ = boolOr(*base, "cinematic", false);
  r.baseShadows_ = boolOr(*base, "shadows", true);
  r.baseDetails_ = boolOr(*base, "details", false);
  r.baseZoomOut_ = enumOr(*base, "zoomOut", ZoomOutBehavior::None);
  r.baseTimeOfDay_ = enumOr(*base, "timeOfDay", TimeOfDay::Day);
  return Result<ThemeResolver>::success(std::move(r));
}

const ThemeResolver& ThemeResolver::builtIn() {
  static const ThemeResolver resolver = [] {
    const json::ParseResult parsed = json::parse(theme_data::kBuiltInThemeJson);
    Result<ThemeResolver> loaded = parsed.ok ? fromJson(parsed.value) : Result<ThemeResolver>::failure(parsed.error);
    // The generated data is checked by `npm test`; a failure here is a build defect, not an input error.
    if (!loaded.ok()) std::abort();
    return std::move(*loaded.value);
  }();
  return resolver;
}

ResolvedTheme ThemeResolver::resolve(const Value& spec) const {
  ResolvedTheme out;
  const Value* base = member(spec, "base");
  if (base != nullptr && base->isObject()) {
    out.presetName = std::nullopt;
    out.preset = parseThemePreset(*base);
  } else {
    const PresetName name =
        base != nullptr && base->isString() ? parseEnum<PresetName>(base->asString()).value_or(PresetName::Realistic) : PresetName::Realistic;
    out.presetName = name;
    out.preset = preset(name);
  }
  const PresetDefaults& d = defaults_[static_cast<std::size_t>(out.presetName.value_or(PresetName::Realistic))];

  out.timeOfDay = baseTimeOfDay_;
  if (const Value* t = member(spec, "timeOfDay"); t != nullptr && t->isString()) {
    out.timeOfDay = parseEnum<TimeOfDay>(t->asString()).value_or(baseTimeOfDay_);
  }
  out.cinematic = optBool(spec, "cinematic").value_or(d.cine.value_or(baseCinematic_));
  out.time = time(out.timeOfDay);
  if (out.cinematic) applyTime(out.time, cine_[static_cast<std::size_t>(out.timeOfDay)]);
  out.shadows = optBool(spec, "shadows").value_or(baseShadows_);

  static const Value kEmpty = Value::object();
  const Value* b = member(spec, "buildings");
  const Value& buildings = b != nullptr ? *b : kEmpty;
  out.buildings.facade = optBool(buildings, "facade").value_or(d.facade);
  out.buildings.outline = optBool(buildings, "outline").value_or(d.outline);
  out.buildings.massing = enumOr(buildings, "massing", d.massing);
  out.buildings.details = optBool(buildings, "details").value_or(d.details.value_or(baseDetails_));
  if (const Value* h = member(buildings, "heightScale"); h != nullptr && h->isNumber()) {
    out.buildings.heightScale = h->asNumber();
  } else {
    out.buildings.heightScale = out.preset.heightScale.value_or(1.0);
  }

  const Value* r = member(spec, "roads");
  const Value& roads = r != nullptr ? *r : kEmpty;
  out.roads.laneMarkings = optBool(roads, "laneMarkings").value_or(d.lanes);
  out.roads.crosswalks = optBool(roads, "crosswalks").value_or(d.crosswalks);

  const Value* s = member(spec, "street");
  const Value& street = s != nullptr ? *s : kEmpty;
  out.street.props = optBool(street, "props").value_or(d.props);
  out.street.parked = optBool(street, "parked").value_or(d.parked);
  out.street.traffic = optBool(street, "traffic").value_or(d.traffic);

  out.zoomOut = enumOr(spec, "zoomOut", baseZoomOut_);
  return out;
}

}  // namespace maprama
