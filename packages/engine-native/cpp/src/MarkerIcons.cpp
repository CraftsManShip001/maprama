#include "maprama/MarkerIcons.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>

namespace maprama {

namespace {

constexpr double kKappa = 0.5522847498307936;  // circle -> cubic control point ratio

bool isSpace(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }

std::string lower(std::string_view s) {
  std::string out(s);
  for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

std::string trim(std::string_view s) {
  std::size_t a = 0, b = s.size();
  while (a < b && isSpace(s[a])) ++a;
  while (b > a && isSpace(s[b - 1])) --b;
  return std::string(s.substr(a, b - a));
}

int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/// The few CSS colour names the engine's own icons and typical app pins use.
bool namedColor(const std::string& name, std::uint32_t* out) {
  static const struct {
    const char* name;
    std::uint32_t rgb;
  } kNames[] = {{"black", 0x000000}, {"white", 0xFFFFFF}, {"red", 0xFF0000},   {"green", 0x008000},
                {"blue", 0x0000FF},  {"gray", 0x808080},  {"grey", 0x808080},  {"silver", 0xC0C0C0},
                {"orange", 0xFFA500}, {"yellow", 0xFFFF00}, {"purple", 0x800080}, {"navy", 0x000080}};
  for (const auto& n : kNames) {
    if (name == n.name) {
      *out = n.rgb;
      return true;
    }
  }
  return false;
}

/// `#rgb`, `#rrggbb`, a supported colour name, `none` or `currentColor`.
/// Returns false when the value is not understood (the parse then fails).
bool parsePaint(std::string_view raw, bool* has, std::uint32_t* rgb, bool* current) {
  const std::string v = lower(trim(raw));
  if (v.empty()) return false;
  if (v == "none" || v == "transparent") {
    *has = false;
    return true;
  }
  if (v == "currentcolor") {
    *has = true;
    *current = true;
    return true;
  }
  if (v[0] == '#') {
    const std::string digits = v.substr(1);
    if (digits.size() == 3 || digits.size() == 6) {
      std::uint32_t value = 0;
      for (char c : digits) {
        const int d = hexDigit(c);
        if (d < 0) return false;
        value = value * 16 + static_cast<std::uint32_t>(d);
      }
      if (digits.size() == 3) {
        const std::uint32_t r = (value >> 8) & 0xF, g = (value >> 4) & 0xF, b = value & 0xF;
        value = (r * 17u << 16) | (g * 17u << 8) | (b * 17u);
      }
      *has = true;
      *current = false;
      *rgb = value;
      return true;
    }
    return false;
  }
  std::uint32_t named = 0;
  if (namedColor(v, &named)) {
    *has = true;
    *current = false;
    *rgb = named;
    return true;
  }
  return false;  // rgb(), hsl(), url(#gradient), ... : fail closed
}

// ---------------------------------------------------------------------------------------------------------
// A very small XML scanner: element name + attributes. Enough for flat icon markup.
// ---------------------------------------------------------------------------------------------------------

struct Element {
  std::string name;
  std::vector<std::pair<std::string, std::string>> attrs;

  const std::string* attr(const char* key) const {
    for (const auto& a : attrs) {
      if (a.first == key) return &a.second;
    }
    return nullptr;
  }
};

/// Expands the five predefined XML entities; anything else is kept as written (icons rarely use entities).
std::string unescapeXml(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] != '&') {
      out += s[i];
      continue;
    }
    const std::size_t end = s.find(';', i);
    if (end == std::string_view::npos || end - i > 8) {
      out += s[i];
      continue;
    }
    const std::string_view name = s.substr(i + 1, end - i - 1);
    if (name == "amp") out += '&';
    else if (name == "lt") out += '<';
    else if (name == "gt") out += '>';
    else if (name == "quot") out += '"';
    else if (name == "apos") out += '\'';
    else out.append(s.substr(i, end - i + 1));
    i = end;
  }
  return out;
}

