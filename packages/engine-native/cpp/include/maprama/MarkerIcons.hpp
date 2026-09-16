// Maprama native core — custom marker icons (M5).
//
// `MarkerSpec.icon = { uri }` accepts what engine-web accepts: a `data:` URI (the example app ships
// `data:image/svg+xml;base64,…`), an `http(s):` or `file:` URL, or a bundled asset. iOS and Android decode
// raster formats themselves (`UIImage` / `BitmapFactory`), but **neither can decode SVG**, and the web
// engine's own icons are SVG. So the core parses the small SVG subset those icons use into plain filled and
// stroked paths, exactly like the generated label icons (`LabelIcons.hpp`), and each platform replays them
// once into a cached image.
//
// The subset is deliberately small and **fails closed**: anything it does not understand (arcs, gradients,
// transforms, `<use>`, CSS) makes `parseSvg` return `nullopt`, and the platform then draws the plain base
// shape instead of guessing.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/MapAdapter.hpp"

namespace maprama {

/// One filled and/or stroked subpath, in the `ops`/`coords` form the platforms already replay for label
/// icons: `M`/`L` take one point, `C` takes three, `Z` takes none.
struct VectorPath {
  std::string ops;
  std::vector<float> coords;
  bool hasFill = true;
  /// 0xRRGGBB; `fillCurrent` means the marker's own tint (`currentColor`).
  std::uint32_t fill = 0x000000;
  bool fillCurrent = false;
  float fillOpacity = 1.0f;
  bool hasStroke = false;
  std::uint32_t stroke = 0x000000;
  bool strokeCurrent = false;
  float strokeWidth = 1.0f;
  float strokeOpacity = 1.0f;
  bool roundJoin = false;
  bool roundCap = false;
};

/// A parsed SVG icon: the viewBox it is drawn in plus its paths, in document order.
struct VectorImage {
  float x = 0.0f;
  float y = 0.0f;
  float width = 24.0f;
  float height = 24.0f;
  std::vector<VectorPath> paths;
};

/// The payload of a `data:` URI.
struct DataUri {
  /// e.g. `image/svg+xml`, `image/png` (parameters stripped, lower-cased).
  std::string mediaType;
  std::string bytes;
};

/// Decodes a `data:[<media type>][;base64],<data>` URI (percent-decoding the non-base64 form).
/// `nullopt` for anything else.
std::optional<DataUri> parseDataUri(std::string_view uri);

/// Standard base64 (padding optional, whitespace ignored). `nullopt` on an invalid character.
std::optional<std::string> base64Decode(std::string_view text);

/// Parses the supported SVG subset: `<svg viewBox|width|height>` with `<path d>`, `<circle>`, `<ellipse>`,
/// `<rect>` (including `rx`/`ry`), `<polygon>` and `<polyline>` children, and the `fill`, `fill-opacity`,
/// `stroke`, `stroke-opacity`, `stroke-width`, `stroke-linejoin` and `stroke-linecap` attributes (hex,
/// `none`, `currentColor` and the handful of CSS colour names the engine's own icons use).
/// Path data supports `M m L l H h V v C c S s Q q T t Z z`; an arc (`A`/`a`) or any other construct makes
/// the whole parse fail, so the platform falls back to the plain base shape.
std::optional<VectorImage> parseSvg(std::string_view svg);

/// `parseDataUri` + `parseSvg` for a `data:image/svg+xml` URI; `nullopt` for every other URI (the platform
/// then decodes the bytes itself).
std::optional<VectorImage> parseSvgDataUri(std::string_view uri);

/// engine-web's built-in base shapes as vector paths in their own viewBox (`pin` 24x32, `dot` 24x24),
/// so both platforms draw exactly the shape the web engine's `SHAPES` table draws: the body tinted with the
/// marker's colour (`fillCurrent`) inside a white outline, plus the white inner dot of the pin. The pin's
/// semicircular head is two cubics instead of the SVG arc (the same curve to within a rounding error).
VectorImage markerBaseShape(MarkerShape shape);

/// Where a custom icon sits inside the base shape, as fractions of the shape box
/// (engine-web `.mpr-mk-img`: centred horizontally, 14 % down, 46 % wide and tall).
inline constexpr float kMarkerIconTop = 0.14f;
inline constexpr float kMarkerIconSize = 0.46f;

}  // namespace maprama
