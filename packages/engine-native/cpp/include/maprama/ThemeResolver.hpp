// Maprama native core — theme resolution (theme.ts `resolveTheme`), DESIGN.md §6.6.
//
// Built-in preset data is not transcribed by hand: `scripts/generate-theme-data.mjs` embeds the
// `@maprama/protocol` build output (PRESETS, TIMES, CINE, PRESET_DEFAULTS, BASE_THEME_DEFAULTS) into
// `cpp/src/ThemeData.cpp`, and `npm test` fails when that file drifts from the protocol package. The
// conformance suite checks `resolve` against `resolveTheme` outputs exported from TypeScript.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

struct LandmarkColors {
  std::uint32_t base = 0;
  std::uint32_t a = 0;
  std::uint32_t b = 0;
  std::uint32_t cone = 0;
  std::optional<LandmarkGlass> glass;
};

/// `ThemePreset` (colors are 24-bit RGB; `palette` are CSS hex strings).
struct ThemePreset {
  ShadingModel shading = ShadingModel::Standard;
  bool textured = false;
  FacadeSet facade = FacadeSet::Real;
  bool toneMapped = false;
  bool streetLife = false;
  bool edgeLines = false;
  bool flatRoofs = false;
  std::optional<double> heightScale;
  double hazeOpacity = 0.0;
  double grade = 0.0;
  std::vector<std::string> palette;
  std::uint32_t ground = 0, road = 0, pad = 0, plaza = 0, park = 0, water = 0, rim = 0, trunk = 0, leafA = 0,
                leafB = 0, centerLine = 0, crosswalkColor = 0;
  LandmarkColors landmark;
  double hemiMul = 1.0;
  double sunMul = 1.0;
};

/// `TimeOfDayPreset` (CSS gradient strings are parsed by the renderer into ramp textures, M2c).
struct TimeOfDayPreset {
  std::uint32_t fog = 0;
  double fogNear = 0.0;
  double fogFar = 0.0;
  std::uint32_t sun = 0;
  double sunI = 0.0;
  std::uint32_t hemiSky = 0;
  std::uint32_t hemiGround = 0;
  double hemiI = 0.0;
  std::array<double, 3> dir{0.0, 1.0, 0.0};
  double lights = 0.0;
  double exposure = 1.0;
  std::optional<bool> rays;
  std::string haze;
  std::string vignette;
  std::optional<std::string> grade;
};

/// `PresetDefaults`.
struct PresetDefaults {
  bool facade = false;
  bool outline = false;
  Massing massing = Massing::Box;
  bool lanes = false;
  bool crosswalks = false;
  bool props = false;
  bool parked = false;
  bool traffic = false;
  std::optional<bool> cine;
  std::optional<bool> details;
};

/// `ResolvedTheme`.
struct ResolvedTheme {
  /// nullopt when `base` was a custom preset object.
  std::optional<PresetName> presetName;
  ThemePreset preset;
  TimeOfDay timeOfDay = TimeOfDay::Day;
  TimeOfDayPreset time;
  bool cinematic = false;
  bool shadows = true;
  struct {
    bool facade = false;
    bool outline = false;
    Massing massing = Massing::Box;
    bool details = false;
    double heightScale = 1.0;
  } buildings;
  struct {
    bool laneMarkings = false;
    bool crosswalks = false;
  } roads;
  struct {
    bool props = false;
    bool parked = false;
    bool traffic = false;
  } street;
  ZoomOutBehavior zoomOut = ZoomOutBehavior::None;
};

/// Parses a full `ThemePreset` object (one that passed `checkThemePreset`, e.g. `ThemeSpec.base`).
ThemePreset parseThemePreset(const json::Value& preset);

/// `ResolvedTheme` as the same JSON object `resolveTheme` returns (diagnostics and conformance tests).
json::Value resolvedThemeToJson(const ResolvedTheme& theme);

class ThemeResolver {
 public:
  /// The resolver over `@maprama/protocol`'s built-in data (generated `ThemeData.cpp`), parsed once.
  static const ThemeResolver& builtIn();

  /// Loads built-in data `{presets, times, cine, presetDefaults, baseDefaults}` (the generated JSON shape).
  static Result<ThemeResolver> fromJson(const json::Value& data);

  /// `resolveTheme(spec)`: spec field -> PRESET_DEFAULTS[base] -> BASE_THEME_DEFAULTS. `spec` has passed
  /// `checkThemeSpec` (the dispatcher decodes first); an unknown preset name falls back to `realistic`.
  ResolvedTheme resolve(const json::Value& themeSpec) const;

  const ThemePreset& preset(PresetName name) const { return presets_[static_cast<std::size_t>(name)]; }
  /// `TIMES[timeOfDay]` without cinematic overrides.
  const TimeOfDayPreset& time(TimeOfDay timeOfDay) const { return times_[static_cast<std::size_t>(timeOfDay)]; }

 private:
  std::array<ThemePreset, EnumNames<PresetName>::values.size()> presets_{};
  std::array<TimeOfDayPreset, EnumNames<TimeOfDay>::values.size()> times_{};
  /// `CINE[timeOfDay]` partial objects, merged over `times_` when cinematic.
  std::array<json::Value, EnumNames<TimeOfDay>::values.size()> cine_{};
  std::array<PresetDefaults, EnumNames<PresetName>::values.size()> defaults_{};
  bool baseCinematic_ = false;
  bool baseShadows_ = true;
  bool baseDetails_ = false;
  ZoomOutBehavior baseZoomOut_ = ZoomOutBehavior::None;
  TimeOfDay baseTimeOfDay_ = TimeOfDay::Day;
};

}  // namespace maprama