/// Reads the next start (or self-closing) tag from `pos`; skips comments, declarations and end tags.
bool nextElement(std::string_view svg, std::size_t* pos, Element* out) {
  while (*pos < svg.size()) {
    const std::size_t open = svg.find('<', *pos);
    if (open == std::string_view::npos) return false;
    if (svg.compare(open, 4, "<!--") == 0) {
      const std::size_t end = svg.find("-->", open);
      if (end == std::string_view::npos) return false;
      *pos = end + 3;
      continue;
    }
    if (open + 1 < svg.size() && (svg[open + 1] == '?' || svg[open + 1] == '!' || svg[open + 1] == '/')) {
      const std::size_t end = svg.find('>', open);
      if (end == std::string_view::npos) return false;
      *pos = end + 1;
      continue;
    }
    std::size_t i = open + 1;
    const std::size_t nameStart = i;
    while (i < svg.size() && !isSpace(svg[i]) && svg[i] != '>' && svg[i] != '/') ++i;
    Element el;
    el.name = lower(svg.substr(nameStart, i - nameStart));
    // Strip a namespace prefix (`svg:path`).
    if (const std::size_t colon = el.name.find(':'); colon != std::string::npos) el.name = el.name.substr(colon + 1);
    while (i < svg.size() && svg[i] != '>') {
      while (i < svg.size() && (isSpace(svg[i]) || svg[i] == '/')) ++i;
      if (i >= svg.size() || svg[i] == '>') break;
      const std::size_t keyStart = i;
      while (i < svg.size() && !isSpace(svg[i]) && svg[i] != '=' && svg[i] != '>' && svg[i] != '/') ++i;
      const std::string key = lower(svg.substr(keyStart, i - keyStart));
      while (i < svg.size() && isSpace(svg[i])) ++i;
      std::string value;
      if (i < svg.size() && svg[i] == '=') {
        ++i;
        while (i < svg.size() && isSpace(svg[i])) ++i;
        if (i < svg.size() && (svg[i] == '"' || svg[i] == '\'')) {
          const char quote = svg[i++];
          const std::size_t valueStart = i;
          while (i < svg.size() && svg[i] != quote) ++i;
          value = unescapeXml(svg.substr(valueStart, i - valueStart));
          if (i < svg.size()) ++i;
        }
      }
      if (!key.empty()) el.attrs.emplace_back(key, value);
    }
    *pos = i < svg.size() ? i + 1 : svg.size();
    *out = std::move(el);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Numbers and path data
// ---------------------------------------------------------------------------------------------------------

class NumberScanner {
 public:
  explicit NumberScanner(std::string_view text) : text_(text) {}

  void skipSeparators() {
    while (i_ < text_.size() && (isSpace(text_[i_]) || text_[i_] == ',')) ++i_;
  }
  bool atEnd() {
    skipSeparators();
    return i_ >= text_.size();
  }
  char peek() const { return i_ < text_.size() ? text_[i_] : '\0'; }
  void advance() { ++i_; }
  /// Reads one SVG number; false when the text at this position is not one.
  bool number(double* out) {
    skipSeparators();
    const std::size_t start = i_;
    if (i_ < text_.size() && (text_[i_] == '+' || text_[i_] == '-')) ++i_;
    bool digits = false;
    while (i_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[i_]))) {
      ++i_;
      digits = true;
    }
    if (i_ < text_.size() && text_[i_] == '.') {
      ++i_;
      while (i_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[i_]))) {
        ++i_;
        digits = true;
      }
    }
    if (!digits) {
      i_ = start;
      return false;
    }
    if (i_ < text_.size() && (text_[i_] == 'e' || text_[i_] == 'E')) {
      const std::size_t mark = i_;
      ++i_;
      if (i_ < text_.size() && (text_[i_] == '+' || text_[i_] == '-')) ++i_;
      bool expDigits = false;
      while (i_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[i_]))) {
        ++i_;
        expDigits = true;
      }
      if (!expDigits) i_ = mark;
    }
    *out = std::strtod(std::string(text_.substr(start, i_ - start)).c_str(), nullptr);
    return true;
  }

 private:
  std::string_view text_;
  std::size_t i_ = 0;
};

std::optional<double> parseLength(const std::string* raw, double fallback) {
  if (raw == nullptr) return fallback;
  NumberScanner scan(*raw);
  double v = 0;
  if (!scan.number(&v)) return std::nullopt;
  return v;  // `px` / `%` suffixes are ignored; icons use plain numbers
}

void moveTo(VectorPath* p, double x, double y) {
  p->ops += 'M';
  p->coords.push_back(static_cast<float>(x));
  p->coords.push_back(static_cast<float>(y));
}
void lineTo(VectorPath* p, double x, double y) {
  p->ops += 'L';
  p->coords.push_back(static_cast<float>(x));
  p->coords.push_back(static_cast<float>(y));
}
void curveTo(VectorPath* p, double x1, double y1, double x2, double y2, double x, double y) {
  p->ops += 'C';
  for (double v : {x1, y1, x2, y2, x, y}) p->coords.push_back(static_cast<float>(v));
}
void close(VectorPath* p) { p->ops += 'Z'; }

