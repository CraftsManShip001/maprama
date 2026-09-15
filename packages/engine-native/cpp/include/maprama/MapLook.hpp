// Maprama native core — M2a "diorama look" values: a resolved theme (and per-building overrides) mapped
// onto what the official MapLibre SDKs can draw with style layers (DESIGN.md §6.6, §11 M2a).
//
//   - Map colors follow engine-web's static world (`render/static-world.ts`): ground, pads (road casings /
//     sidewalks), asphalt, parks, water; textured presets use the texture base colors engine-web paints.
//   - Building colors follow engine-web's `BuildingRenderer`: `palette[hashId(id) % 6 % palette.length]`,
//     urban color schemes with facade details, explicit `setBuildingStyle.color`, captured highlight.
//   - Time of day becomes the style `light` (sun direction / color / intensity for extrusion shading) and a
//     per-channel tint of every flat color (hemisphere + sun irradiance relative to `TIMES.day`, so the
//     day look is exactly the theme's colors and dusk / night darken the whole map).
// Everything here is pure (no adapter, no JSON) so it is unit-tested directly.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/MapAdapter.hpp"
#include "maprama/ThemeResolver.hpp"

namespace maprama {

/// engine-web `ACCENT` (station, captured flag / ring).
inline constexpr std::uint32_t kAccentColor = 0x2F5BEA;
/// engine-web `GLOW_COLOR` (captured building glow).
inline constexpr std::uint32_t kCapturedGlowColor = 0xFFD36E;
/// Share of the glow color mixed into a captured building's color.
inline constexpr double kCapturedGlowMix = 0.35;

/// Per-channel multiplier in [0, 1].
struct RgbTint {
  double r = 1.0;
  double g = 1.0;
  double b = 1.0;
};

/// Theme values of the map style (colors are already tinted for the time of day).
struct MapLook {
  /// Background beyond the world (engine-web clear color = time-of-day fog, not tinted).
  std::uint32_t background = 0;
  std::uint32_t ground = 0;
  std::uint32_t pad = 0;
  std::uint32_t road = 0;
  std::uint32_t alley = 0;
  std::uint32_t park = 0;
  std::uint32_t water = 0;
  std::uint32_t centerLine = 0;
  bool laneMarkings = false;
  /// `palette[ci % palette.length]` for palette index ci = 0..5.
  std::array<std::uint32_t, 6> palette{};
  /// Urban color scheme tints (by building index % 5) when the urban preset shows facade details.
  std::optional<std::array<std::uint32_t, 5>> schemeTints;
  double heightScale = 1.0;
  /// POI category colors (`PoiCategory` order) and station / accent colors.
  std::array<std::uint32_t, 8> poi{};
  std::uint32_t station = 0;
  std::uint32_t marker = 0;
  std::uint32_t capturedRing = 0;
  RgbTint tint;
  MapLight light;
};

/// Per-building override from `setBuildingStyle`, as far as M2a renders it.
struct BuildingOverride {
  std::optional<std::uint32_t> color;
  bool captured = false;
};

/// Style values for a resolved theme.
MapLook mapLookFor(const ResolvedTheme& theme);

/// Time-of-day tint: irradiance of `time` relative to the `reference` (non-cinematic `TIMES.day`).
RgbTint timeTint(const TimeOfDayPreset& time, const TimeOfDayPreset& reference);
/// Style light for a theme: sun direction -> spherical position, sun color, intensity from `sunI · sunMul`.
MapLight lightFor(const ResolvedTheme& theme);

/// Base (theme) color of a building with palette index `ci` and building index `index`, untinted look
/// values already include the tint.
std::uint32_t buildingThemeColor(const MapLook& look, std::uint32_t ci, std::size_t index);
/// Final color of an overridden building (explicit color or theme color, captured glow mix, tint).
std::uint32_t buildingOverrideColor(const MapLook& look, std::uint32_t ci, std::size_t index, const BuildingOverride& o);

/// Theme options M2a accepts but does not render yet (warn-logged once each by the session): keys such as
/// `buildings.facade`, `buildings.outline`, `buildings.details`, `buildings.massing`, `cinematic`, `zoomOut`.
std::vector<std::string> unrenderedThemeOptions(const ResolvedTheme& theme);

// ---- colors ------------------------------------------------------------------------------------------

/// `#RRGGBB` (upper-case hex).
std::string cssHex(std::uint32_t rgb);
/// `#RGB`, `#RRGGBB` or `#RRGGBBAA` (alpha ignored, like engine-web `cssHexToNumber`); nullopt otherwise.
std::optional<std::uint32_t> parseCssHex(std::string_view css);
/// Linear mix in sRGB: `a · (1 − t) + b · t`, rounded per channel.
std::uint32_t mixColor(std::uint32_t a, std::uint32_t b, double t);
std::uint32_t applyTint(std::uint32_t rgb, const RgbTint& tint);

/// engine-web `hashId`: 32-bit FNV-1a over the UTF-16 code units of `id` (UTF-8 / WTF-8 input).
std::uint32_t hashId(std::string_view id);

// ---- scale bar -----------------------------------------------------------------------------------------

struct ScaleBarSpec {
  double meters = 0.0;
  /// Bar length in density-independent pixels.
  double width = 0.0;
  std::string label;
};

/// engine-web `scaleBarFor`: the largest round distance (5 m … 10 km) that fits in `maxWidth` dp.
ScaleBarSpec scaleBarFor(double metersPerDp, double maxWidth = 90.0);

}  // namespace maprama
