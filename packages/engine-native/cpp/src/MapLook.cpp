#include "maprama/MapLook.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "maprama/json.hpp"

namespace maprama {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kRadToDeg = 180.0 / kPi;

// engine-web `render/static-world.ts`: textured presets paint these base colors (texture tints) instead of
// the preset's white `ground` / `road` / `pad`.
constexpr std::uint32_t kTexturedGround = 0x86A56E;
constexpr std::uint32_t kTexturedRoad = 0x55585E;
constexpr std::uint32_t kTexturedPad = 0xC4C1BA;
/// Alleys: asphalt blended towards the sidewalk color (narrow shared lanes).
constexpr double kAlleyPadMix = 0.3;
/// Share of the time-of-day irradiance ratio applied to flat colours (see `timeTint`).
constexpr double kTimeTintStrength = 0.75;

// engine-web `URBAN_SCHEMES[].tint` (`render/buildings.ts`), used with the urban facade set + details.
constexpr std::array<std::uint32_t, 5> kUrbanSchemeTints{0xF3EEE5, 0xF6F7F8, 0xE6E2DC, 0xDFE5EA, 0xE0E8E1};

// M1 POI category colors (`PoiCategory` order: subway, cafe, store, music, school, book, plaza, park).
constexpr std::array<std::uint32_t, 8> kPoiColors{kAccentColor, 0xB7773B, 0xD0508A, 0x7B4FD6, 0xE0A100, 0x3E8E7E, 0x7A8594, 0x4F9A46};

struct Rgb {
  double r, g, b;
};

Rgb rgbOf(std::uint32_t c) {
  return Rgb{((c >> 16) & 0xFF) / 255.0, ((c >> 8) & 0xFF) / 255.0, (c & 0xFF) / 255.0};
}

std::uint32_t channel(double v) {
  const double c = std::round(std::clamp(v, 0.0, 1.0) * 255.0);
  return static_cast<std::uint32_t>(c);
}

std::uint32_t packRgb(double r, double g, double b) { return (channel(r) << 16) | (channel(g) << 8) | channel(b); }

/// Irradiance-like brightness per channel: hemisphere sky light plus the sun weighted by its elevation,
/// scaled by the exposure (the same inputs engine-web's lights and tone mapping use).
Rgb irradiance(const TimeOfDayPreset& t) {
  const double len = std::sqrt(t.dir[0] * t.dir[0] + t.dir[1] * t.dir[1] + t.dir[2] * t.dir[2]);
  const double elevation = len > 0 ? std::max(0.0, t.dir[1] / len) : 1.0;
  const Rgb sky = rgbOf(t.hemiSky);
  const Rgb sun = rgbOf(t.sun);
  const double hemi = t.hemiI * 0.6;
  const double direct = t.sunI * elevation * 0.3;
  return Rgb{(sky.r * hemi + sun.r * direct) * t.exposure, (sky.g * hemi + sun.g * direct) * t.exposure,
             (sky.b * hemi + sun.b * direct) * t.exposure};
}

int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

}  // namespace

// ---------------------------------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------------------------------

std::string cssHex(std::uint32_t rgb) {
  char buf[8];
  std::snprintf(buf, sizeof buf, "#%06X", static_cast<unsigned>(rgb & 0xFFFFFF));
  return buf;
}

std::optional<std::uint32_t> parseCssHex(std::string_view css) {
  if (css.empty() || css[0] != '#') return std::nullopt;
  const std::string_view hex = css.substr(1);
  if (hex.size() != 3 && hex.size() != 6 && hex.size() != 8) return std::nullopt;
  for (char c : hex) {
    if (hexDigit(c) < 0) return std::nullopt;
  }
  if (hex.size() == 3) {
    std::uint32_t out = 0;
    for (char c : hex) out = (out << 8) | static_cast<std::uint32_t>(hexDigit(c) * 17);
    return out;
  }
  std::uint32_t out = 0;
  for (std::size_t i = 0; i < 6; ++i) out = (out << 4) | static_cast<std::uint32_t>(hexDigit(hex[i]));
  return out;
}