/// `d` -> ops/coords. Quadratics become cubics; arcs (and anything unknown) fail.
bool parsePathData(std::string_view d, VectorPath* out) {
  NumberScanner scan(d);
  double cx = 0, cy = 0, startX = 0, startY = 0;
  double lastC1x = 0, lastC1y = 0, lastQx = 0, lastQy = 0;
  char previous = '\0';
  char command = '\0';
  while (!scan.atEnd()) {
    const char c = scan.peek();
    if (std::isalpha(static_cast<unsigned char>(c))) {
      command = c;
      scan.advance();
    } else if (command == '\0') {
      return false;
    } else if (command == 'M') {
      command = 'L';  // implicit lineto after a moveto
    } else if (command == 'm') {
      command = 'l';
    }
    const bool relative = std::islower(static_cast<unsigned char>(command)) != 0;
    const char op = static_cast<char>(std::toupper(static_cast<unsigned char>(command)));
    const auto n = [&scan](double* v) { return scan.number(v); };
    double a = 0, b = 0, c1 = 0, d1 = 0, e = 0, f = 0;
    switch (op) {
      case 'M':
        if (!n(&a) || !n(&b)) return false;
        cx = relative ? cx + a : a;
        cy = relative ? cy + b : b;
        startX = cx;
        startY = cy;
        moveTo(out, cx, cy);
        break;
      case 'L':
        if (!n(&a) || !n(&b)) return false;
        cx = relative ? cx + a : a;
        cy = relative ? cy + b : b;
        lineTo(out, cx, cy);
        break;
      case 'H':
        if (!n(&a)) return false;
        cx = relative ? cx + a : a;
        lineTo(out, cx, cy);
        break;
      case 'V':
        if (!n(&a)) return false;
        cy = relative ? cy + a : a;
        lineTo(out, cx, cy);
        break;
      case 'C':
        if (!n(&a) || !n(&b) || !n(&c1) || !n(&d1) || !n(&e) || !n(&f)) return false;
        if (relative) {
          a += cx; b += cy; c1 += cx; d1 += cy; e += cx; f += cy;
        }
        curveTo(out, a, b, c1, d1, e, f);
        lastC1x = c1;
        lastC1y = d1;
        cx = e;
        cy = f;
        break;
      case 'S': {
        if (!n(&c1) || !n(&d1) || !n(&e) || !n(&f)) return false;
        if (relative) {
          c1 += cx; d1 += cy; e += cx; f += cy;
        }
        const bool smooth = previous == 'C' || previous == 'S';
        const double rx = smooth ? 2 * cx - lastC1x : cx, ry = smooth ? 2 * cy - lastC1y : cy;
        curveTo(out, rx, ry, c1, d1, e, f);
        lastC1x = c1;
        lastC1y = d1;
        cx = e;
        cy = f;
        break;
      }
      case 'Q':
      case 'T': {
        double qx = 0, qy = 0;
        if (op == 'Q') {
          if (!n(&a) || !n(&b) || !n(&e) || !n(&f)) return false;
          if (relative) {
            a += cx; b += cy; e += cx; f += cy;
          }
          qx = a;
          qy = b;
        } else {
          if (!n(&e) || !n(&f)) return false;
          if (relative) {
            e += cx; f += cy;
          }
          const bool smooth = previous == 'Q' || previous == 'T';
          qx = smooth ? 2 * cx - lastQx : cx;
          qy = smooth ? 2 * cy - lastQy : cy;
        }
        curveTo(out, cx + 2.0 / 3.0 * (qx - cx), cy + 2.0 / 3.0 * (qy - cy), e + 2.0 / 3.0 * (qx - e),
                f + 2.0 / 3.0 * (qy - f), e, f);
        lastQx = qx;
        lastQy = qy;
        cx = e;
        cy = f;
        break;
      }
      case 'Z':
        close(out);
        cx = startX;
        cy = startY;
        break;
      default:
        return false;  // arcs and anything unknown: fail closed
    }
    previous = op;
  }
  return !out->ops.empty();
}

