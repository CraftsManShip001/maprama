// Maprama native core — label icons and texts (generated from engine-web `src/labels/icons.ts` by
// scripts/generate-label-icons.mjs into cpp/src/LabelIcons.cpp; DESIGN.md §6.5).
//
// Icons are vector shapes in their SVG viewBox (0..size): each shape is a path of absolute commands
// (`ops`: 'M' x y, 'L' x y, 'C' x1 y1 x2 y2 x y, 'Z') with a fill and a stroke role. The platforms replay
// them into CGPath / android.graphics.Path and resolve the roles per icon tile:
//   Current = the tile's foreground colour (CSS `currentColor`), Accent = the icon colour (`var(--c)`),
//   White = #FFFFFF.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

#include "maprama/types.hpp"

namespace maprama {

enum class IconPaint : std::uint8_t { None, Current, Accent, White };

struct IconShape {
  IconPaint fill;
  float fillOpacity;
  IconPaint stroke;
  float strokeWidth;
  /// One character per command: M, L, C, Z.
  const char* ops;
  /// Coordinates consumed by `ops` in order (2 per M / L, 6 per C, 0 per Z).
  const float* coords;
  std::size_t coordCount;
};

struct IconDrawing {
  /// Square viewBox edge (20 for holo icons, 16 for POI glyphs).
  float size;
  /// Round line caps / joins (holo icons); butt / miter otherwise.
  bool roundCaps;
  const IconShape* shapes;
  std::size_t shapeCount;
  /// Non-null: draw this text (bold, white, centred) instead of shapes (the subway badge "M").
  const char* text;
};

/// engine-web `HOLO_ICONS[icon]` (holo cards).
const IconDrawing& holoIcon(LabelIcon icon);
/// engine-web `POI_GLYPHS[category]` (badges of the app / minimal / clean / sticker styles); nullptr for the
/// road / area icons, which have no badge glyph.
const IconDrawing* poiGlyph(LabelIcon icon);
/// engine-web `ICON_COLORS[icon]` as 24-bit RGB.
std::uint32_t iconColor(LabelIcon icon);
/// engine-web `POI_SUBTITLES[category]`.
std::string_view poiSubtitle(PoiCategory category);
/// engine-web `KIND_SUBTITLES` for `Avenue`, `Street`, `District`, `Water` (empty otherwise).
std::string_view kindSubtitle(LabelIcon icon);

}  // namespace maprama