std::uint32_t mixColor(std::uint32_t a, std::uint32_t b, double t) {
  const Rgb x = rgbOf(a);
  const Rgb y = rgbOf(b);
  return packRgb(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t);
}

std::uint32_t applyTint(std::uint32_t rgb, const RgbTint& tint) {
  const Rgb c = rgbOf(rgb);
  return packRgb(c.r * tint.r, c.g * tint.g, c.b * tint.b);
}

std::uint32_t hashId(std::string_view id) {
  std::uint32_t h = 2166136261u;
  const auto mixUnit = [&h](std::uint32_t unit) { h = (h ^ unit) * 16777619u; };
  std::size_t i = 0;
  while (i < id.size()) {
    const auto b0 = static_cast<unsigned char>(id[i]);
    std::uint32_t cp = b0;
    std::size_t n = 1;
    const auto cont = [&](std::size_t k) { return static_cast<std::uint32_t>(static_cast<unsigned char>(id[i + k]) & 0x3F); };
    if (b0 >= 0xF0 && i + 3 < id.size()) {
      cp = ((b0 & 0x07u) << 18) | (cont(1) << 12) | (cont(2) << 6) | cont(3);
      n = 4;
    } else if (b0 >= 0xE0 && i + 2 < id.size()) {
      cp = ((b0 & 0x0Fu) << 12) | (cont(1) << 6) | cont(2);  // lone surrogates (WTF-8) decode to D800-DFFF
      n = 3;
    } else if (b0 >= 0xC0 && i + 1 < id.size()) {
      cp = ((b0 & 0x1Fu) << 6) | cont(1);
      n = 2;
    }
    i += n;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      mixUnit(0xD800 + (cp >> 10));
      mixUnit(0xDC00 + (cp & 0x3FF));
    } else {
      mixUnit(cp);
    }
  }
  return h;
}

// ---------------------------------------------------------------------------------------------------
// Theme -> look
// ---------------------------------------------------------------------------------------------------

RgbTint timeTint(const TimeOfDayPreset& time, const TimeOfDayPreset& reference) {
  const Rgb t = irradiance(time);
  const Rgb r = irradiance(reference);
  // Flat colours carry no lighting, so the full irradiance ratio reads too dark / saturated (checked on
  // device with the toy palette at dusk); 75 % of it keeps day exact and dusk / night clearly darker.
  const auto ratio = [](double a, double b) {
    const double k = b > 0 ? std::clamp(a / b, 0.0, 1.0) : 1.0;
    return 1.0 - kTimeTintStrength * (1.0 - k);
  };
  return RgbTint{ratio(t.r, r.r), ratio(t.g, r.g), ratio(t.b, r.b)};
}

MapLight lightFor(const ResolvedTheme& theme) {
  const std::array<double, 3>& d = theme.time.dir;  // three.js: +x east, +y up, +z south
  MapLight light;
  light.radial = 1.15;
  double azimuth = std::atan2(d[0], -d[2]) * kRadToDeg;  // clockwise from north
  if (azimuth < 0) azimuth += 360.0;
  light.azimuthal = std::round(azimuth * 100.0) / 100.0;
  light.polar = std::round(std::atan2(std::hypot(d[0], d[2]), d[1]) * kRadToDeg * 100.0) / 100.0;
  light.color = theme.time.sun;
  light.intensity = std::round(std::clamp(0.2 + 0.16 * theme.time.sunI * theme.preset.sunMul, 0.2, 0.6) * 1000.0) / 1000.0;
  return light;
}