/// An axis-aligned ellipse as four cubics.
void ellipsePath(VectorPath* p, double cx, double cy, double rx, double ry) {
  const double ox = rx * kKappa, oy = ry * kKappa;
  moveTo(p, cx + rx, cy);
  curveTo(p, cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry);
  curveTo(p, cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy);
  curveTo(p, cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry);
  curveTo(p, cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy);
  close(p);
}

void roundedRectPath(VectorPath* p, double x, double y, double w, double h, double rx, double ry) {
  if (rx <= 0 || ry <= 0) {
    moveTo(p, x, y);
    lineTo(p, x + w, y);
    lineTo(p, x + w, y + h);
    lineTo(p, x, y + h);
    close(p);
    return;
  }
  rx = std::min(rx, w / 2);
  ry = std::min(ry, h / 2);
  const double ox = rx * kKappa, oy = ry * kKappa;
  moveTo(p, x + rx, y);
  lineTo(p, x + w - rx, y);
  curveTo(p, x + w - rx + ox, y, x + w, y + ry - oy, x + w, y + ry);
  lineTo(p, x + w, y + h - ry);
  curveTo(p, x + w, y + h - ry + oy, x + w - rx + ox, y + h, x + w - rx, y + h);
  lineTo(p, x + rx, y + h);
  curveTo(p, x + rx - ox, y + h, x, y + h - ry + oy, x, y + h - ry);
  lineTo(p, x, y + ry);
  curveTo(p, x, y + ry - oy, x + rx - ox, y, x + rx, y);
  close(p);
}

bool polygonPath(std::string_view points, bool closed, VectorPath* p) {
  NumberScanner scan(points);
  double x = 0, y = 0;
  bool first = true;
  while (!scan.atEnd()) {
    if (!scan.number(&x) || !scan.number(&y)) return false;
    if (first) {
      moveTo(p, x, y);
      first = false;
    } else {
      lineTo(p, x, y);
    }
  }
  if (first) return false;
  if (closed) close(p);
  return true;
}

/// Applies the paint attributes of one element. False when a value is not understood.
bool applyPaint(const Element& el, VectorPath* p) {
  p->hasFill = true;
  p->fill = 0x000000;  // the SVG default
  p->hasStroke = false;
  if (const std::string* fill = el.attr("fill")) {
    if (!parsePaint(*fill, &p->hasFill, &p->fill, &p->fillCurrent)) return false;
  }
  if (const std::string* stroke = el.attr("stroke")) {
    if (!parsePaint(*stroke, &p->hasStroke, &p->stroke, &p->strokeCurrent)) return false;
  }
  if (const std::string* width = el.attr("stroke-width")) {
    const std::optional<double> v = parseLength(width, 1.0);
    if (!v) return false;
    p->strokeWidth = static_cast<float>(*v);
  }
  if (const std::string* o = el.attr("fill-opacity")) {
    const std::optional<double> v = parseLength(o, 1.0);
    if (!v) return false;
    p->fillOpacity = static_cast<float>(std::clamp(*v, 0.0, 1.0));
  }
  if (const std::string* o = el.attr("stroke-opacity")) {
    const std::optional<double> v = parseLength(o, 1.0);
    if (!v) return false;
    p->strokeOpacity = static_cast<float>(std::clamp(*v, 0.0, 1.0));
  }
  if (const std::string* join = el.attr("stroke-linejoin")) p->roundJoin = lower(*join) == "round";
  if (const std::string* cap = el.attr("stroke-linecap")) p->roundCap = lower(*cap) == "round";
  return true;
}

}  // namespace

// ---------------------------------------------------------------------------------------------------------

std::optional<std::string> base64Decode(std::string_view text) {
  static constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(text.size() * 3 / 4 + 3);
  std::uint32_t buffer = 0;
  int bits = 0;
  for (char c : text) {
    if (isSpace(c) || c == '=') continue;
    const char* found = std::char_traits<char>::find(kAlphabet, 64, c == '-' ? '+' : c == '_' ? '/' : c);
    if (found == nullptr) return std::nullopt;
    buffer = (buffer << 6) | static_cast<std::uint32_t>(found - kAlphabet);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += static_cast<char>((buffer >> bits) & 0xFF);
    }
  }
  return out;
}

