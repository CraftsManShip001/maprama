// Diorama native core — theme resolution (theme.ts `resolveTheme`).
//
// Interface only in the skeleton. Built-in preset data is not duplicated in
// C++: the platform layer bundles `@diorama/protocol/themes/*.json` (emitted
// by the protocol build) and passes them to the resolver at startup.
#pragma once

#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "diorama/json.hpp"
#include "diorama/types.hpp"

namespace diorama {

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

/// `TimeOfDayPreset` (CSS gradient strings are parsed by the renderer into ramp textures).
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

class ThemeResolver {
 public:
  virtual ~ThemeResolver() = default;

  /// Registers built-in data (`themes/<preset>.json`, times, cinematic overrides, preset defaults).
  virtual Result<bool> loadBuiltIns(const json::Value& presets, const json::Value& times, const json::Value& cine,
                                    const json::Value& presetDefaults) = 0;

  /// `resolveTheme(spec)`: spec field -> PRESET_DEFAULTS[base] -> BASE_THEME_DEFAULTS.
  /// `spec` has already passed `validateThemeSpec` (the dispatcher decodes first).
  virtual Result<ResolvedTheme> resolve(const json::Value& themeSpec) const = 0;

  virtual const ThemePreset* builtInPreset(PresetName name) const = 0;
};

}  // namespace diorama