MapLook mapLookFor(const ResolvedTheme& theme) {
  const ThemePreset& p = theme.preset;
  MapLook look;
  look.tint = timeTint(theme.time, ThemeResolver::builtIn().time(TimeOfDay::Day));
  const auto tinted = [&look](std::uint32_t c) { return applyTint(c, look.tint); };

  look.background = theme.time.fog;
  const std::uint32_t ground = p.textured ? kTexturedGround : p.ground;
  const std::uint32_t pad = p.textured ? kTexturedPad : p.pad;
  const std::uint32_t road = p.textured ? kTexturedRoad : p.road;
  look.ground = tinted(ground);
  look.pad = tinted(pad);
  look.road = tinted(road);
  look.alley = tinted(mixColor(road, pad, kAlleyPadMix));
  look.park = tinted(p.park);
  look.water = tinted(p.water);
  look.centerLine = tinted(p.centerLine);
  look.laneMarkings = theme.roads.laneMarkings;

  for (std::size_t ci = 0; ci < look.palette.size(); ++ci) {
    const std::string& css = p.palette.empty() ? std::string("#FFFFFF") : p.palette[ci % p.palette.size()];
    look.palette[ci] = tinted(parseCssHex(css).value_or(0xFFFFFF));
  }
  if (p.facade == FacadeSet::Urban && theme.buildings.details) {
    std::array<std::uint32_t, 5> tints{};
    for (std::size_t i = 0; i < tints.size(); ++i) tints[i] = tinted(kUrbanSchemeTints[i]);
    look.schemeTints = tints;
  }
  look.heightScale = theme.buildings.heightScale;

  for (std::size_t i = 0; i < look.poi.size(); ++i) look.poi[i] = tinted(kPoiColors[i]);
  look.station = tinted(kAccentColor);
  look.marker = tinted(0xFFFFFF);
  look.capturedRing = tinted(kAccentColor);
  look.light = lightFor(theme);
  return look;
}

std::uint32_t buildingThemeColor(const MapLook& look, std::uint32_t ci, std::size_t index) {
  if (look.schemeTints) return (*look.schemeTints)[index % look.schemeTints->size()];
  return look.palette[ci % look.palette.size()];
}

std::uint32_t buildingOverrideColor(const MapLook& look, std::uint32_t ci, std::size_t index, const BuildingOverride& o) {
  std::uint32_t color = o.color ? applyTint(*o.color, look.tint) : buildingThemeColor(look, ci, index);
  if (o.captured) color = mixColor(color, applyTint(kCapturedGlowColor, look.tint), kCapturedGlowMix);
  return color;
}

std::vector<std::string> unrenderedThemeOptions(const ResolvedTheme& theme) {
  std::vector<std::string> out;
  if (theme.buildings.facade && theme.preset.facade != FacadeSet::None) out.emplace_back("buildings.facade (facade textures)");
  if (theme.buildings.outline || theme.preset.edgeLines) out.emplace_back("buildings.outline (edge lines)");
  if (theme.buildings.details) out.emplace_back("buildings.details (facade details)");
  if (theme.buildings.massing == Massing::Varied) out.emplace_back("buildings.massing \"varied\"");
  if (theme.cinematic) out.emplace_back("cinematic (color grading; its lighting is applied)");
  if (theme.zoomOut != ZoomOutBehavior::None) out.emplace_back("zoomOut \"" + std::string(enumName(theme.zoomOut)) + "\"");
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Scale bar
// ---------------------------------------------------------------------------------------------------

ScaleBarSpec scaleBarFor(double metersPerDp, double maxWidth) {
  static constexpr std::array<double, 11> kSteps{5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000};
  ScaleBarSpec s;
  if (!(metersPerDp > 0) || !std::isfinite(metersPerDp)) return s;
  double v = kSteps[0];
  for (double n : kSteps) {
    if (n / metersPerDp <= maxWidth) v = n;
  }
  s.meters = v;
  s.width = std::round(v / metersPerDp * 2.0) / 2.0;  // 0.5 dp steps: fewer UI updates while zooming
  s.label = v >= 1000 ? json::numberToString(v / 1000.0) + "km" : json::numberToString(v) + "m";
  return s;
}

}  // namespace maprama