std::optional<DataUri> parseDataUri(std::string_view uri) {
  if (uri.size() < 5 || lower(uri.substr(0, 5)) != "data:") return std::nullopt;
  const std::size_t comma = uri.find(',');
  if (comma == std::string_view::npos) return std::nullopt;
  const std::string header = lower(uri.substr(5, comma - 5));
  const std::string_view payload = uri.substr(comma + 1);
  bool base64 = false;
  std::string mediaType;
  std::size_t start = 0;
  while (start <= header.size()) {
    const std::size_t semi = header.find(';', start);
    const std::string part = header.substr(start, semi == std::string::npos ? std::string::npos : semi - start);
    if (part == "base64") {
      base64 = true;
    } else if (mediaType.empty() && part.find('/') != std::string::npos) {
      mediaType = part;
    }
    if (semi == std::string::npos) break;
    start = semi + 1;
  }
  DataUri out;
  out.mediaType = mediaType.empty() ? "text/plain" : mediaType;
  if (base64) {
    std::optional<std::string> bytes = base64Decode(payload);
    if (!bytes) return std::nullopt;
    out.bytes = std::move(*bytes);
    return out;
  }
  // Percent-decoding (the plain `data:image/svg+xml,<svg .../>` form).
  std::string decoded;
  decoded.reserve(payload.size());
  for (std::size_t i = 0; i < payload.size(); ++i) {
    if (payload[i] == '%' && i + 2 < payload.size()) {
      const int hi = hexDigit(payload[i + 1]), lo = hexDigit(payload[i + 2]);
      if (hi >= 0 && lo >= 0) {
        decoded += static_cast<char>(hi * 16 + lo);
        i += 2;
        continue;
      }
    }
    decoded += payload[i];
  }
  out.bytes = std::move(decoded);
  return out;
}

std::optional<VectorImage> parseSvg(std::string_view svg) {
  VectorImage image;
  std::size_t pos = 0;
  Element el;
  bool sawRoot = false;
  while (nextElement(svg, &pos, &el)) {
    if (el.name == "svg") {
      if (sawRoot) return std::nullopt;  // nested SVGs are out of the subset
      sawRoot = true;
      if (const std::string* viewBox = el.attr("viewbox")) {
        NumberScanner scan(*viewBox);
        double v[4] = {0, 0, 0, 0};
        for (double& n : v) {
          if (!scan.number(&n)) return std::nullopt;
        }
        if (!(v[2] > 0) || !(v[3] > 0)) return std::nullopt;
        image.x = static_cast<float>(v[0]);
        image.y = static_cast<float>(v[1]);
        image.width = static_cast<float>(v[2]);
        image.height = static_cast<float>(v[3]);
      } else {
        const std::optional<double> w = parseLength(el.attr("width"), 24.0);
        const std::optional<double> h = parseLength(el.attr("height"), 24.0);
        if (!w || !h || !(*w > 0) || !(*h > 0)) return std::nullopt;
        image.width = static_cast<float>(*w);
        image.height = static_cast<float>(*h);
      }
      continue;
    }
    if (!sawRoot) return std::nullopt;
    // Constructs the subset cannot honour must not be silently dropped.
    if (el.name == "g" || el.name == "defs" || el.name == "use" || el.name == "style" || el.name == "image" ||
        el.name == "text" || el.name == "clippath" || el.name == "mask" || el.name == "lineargradient" ||
        el.name == "radialgradient" || el.name == "symbol" || el.name == "marker" || el.name == "pattern" ||
        el.name == "filter" || el.name == "switch" || el.name == "foreignobject") {
      return std::nullopt;
    }
    if (el.attr("transform") != nullptr || el.attr("style") != nullptr || el.attr("clip-path") != nullptr ||
        el.attr("mask") != nullptr || el.attr("opacity") != nullptr) {
      return std::nullopt;
    }
    VectorPath path;
    if (!applyPaint(el, &path)) return std::nullopt;
    if (el.name == "path") {
      const std::string* d = el.attr("d");
      if (d == nullptr || !parsePathData(*d, &path)) return std::nullopt;
    } else if (el.name == "circle" || el.name == "ellipse") {
      const std::optional<double> cx = parseLength(el.attr("cx"), 0.0);
      const std::optional<double> cy = parseLength(el.attr("cy"), 0.0);
      std::optional<double> rx, ry;
      if (el.name == "circle") {
        const std::optional<double> r = parseLength(el.attr("r"), -1.0);
        rx = r;
        ry = r;
      } else {
        rx = parseLength(el.attr("rx"), -1.0);
        ry = parseLength(el.attr("ry"), -1.0);
      }
      if (!cx || !cy || !rx || !ry || !(*rx > 0) || !(*ry > 0)) return std::nullopt;
      ellipsePath(&path, *cx, *cy, *rx, *ry);
    } else if (el.name == "rect") {
      const std::optional<double> x = parseLength(el.attr("x"), 0.0);
      const std::optional<double> y = parseLength(el.attr("y"), 0.0);
      const std::optional<double> w = parseLength(el.attr("width"), -1.0);
      const std::optional<double> h = parseLength(el.attr("height"), -1.0);
      std::optional<double> rx = parseLength(el.attr("rx"), 0.0);
      std::optional<double> ry = parseLength(el.attr("ry"), 0.0);
      if (!x || !y || !w || !h || !rx || !ry || !(*w > 0) || !(*h > 0)) return std::nullopt;
      if (*rx > 0 && *ry == 0) ry = rx;
      if (*ry > 0 && *rx == 0) rx = ry;
      roundedRectPath(&path, *x, *y, *w, *h, *rx, *ry);
    } else if (el.name == "polygon" || el.name == "polyline") {
      const std::string* points = el.attr("points");
      if (points == nullptr || !polygonPath(*points, el.name == "polygon", &path)) return std::nullopt;
      if (el.name == "polyline" && el.attr("fill") == nullptr) path.hasFill = false;
    } else if (el.name == "line") {
      const std::optional<double> x1 = parseLength(el.attr("x1"), 0.0);
      const std::optional<double> y1 = parseLength(el.attr("y1"), 0.0);
      const std::optional<double> x2 = parseLength(el.attr("x2"), 0.0);
      const std::optional<double> y2 = parseLength(el.attr("y2"), 0.0);
      if (!x1 || !y1 || !x2 || !y2) return std::nullopt;
      path.hasFill = false;
      moveTo(&path, *x1, *y1);
      lineTo(&path, *x2, *y2);
    } else if (el.name == "title" || el.name == "desc" || el.name == "metadata") {
      continue;  // ignorable
    } else {
      return std::nullopt;
    }
    image.paths.push_back(std::move(path));
  }
  if (!sawRoot || image.paths.empty()) return std::nullopt;
  return image;
}

VectorImage markerBaseShape(MarkerShape shape) {
  VectorImage image;
  if (shape == MarkerShape::Dot) {
    // engine-web `SHAPES.dot`: <circle cx=12 cy=12 r=9 fill=currentColor stroke=#fff stroke-width=2.4/>
    image.width = 24;
    image.height = 24;
    VectorPath body;
    body.hasFill = true;
    body.fillCurrent = true;
    body.hasStroke = true;
    body.stroke = 0xFFFFFF;
    body.strokeWidth = 2.4f;
    body.roundJoin = true;
    ellipsePath(&body, 12, 12, 9, 9);
    image.paths.push_back(std::move(body));
    return image;
  }
  // engine-web `SHAPES.pin`: a teardrop whose head is a semicircle (r 10.4 about (12, 11.6)) and whose tip
  // is at (12, 31) — the point that sits on the coordinate with the default `bottom` anchor.
  image.width = 24;
  image.height = 32;
  const double r = 10.4, cx = 12.0, cy = 11.6, k = r * kKappa;
  VectorPath body;
  body.hasFill = true;
  body.fillCurrent = true;
  body.hasStroke = true;
  body.stroke = 0xFFFFFF;
  body.strokeWidth = 2.0f;
  body.roundJoin = true;
  moveTo(&body, cx, 31.0);
  curveTo(&body, cx, 31.0, cx + r, 19.4, cx + r, cy);
  curveTo(&body, cx + r, cy - k, cx + k, cy - r, cx, cy - r);
  curveTo(&body, cx - k, cy - r, cx - r, cy - k, cx - r, cy);
  curveTo(&body, cx - r, 19.4, cx, 31.0, cx, 31.0);
  close(&body);
  image.paths.push_back(std::move(body));
  VectorPath inner;
  inner.hasFill = true;
  inner.fill = 0xFFFFFF;
  inner.fillOpacity = 0.93f;
  inner.hasStroke = false;
  ellipsePath(&inner, 12.0, 11.4, 4.1, 4.1);
  image.paths.push_back(std::move(inner));
  return image;
}

std::optional<VectorImage> parseSvgDataUri(std::string_view uri) {
  const std::optional<DataUri> data = parseDataUri(uri);
  if (!data || data->mediaType.find("svg") == std::string::npos) return std::nullopt;
  return parseSvg(data->bytes);
}

}  // namespace maprama
