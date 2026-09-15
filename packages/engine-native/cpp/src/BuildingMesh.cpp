#include "maprama/BuildingMesh.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <utility>

#include "maprama/RoadGraph.hpp"  // js_math::Mulberry32 (engine-web mulberry32)

namespace maprama {

namespace {

constexpr double kPi = 3.14159265358979323846;
/// MapLibre `util::EARTH_RADIUS_M` (the web-mercator sphere) and latitude clamp.
constexpr double kMercatorEarthRadius = 6378137.0;
constexpr double kMaxLatitude = 85.051128779806604;
/// MapLibre `util::tileSize_D`.
constexpr double kTileSize = 512.0;

// engine-web BuildingRenderer constants (world units).
constexpr double kStoreBand = 0.42;
constexpr double kFloor = 0.375;
/// Facade quads sit this far outside the extrusion walls (the shaders add a depth bias too).
constexpr double kFacadeOut = 0.006;
/// Outline width (dp) standing in for engine-web's 0.07-unit ink hull.
constexpr float kOutlineWidthDp = 2.0f;
/// Vertical outline edges are drawn where the footprint turns by more than this (sin 20°).
constexpr double kCornerTurn = 0.342;

// engine-web colours (textures reduced to their base colour; `INK` is the toy preset's outline ink).
constexpr std::uint32_t kInk = 0x2A2540;
constexpr std::uint32_t kWhite = 0xFFFFFF;
constexpr std::uint32_t kPoleColor = 0xE8E8E8;
constexpr std::uint32_t kRoofTiles = 0x6E5E56;
constexpr std::uint32_t kMetalRoof = 0x6B7078;
constexpr std::uint32_t kDomeMetal = 0x8E9AA3;
constexpr std::uint32_t kGravel = 0x8B8984;
constexpr std::uint32_t kParapet = 0xB0ABA2;
constexpr std::uint32_t kMembrane = 0xC7C9C6;
constexpr std::uint32_t kModernParapet = 0xF1F0EC;
constexpr std::uint32_t kHvac = 0xB4B7BB;
constexpr std::uint32_t kDeck = 0xA7815F;
constexpr std::uint32_t kDeckUrban = 0x8E9295;
constexpr std::uint32_t kPlanter = 0x6F6A64;
constexpr std::uint32_t kSolar = 0x2C3A52;
constexpr std::uint32_t kSoftDome = 0xFFFDF8;
constexpr std::uint32_t kStorefront = 0x393A3D;
constexpr std::uint32_t kStoreGlass = 0x9FB4C0;
constexpr std::uint32_t kTrimReal = 0xBDB8AE;
constexpr std::uint32_t kTrimDefault = 0xEDEBE6;
/// engine-web `URBAN_SCHEMES[].trim`.
constexpr std::array<std::uint32_t, 5> kUrbanTrims{0x8A6D4A, 0x3A3F45, 0xC2AB84, 0xAEB7BF, 0xF1F2EF};

using Ring = std::vector<Vec2>;

// ---------------------------------------------------------------------------------------------------
// engine-web `world/polygon.ts`
// ---------------------------------------------------------------------------------------------------

double signedArea(const Ring& poly) {
  double a = 0;
  for (std::size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
    const Vec2& p = poly[i];
    const Vec2& q = poly[j];
    a += q[0] * p[1] - p[0] * q[1];
  }
  return a / 2;
}

Ring dedupeRing(const Ring& poly, double eps = 1e-6) {
  Ring out;
  for (const Vec2& p : poly) {
    if (out.empty() || std::fabs(out.back()[0] - p[0]) > eps || std::fabs(out.back()[1] - p[1]) > eps) out.push_back(p);
  }
  if (out.size() > 1 && std::fabs(out.front()[0] - out.back()[0]) <= eps && std::fabs(out.front()[1] - out.back()[1]) <= eps) {
    out.pop_back();
  }
  return out;
}

Ring normalizeRing(const Ring& poly) {
  Ring out = dedupeRing(poly);
  if (signedArea(out) < 0) std::reverse(out.begin(), out.end());
  return out;
}

Vec2 centroid(const Ring& poly) {
  const double a = signedArea(poly);
  if (std::fabs(a) < 1e-9) {
    double x = 0, z = 0;
    for (const Vec2& p : poly) {
      x += p[0];
      z += p[1];
    }
    const double n = std::max<double>(1, static_cast<double>(poly.size()));
    return {x / n, z / n};
  }
  double cx = 0, cz = 0;
  for (std::size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
    const Vec2& p = poly[i];
    const Vec2& q = poly[j];
    const double f = q[0] * p[1] - p[0] * q[1];
    cx += (q[0] + p[0]) * f;
    cz += (q[1] + p[1]) * f;
  }
  return {cx / (6 * a), cz / (6 * a)};
}

bool pointInPolygon(double x, double z, const Ring& poly) {
  bool inside = false;
  for (std::size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
    const double xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) != (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

struct Bbox {
  double minX, minZ, maxX, maxZ;
};

Bbox bbox(const Ring& poly) {
  Bbox b{std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity(),
         -std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity()};
  for (const Vec2& p : poly) {
    b.minX = std::min(b.minX, p[0]);
    b.maxX = std::max(b.maxX, p[0]);
    b.minZ = std::min(b.minZ, p[1]);
    b.maxZ = std::max(b.maxZ, p[1]);
  }
  return b;
}

/// Mitered offset of a normalized ring (positive = outward), miters clamped to 4·|d|.
Ring offsetRing(const Ring& ring, double d) {
  const std::size_t n = ring.size();
  Ring out;
  out.reserve(n);
  for (std::size_t i = 0; i < n; ++i) {
    const Vec2& p = ring[(i + n - 1) % n];
    const Vec2& c = ring[i];
    const Vec2& q = ring[(i + 1) % n];
    double ax = c[0] - p[0], az = c[1] - p[1];
    double bx = q[0] - c[0], bz = q[1] - c[1];
    double la = std::hypot(ax, az), lb = std::hypot(bx, bz);
    if (la == 0) la = 1;
    if (lb == 0) lb = 1;
    ax /= la;
    az /= la;
    bx /= lb;
    bz /= lb;
    const double n1x = az, n1z = -ax, n2x = bz, n2z = -bx;
    double mx = n1x + n2x, mz = n1z + n2z;
    const double ml = std::hypot(mx, mz);
    if (ml < 1e-6) {
      mx = n1x;
      mz = n1z;
    } else {
      mx /= ml;
      mz /= ml;
    }
    const double cosine = mx * n1x + mz * n1z;
    double k = d / std::max(cosine, 1e-3);
    const double lim = 4 * std::fabs(d);
    if (std::fabs(k) > lim) k = (k < 0 ? -1 : 1) * lim;
    out.push_back({c[0] + mx * k, c[1] + mz * k});
  }
  return out;
}

struct Rect {
  double x, z, w, d, yaw;
};

/// engine-web `asRectangle`: near-rectangular 4-vertex rings (yaw along the first edge).
std::optional<Rect> asRectangle(const Ring& ring, double angleTolDeg = 6) {
  if (ring.size() != 4) return std::nullopt;
  const double cosTol = std::sin(angleTolDeg * kPi / 180);
  for (std::size_t i = 0; i < 4; ++i) {
    const Vec2& p = ring[(i + 3) % 4];
    const Vec2& c = ring[i];
    const Vec2& q = ring[(i + 1) % 4];
    const double ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
    const double la = std::hypot(ax, az), lb = std::hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) return std::nullopt;
    if (std::fabs((ax * bx + az * bz) / (la * lb)) > cosTol) return std::nullopt;
  }
  const Vec2& p0 = ring[0];
  const Vec2& p1 = ring[1];
  const Vec2& p3 = ring[3];
  const Vec2 c = centroid(ring);
  return Rect{c[0], c[1], std::hypot(p1[0] - p0[0], p1[1] - p0[1]), std::hypot(p3[0] - p0[0], p3[1] - p0[1]),
              std::atan2(-(p1[1] - p0[1]), p1[0] - p0[0])};
}

/// engine-web `insideRadius`.
double insideRadius(const Ring& ring, double x, double z) {
  double best = std::numeric_limits<double>::infinity();
  for (std::size_t i = 0; i < ring.size(); ++i) {
    const Vec2& a = ring[i];
    const Vec2& b = ring[(i + 1) % ring.size()];
    const double dx = b[0] - a[0], dz = b[1] - a[1];
    double l2 = dx * dx + dz * dz;
    if (l2 == 0) l2 = 1;
    const double t = std::max(0.0, std::min(1.0, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    best = std::min(best, std::hypot(a[0] + dx * t - x, a[1] + dz * t - z));
  }
  return std::isfinite(best) ? best : 0;
}

bool fits(const Ring& ring, double cx, double cz, double w, double d) {
  return pointInPolygon(cx - w / 2, cz - d / 2, ring) && pointInPolygon(cx + w / 2, cz - d / 2, ring) &&
         pointInPolygon(cx + w / 2, cz + d / 2, ring) && pointInPolygon(cx - w / 2, cz + d / 2, ring);
}

/// Ear clipping of a simple polygon in x/z (any winding). Falls back to a fan when no ear is found
/// (self-intersecting offset rings).
std::vector<std::array<std::size_t, 3>> triangulate(const Ring& ring) {
  std::vector<std::array<std::size_t, 3>> out;
  const std::size_t n = ring.size();
  if (n < 3) return out;
  std::vector<std::size_t> v(n);
  for (std::size_t i = 0; i < n; ++i) v[i] = i;
  if (signedArea(ring) < 0) std::reverse(v.begin(), v.end());
  const auto cross = [&](std::size_t a, std::size_t b, std::size_t c) {
    return (ring[b][0] - ring[a][0]) * (ring[c][1] - ring[a][1]) - (ring[b][1] - ring[a][1]) * (ring[c][0] - ring[a][0]);
  };
  const auto inside = [&](std::size_t p, std::size_t a, std::size_t b, std::size_t c) {
    const double d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    return d1 >= 0 && d2 >= 0 && d3 >= 0;
  };
  // Positive shoelace area in engine-web's formula is counter-clockwise in (x, z) math orientation, where
  // a convex corner has a positive `cross` (x right, z up).
  while (v.size() > 3) {
    bool clipped = false;
    for (std::size_t i = 0; i < v.size(); ++i) {
      const std::size_t a = v[(i + v.size() - 1) % v.size()], b = v[i], c = v[(i + 1) % v.size()];
      if (cross(a, b, c) <= 1e-12) continue;
      bool ear = true;
      for (std::size_t k : v) {
        if (k == a || k == b || k == c) continue;
        if (inside(k, a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push_back({a, b, c});
      v.erase(v.begin() + static_cast<std::ptrdiff_t>(i));
      clipped = true;
      break;
    }
    if (!clipped) {
      for (std::size_t i = 1; i + 1 < v.size(); ++i) out.push_back({v[0], v[i], v[i + 1]});
      return out;
    }
  }
  out.push_back({v[0], v[1], v[2]});
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Colours (engine-web `util/math.ts`, sRGB)
// ---------------------------------------------------------------------------------------------------

int channelOf(std::uint32_t c, int shift) { return static_cast<int>((c >> shift) & 0xFF); }

std::uint32_t toHex(double r, double g, double b) {
  const auto ch = [](double v) {
    const double x = std::floor(v + 0.5);
    return static_cast<std::uint32_t>(std::max(0.0, std::min(255.0, x)));
  };
  return (ch(r) << 16) | (ch(g) << 8) | ch(b);
}

/// Per-channel product (a texture texel multiplied by the material colour).
std::uint32_t mulColor(std::uint32_t a, std::uint32_t b) {
  return toHex(channelOf(a, 16) * channelOf(b, 16) / 255.0, channelOf(a, 8) * channelOf(b, 8) / 255.0,
               channelOf(a, 0) * channelOf(b, 0) / 255.0);
}

/// engine-web `offsetHslHex`.
std::uint32_t offsetHsl(std::uint32_t hex, double dh, double ds, double dl) {
  const double r = channelOf(hex, 16) / 255.0, g = channelOf(hex, 8) / 255.0, b = channelOf(hex, 0) / 255.0;
  const double mx = std::max({r, g, b}), mn = std::min({r, g, b});
  double h = 0, s = 0;
  const double l = (mn + mx) / 2;
  if (mn != mx) {
    const double delta = mx - mn;
    s = l <= 0.5 ? delta / (mx + mn) : delta / (2 - mx - mn);
    if (mx == r) {
      h = (g - b) / delta + (g < b ? 6 : 0);
    } else if (mx == g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h /= 6;
  }
  h = std::fmod(std::fmod(h + dh, 1.0) + 1.0, 1.0);
  s = std::max(0.0, std::min(1.0, s + ds));
  const double L = std::max(0.0, std::min(1.0, l + dl));
  const auto hue2rgb = [](double p, double q, double t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1.0 / 6) return p + (q - p) * 6 * t;
    if (t < 1.0 / 2) return q;
    if (t < 2.0 / 3) return p + (q - p) * 6 * (2.0 / 3 - t);
    return p;
  };
  if (s == 0) return toHex(L * 255, L * 255, L * 255);
  const double q = L <= 0.5 ? L * (1 + s) : L + s - L * s;
  const double p = 2 * L - q;
  return toHex(hue2rgb(p, q, h + 1.0 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1.0 / 3) * 255);
}

// ---------------------------------------------------------------------------------------------------
// Facade looks: engine-web's facade textures (`theme/textures.ts`) as window-pattern parameters.
// `wall` / `glass` are the texture colours the building colour multiplies (three.js `color × map`).
// ---------------------------------------------------------------------------------------------------

struct FacadeLook {
  FacadePattern pattern;
  /// One texture tile (U, V world units) and its window cells (the textures hold 4×4, toy / soft 2×2).
  double tileU, cellU, cellV;
  double x0, x1, y0, y1;
  std::uint32_t wall;
  std::uint32_t glass;
  /// engine-web detail family: `u` of the facade key without its `m_` / `u_` prefix.
  enum class Family : std::uint8_t { Glass, Bands, Balconies, Masonry, Other } family;
};

// REAL: glass / office / apartment / brick.
constexpr FacadeLook kRealGlass{FacadePattern::Curtain, 3.0, 0.75, 0.375, 0.05, 1, 0.08, 1, 0xCFD4D8, 0x50677A, FacadeLook::Family::Glass};
constexpr FacadeLook kRealOffice{FacadePattern::Ribbon, 3.0, 0.75, 0.375, 0.03, 1, 0.30, 0.70, 0xBCB6AB, 0x4D5B66, FacadeLook::Family::Bands};
constexpr FacadeLook kRealApartment{FacadePattern::Punched, 3.0, 0.75, 0.375, 0.08, 0.66, 0.30, 0.84, 0xDFD9CF, 0x55616B, FacadeLook::Family::Balconies};
constexpr FacadeLook kRealBrick{FacadePattern::Punched, 3.0, 0.75, 0.375, 0.14, 0.62, 0.30, 0.86, 0xB2A291, 0x2B2F33, FacadeLook::Family::Masonry};
// MODERN: glass / band / resi / terracotta.
constexpr FacadeLook kModernGlass{FacadePattern::Curtain, 3.0, 0.75, 0.375, 0.03, 1, 0.19, 1, 0xE4EAEE, 0x6A8190, FacadeLook::Family::Glass};
constexpr FacadeLook kModernBand{FacadePattern::Ribbon, 3.0, 0.75, 0.375, 0.03, 1, 0.17, 0.69, 0xF1F0EC, 0x55646E, FacadeLook::Family::Bands};
constexpr FacadeLook kModernResi{FacadePattern::Punched, 3.0, 0.75, 0.375, 0.06, 0.69, 0.25, 0.91, 0xEFEBE4, 0x3A3F44, FacadeLook::Family::Balconies};
constexpr FacadeLook kModernTerracotta{FacadePattern::Punched, 3.0, 0.75, 0.375, 0.10, 0.62, 0.30, 0.95, 0xC48B6B, 0x26292C, FacadeLook::Family::Masonry};
// URBAN: glass / panel / grid / concrete.
constexpr FacadeLook kUrbanGlass{FacadePattern::Curtain, 3.0, 0.75, 0.375, 0.10, 1, 0.05, 1, 0xCDD2D6, 0x50606C, FacadeLook::Family::Glass};
constexpr FacadeLook kUrbanPanel{FacadePattern::Ribbon, 3.0, 0.75, 0.375, 0.04, 1, 0.20, 0.70, 0xD9DFE2, 0x3F4B55, FacadeLook::Family::Bands};
constexpr FacadeLook kUrbanGrid{FacadePattern::Punched, 3.0, 0.75, 0.375, 0.14, 0.86, 0.22, 0.84, 0xD6D9DA, 0x4F5E6A, FacadeLook::Family::Balconies};
constexpr FacadeLook kUrbanConcrete{FacadePattern::Ribbon, 3.0, 0.75, 0.375, 0.05, 1, 0.23, 0.59, 0xB5B7B6, 0x3A444C, FacadeLook::Family::Masonry};
// toy / soft.
constexpr FacadeLook kToy{FacadePattern::Punched, 2.2, 1.1, 0.75, 0.27, 0.73, 0.28, 0.69, 0xFFFFFF, 0x9EB2DA, FacadeLook::Family::Other};
constexpr FacadeLook kSoft{FacadePattern::Punched, 1.2, 0.6, 0.45, 0.19, 0.81, 0.30, 0.83, 0xFFFFFF, 0xB8D3F7, FacadeLook::Family::Other};

/// engine-web's facade key selection (`fk`), with `ukey` for the urban set (data worlds carry explicit kinds).
const FacadeLook& facadeLookFor(FacadeSet set, BuildingKind kind, double scaledHeight) {
  switch (set) {
    case FacadeSet::Real:
      switch (kind) {
        case BuildingKind::Glass:
          return kRealGlass;
        case BuildingKind::Office:
          return kRealOffice;
        case BuildingKind::Apartment:
          return kRealApartment;
        case BuildingKind::Brick:
          return kRealBrick;
      }
      break;
    case FacadeSet::Modern:
      switch (kind) {
        case BuildingKind::Glass:
          return kModernGlass;
        case BuildingKind::Office:
          return kModernBand;
        case BuildingKind::Apartment:
          return kModernResi;
        case BuildingKind::Brick:
          return kModernTerracotta;
      }
      break;
    case FacadeSet::Urban: {
      const BuildingKind ukey = scaledHeight > 6.5 || kind == BuildingKind::Glass ? BuildingKind::Glass : kind;
      switch (ukey) {
        case BuildingKind::Glass:
          return kUrbanGlass;
        case BuildingKind::Office:
          return kUrbanPanel;
        case BuildingKind::Apartment:
          return kUrbanGrid;
        case BuildingKind::Brick:
          return kUrbanConcrete;
      }
      break;
    }
    case FacadeSet::Soft:
      return kSoft;
    case FacadeSet::Toy:
    case FacadeSet::None:
      return kToy;
  }
  return kToy;
}

std::uint8_t unit8(double v) { return static_cast<std::uint8_t>(std::max(0.0, std::min(255.0, std::floor(v * 255.0 + 0.5)))); }

// ---------------------------------------------------------------------------------------------------
// Mesh builder (building-local frame: x = u, y up, z = v; engine-web's group transform)
// ---------------------------------------------------------------------------------------------------

struct P3 {
  double x, y, z;
};

struct Surface {
  std::uint32_t color = kWhite;
  FacadePattern pattern = FacadePattern::None;
  float cellU = 0.f;
  float cellV = 0.f;
  std::array<std::uint8_t, 4> window{0, 0, 0, 0};
  std::uint32_t glass = 0;
};

class MeshBuilder {
 public:
  MeshBuilder(const Projection& projection, double unitMeters, BuildingLayerData& out)
      : projection_(projection), unitMeters_(unitMeters), out_(out) {}

  /// Building transform (three.js `rotation.y = yaw`, position (x, 0, z)) and the wall shading ramp.
  void begin(double x, double z, double yaw, double wallTop, float gradientMin, float gradientTop, std::uint8_t seed) {
    fx_ = x;
    fz_ = z;
    c_ = std::cos(yaw);
    s_ = std::sin(yaw);
    wallTop_ = wallTop;
    gMin_ = gradientMin;
    gTop_ = gradientTop;
    seed_ = seed;
  }

  std::array<float, 3> place(const P3& p) const {
    const WorldPoint w{fx_ + p.x * c_ + p.z * s_, fz_ - p.x * s_ + p.z * c_};
    const std::array<double, 2> m = lngLatToMercator(projection_.toLngLat(w));
    return {static_cast<float>((m[0] - out_.originX) * out_.unitsPerMercator),
            static_cast<float>((m[1] - out_.originY) * out_.unitsPerMercator), static_cast<float>(p.y * unitMeters_)};
  }

  std::uint32_t vertex(const P3& p, P3 n, const Surface& s, double u = 0, double v = 0) {
    BuildingMeshVertex vx{};
    const std::array<float, 3> pos = place(p);
    std::memcpy(vx.position, pos.data(), sizeof vx.position);
    // Local -> world (x east, z south) -> (east, south, up).
    const double east = n.x * c_ + n.z * s_;
    const double south = -n.x * s_ + n.z * c_;
    const double up = n.y;
    const double len = std::sqrt(east * east + south * south + up * up);
    const auto snorm = [len](double c) {
      return static_cast<std::int8_t>(std::max(-127.0, std::min(127.0, std::floor(c / (len > 0 ? len : 1) * 127.0 + 0.5))));
    };
    vx.normal[0] = snorm(east);
    vx.normal[1] = snorm(south);
    vx.normal[2] = len > 0 ? snorm(up) : 127;
    vx.normal[3] = static_cast<std::int8_t>(static_cast<std::uint8_t>(s.pattern));
    vx.color[0] = static_cast<std::uint8_t>(channelOf(s.color, 16));
    vx.color[1] = static_cast<std::uint8_t>(channelOf(s.color, 8));
    vx.color[2] = static_cast<std::uint8_t>(channelOf(s.color, 0));
    vx.color[3] = 255;
    vx.facade[0] = static_cast<float>(u);
    vx.facade[1] = static_cast<float>(v);
    // MapLibre applies the vertical gradient on faces with a zero vertical normal only.
    const bool vertical = std::fabs(up) < 1e-9 * (len > 0 ? len : 1);
    vx.shade = vertical ? shadeAt(p.y) : 1.f;
    vx.cell[0] = s.cellU;
    vx.cell[1] = s.cellV;
    std::memcpy(vx.window, s.window.data(), 4);
    vx.glass[0] = static_cast<std::uint8_t>(channelOf(s.glass, 16));
    vx.glass[1] = static_cast<std::uint8_t>(channelOf(s.glass, 8));
    vx.glass[2] = static_cast<std::uint8_t>(channelOf(s.glass, 0));
    vx.glass[3] = seed_;
    out_.vertices.push_back(vx);
    return static_cast<std::uint32_t>(out_.vertices.size() - 1);
  }

  void triangle(std::uint32_t a, std::uint32_t b, std::uint32_t c) {
    out_.indices.push_back(a);
    out_.indices.push_back(b);
    out_.indices.push_back(c);
    if (detail_) return;
    out_.lowDetailIndices.push_back(a);
    out_.lowDetailIndices.push_back(b);
    out_.lowDetailIndices.push_back(c);
  }

  /// M4: triangles emitted while `on` (facade details, roof furniture) are left out of the low-detail range.
  void setDetail(bool on) { detail_ = on; }

  /// A planar convex face (fan), flat normal from Newell's method.
  void face(const std::vector<P3>& pts, const Surface& s) {
    if (pts.size() < 3) return;
    P3 n{0, 0, 0};
    for (std::size_t i = 0; i < pts.size(); ++i) {
      const P3& a = pts[i];
      const P3& b = pts[(i + 1) % pts.size()];
      n.x += (a.y - b.y) * (a.z + b.z);
      n.y += (a.z - b.z) * (a.x + b.x);
      n.z += (a.x - b.x) * (a.y + b.y);
    }
    std::vector<std::uint32_t> ids;
    ids.reserve(pts.size());
    for (const P3& p : pts) ids.push_back(vertex(p, n, s));
    for (std::size_t i = 1; i + 1 < ids.size(); ++i) triangle(ids[0], ids[i], ids[i + 1]);
  }

  /// Walls of a ring from y0 to y0 + h (outward normals for a positive-area ring, or inward).
  /// `uv`: window pattern coordinates (u along the ring from `uOffset`, v from the wall bottom).
  void walls(const Ring& ring, double y0, double h, const Surface& s, bool inward = false, double uOffset = 0) {
    const std::size_t n = ring.size();
    double dist = 0;
    for (std::size_t i = 0; i < n; ++i) {
      const Vec2& A = ring[i];
      const Vec2& B = ring[(i + 1) % n];
      const double dx = B[0] - A[0], dz = B[1] - A[1], L = std::hypot(dx, dz);
      if (L < 1e-6) continue;
      P3 nrm{dz / L, 0, -dx / L};
      if (inward) nrm = {-nrm.x, 0, -nrm.z};
      const double u0 = dist + uOffset, u1 = dist + L + uOffset;
      const std::uint32_t a0 = vertex({A[0], y0, A[1]}, nrm, s, u0, 0);
      const std::uint32_t b0 = vertex({B[0], y0, B[1]}, nrm, s, u1, 0);
      const std::uint32_t b1 = vertex({B[0], y0 + h, B[1]}, nrm, s, u1, h);
      const std::uint32_t a1 = vertex({A[0], y0 + h, A[1]}, nrm, s, u0, h);
      triangle(a0, b0, b1);
      triangle(a0, b1, a1);
      dist += L;
    }
  }

  /// Horizontal polygon at y (normal up or down).
  void cap(const Ring& ring, double y, bool up, const Surface& s) {
    const auto tris = triangulate(ring);
    if (tris.empty()) return;
    std::vector<std::uint32_t> ids;
    ids.reserve(ring.size());
    for (const Vec2& p : ring) ids.push_back(vertex({p[0], y, p[1]}, {0, up ? 1.0 : -1.0, 0}, s));
    for (const auto& t : tris) triangle(ids[t[0]], ids[t[1]], ids[t[2]]);
  }

  void prism(const Ring& ring, double y0, double h, const Surface& s) {
    walls(ring, y0, h, s);
    cap(ring, y0 + h, true, s);
  }

  /// engine-web `ringBandGeometry`: a closed band between two rings with the same vertex count.
  void ringBand(const Ring& outer, const Ring& inner, double y0, double h, const Surface& s) {
    walls(outer, y0, h, s);
    walls(inner, y0, h, s, true);
    const std::size_t n = std::min(outer.size(), inner.size());
    for (int side = 0; side < (h > 0.01 ? 2 : 1); ++side) {
      const double y = side == 0 ? y0 + h : y0;
      const P3 nrm{0, side == 0 ? 1.0 : -1.0, 0};
      for (std::size_t i = 0; i < n; ++i) {
        const std::size_t j = (i + 1) % n;
        const std::uint32_t a = vertex({outer[i][0], y, outer[i][1]}, nrm, s);
        const std::uint32_t b = vertex({outer[j][0], y, outer[j][1]}, nrm, s);
        const std::uint32_t c = vertex({inner[j][0], y, inner[j][1]}, nrm, s);
        const std::uint32_t d = vertex({inner[i][0], y, inner[i][1]}, nrm, s);
        triangle(a, b, c);
        triangle(a, c, d);
      }
    }
  }

  /// three.js `BoxGeometry(w, h, d)` [`.rotateX(rx)`] `.rotateY(yaw)` `.translate(x, y, z)`.
  void box(double w, double h, double d, double x, double y, double z, double yaw, const Surface& s, double rx = 0) {
    const double cy = std::cos(yaw), sy = std::sin(yaw), cx = std::cos(rx), sx = std::sin(rx);
    const auto tf = [&](double px, double py, double pz) {
      // rotateX: y' = y cos − z sin, z' = y sin + z cos; rotateY: x'' = x cos + z' sin, z'' = −x sin + z' cos.
      const double y1 = py * cx - pz * sx, z1 = py * sx + pz * cx;
      return P3{x + px * cy + z1 * sy, y + y1, z - px * sy + z1 * cy};
    };
    const double hw = w / 2, hh = h / 2, hd = d / 2;
    const P3 c[8] = {tf(-hw, -hh, -hd), tf(hw, -hh, -hd), tf(hw, hh, -hd), tf(-hw, hh, -hd),
                     tf(-hw, -hh, hd),  tf(hw, -hh, hd),  tf(hw, hh, hd),  tf(-hw, hh, hd)};
    face({c[0], c[3], c[2], c[1]}, s);  // −z
    face({c[4], c[5], c[6], c[7]}, s);  // +z
    face({c[0], c[4], c[7], c[3]}, s);  // −x
    face({c[1], c[2], c[6], c[5]}, s);  // +x
    face({c[3], c[7], c[6], c[2]}, s);  // +y
    face({c[0], c[1], c[5], c[4]}, s);  // −y
  }

  /// Vertical cylinder (smooth sides, flat top) from y0 to y0 + h.
  void cylinder(double r, double h, double x, double y0, double z, int segments, const Surface& s) {
    std::vector<std::uint32_t> bottom, top;
    for (int i = 0; i <= segments; ++i) {
      const double a = 2 * kPi * i / segments;
      const double ca = std::cos(a), sa = std::sin(a);
      bottom.push_back(vertex({x + r * ca, y0, z + r * sa}, {ca, 0, sa}, s));
      top.push_back(vertex({x + r * ca, y0 + h, z + r * sa}, {ca, 0, sa}, s));
    }
    for (int i = 0; i < segments; ++i) {
      triangle(bottom[i], bottom[i + 1], top[i + 1]);
      triangle(bottom[i], top[i + 1], top[i]);
    }
    const std::uint32_t centre = vertex({x, y0 + h, z}, {0, 1, 0}, s);
    std::vector<std::uint32_t> rim;
    for (int i = 0; i < segments; ++i) {
      const double a = 2 * kPi * i / segments;
      rim.push_back(vertex({x + r * std::cos(a), y0 + h, z + r * std::sin(a)}, {0, 1, 0}, s));
    }
    for (int i = 0; i < segments; ++i) triangle(centre, rim[i], rim[(i + 1) % segments]);
  }

  /// Upper hemisphere of radius r (y scaled by `scaleY`) centred at (x, y0, z), smooth normals.
  void hemisphere(double r, double x, double y0, double z, double scaleY, int segments, int rings, const Surface& s) {
    std::vector<std::uint32_t> grid;
    for (int j = 0; j <= rings; ++j) {
      const double theta = (kPi / 2) * j / rings;  // 0 = top
      for (int i = 0; i <= segments; ++i) {
        const double phi = 2 * kPi * i / segments;
        const double px = -std::cos(phi) * std::sin(theta), py = std::cos(theta), pz = std::sin(phi) * std::sin(theta);
        grid.push_back(vertex({x + r * px, y0 + r * py * scaleY, z + r * pz}, {px, py / scaleY, pz}, s));
      }
    }
    const int row = segments + 1;
    for (int j = 0; j < rings; ++j) {
      for (int i = 0; i < segments; ++i) {
        const std::uint32_t a = grid[j * row + i], b = grid[j * row + i + 1], c = grid[(j + 1) * row + i + 1],
                            d = grid[(j + 1) * row + i];
        if (j > 0) triangle(a, b, c);
        triangle(a, c, d);
      }
    }
  }

  /// Regular octahedron (engine-web's planter leaves, `OctahedronGeometry`).
  void octahedron(double r, double x, double y, double z, const Surface& s) {
    const P3 px{x + r, y, z}, nx{x - r, y, z}, py{x, y + r, z}, ny{x, y - r, z}, pz{x, y, z + r}, nz{x, y, z - r};
    face({py, pz, px}, s);
    face({py, px, nz}, s);
    face({py, nz, nx}, s);
    face({py, nx, pz}, s);
    face({ny, px, pz}, s);
    face({ny, nz, px}, s);
    face({ny, nx, nz}, s);
    face({ny, pz, nx}, s);
  }

  /// One screen-space outline segment (4 vertices, 2 triangles).
  void line(const P3& a, const P3& b, std::uint32_t color) {
    const std::array<float, 3> pa = place(a);
    const std::array<float, 3> pb = place(b);
    const auto base = static_cast<std::uint32_t>(out_.lineVertices.size());
    const auto push = [&](const std::array<float, 3>& self, const std::array<float, 3>& other, float side) {
      BuildingLineVertex v{};
      std::memcpy(v.position, self.data(), sizeof v.position);
      std::memcpy(v.other, other.data(), sizeof v.other);
      v.side = side;
      v.color[0] = static_cast<std::uint8_t>(channelOf(color, 16));
      v.color[1] = static_cast<std::uint8_t>(channelOf(color, 8));
      v.color[2] = static_cast<std::uint8_t>(channelOf(color, 0));
      v.color[3] = 255;
      out_.lineVertices.push_back(v);
    };
    push(pa, pb, 1.f);
    push(pa, pb, -1.f);
    push(pb, pa, -1.f);  // the far end sees the segment reversed: its side flips
    push(pb, pa, 1.f);
    for (std::uint32_t i : {0u, 2u, 3u, 0u, 3u, 1u}) out_.lineIndices.push_back(base + i);
  }

  void ringLines(const Ring& ring, double y, std::uint32_t color) {
    for (std::size_t i = 0; i < ring.size(); ++i) {
      const Vec2& a = ring[i];
      const Vec2& b = ring[(i + 1) % ring.size()];
      line({a[0], y, a[1]}, {b[0], y, b[1]}, color);
    }
  }

  void circleLines(double r, double x, double y, double z, int segments, std::uint32_t color) {
    for (int i = 0; i < segments; ++i) {
      const double a0 = 2 * kPi * i / segments, a1 = 2 * kPi * (i + 1) / segments;
      line({x + r * std::cos(a0), y, z + r * std::sin(a0)}, {x + r * std::cos(a1), y, z + r * std::sin(a1)}, color);
    }
  }

 private:
  float shadeAt(double y) const {
    if (wallTop_ <= 0 || y >= wallTop_) return gTop_;
    return gMin_ + (gTop_ - gMin_) * static_cast<float>(std::max(0.0, y) / wallTop_);
  }

  const Projection& projection_;
  double unitMeters_;
  BuildingLayerData& out_;
  double fx_ = 0, fz_ = 0, c_ = 1, s_ = 0, wallTop_ = 0;
  float gMin_ = 1.f, gTop_ = 1.f;
  std::uint8_t seed_ = 0;
  bool detail_ = false;
};

/// engine-web `edgesOf` entry.
struct Edge {
  double ax, az, L, ux, uz, nx, nz, mx, mz, yaw;
};

std::vector<Edge> edgesOf(const Ring& ring) {
  std::vector<Edge> out;
  for (std::size_t i = 0; i < ring.size(); ++i) {
    const Vec2& a = ring[i];
    const Vec2& b = ring[(i + 1) % ring.size()];
    const double dx = b[0] - a[0], dz = b[1] - a[1], L = std::hypot(dx, dz);
    if (L < 1e-4) continue;
    const double ux = dx / L, uz = dz / L;
    out.push_back(Edge{a[0], a[1], L, ux, uz, uz, -ux, a[0] + dx / 2, a[1] + dz / 2, std::atan2(-uz, ux)});
  }
  return out;
}

/// A building mass (box massing: one mass = the whole footprint).
struct Mass {
  Ring ring;
  double x, z, w, d, h;
  bool rect;
};

/// engine-web `longEdges`: the ±z edges of a rectangle (with the footprint's own skew), else long polygon edges.
std::vector<Edge> longEdges(const Mass& m) {
  std::vector<Edge> es = edgesOf(m.ring);
  std::vector<Edge> out;
  if (m.rect) {
    for (const Edge& e : es) {
      if (std::fabs(e.uz) < 0.2) out.push_back(e);
    }
    return out;
  }
  double maxL = 0;
  for (const Edge& e : es) maxL = std::max(maxL, e.L);
  for (const Edge& e : es) {
    if (e.L >= std::max(1.5, maxL * 0.5)) out.push_back(e);
  }
  return out;
}

/// engine-web's front edge (longest, then southernmost midpoint).
std::optional<Edge> frontEdge(const Ring& ring) {
  std::vector<Edge> es = edgesOf(ring);
  if (es.empty()) return std::nullopt;
  std::stable_sort(es.begin(), es.end(), [](const Edge& a, const Edge& b) {
    if (a.L != b.L) return a.L > b.L;
    return a.mz > b.mz;
  });
  return es.front();
}

/// engine-web `convertBuilding` kind for data worlds without an explicit kind.
BuildingKind kindFor(const BuildingFootprint& b, double h) {
  if (b.kind) return *b.kind;
  js_math::Mulberry32 rnd(static_cast<double>(hashId(b.id)));
  if (h > 5.0) return BuildingKind::Glass;
  if (h > 3.2) return rnd() < 0.55 ? BuildingKind::Apartment : BuildingKind::Office;
  return rnd() < 0.5 ? BuildingKind::Brick : BuildingKind::Office;
}

struct Context {
  const ResolvedTheme& theme;
  const MapLook& look;
  MeshBuilder& mesh;
  std::uint32_t tint(std::uint32_t c) const { return applyTint(c, look.tint); }
  Surface plain(std::uint32_t tintedColor) const {
    Surface s;
    s.color = tintedColor;
    return s;
  }
};

/// engine-web `flatRoof` (box massing, no garden); returns the roof top.
double flatRoof(Context& cx, const Mass& m, double top, js_math::Mulberry32& br, std::uint32_t col, BuildingKind kind) {
  MeshBuilder& mesh = cx.mesh;
  const FacadeSet set = cx.theme.preset.facade;
  const Ring& ring = m.ring;
  const auto fitBox = [&](double w, double d, double x, double z) { return fits(ring, x, z, w, d); };
  if (set == FacadeSet::Soft) {
    if (std::min(m.w, m.d) > 1.6 && br() < 0.4) {
      const double inside = pointInPolygon(m.x, m.z, ring) ? insideRadius(ring, m.x, m.z) : 0;
      const double r = m.rect ? std::min(m.w, m.d) * 0.3 : std::min(std::min(m.w, m.d) * 0.3, inside * 0.8);
      if (r > 0.2) mesh.hemisphere(r, m.x, top - 0.02, m.z, 0.6, 22, 8, cx.plain(cx.tint(kSoftDome)));
    }
    return top + 0.02;
  }
  if (set == FacadeSet::Real) {
    mesh.prism(offsetRing(ring, -0.01), top, 0.06, cx.plain(cx.tint(kGravel)));
    mesh.ringBand(ring, offsetRing(ring, -0.12), top, 0.2, cx.plain(cx.tint(kParapet)));
    const double rt = top + 0.06;
    const Surface hvac = cx.plain(cx.tint(kHvac));
    mesh.setDetail(true);  // roof furniture: not in the zoom-out low-detail range
    if (kind == BuildingKind::Glass) {
      const double w = m.w * 0.42, d = m.d * 0.36, x = m.x + m.w * 0.1, z = m.z - m.d * 0.12;
      if (fitBox(w, d, x, z)) mesh.box(w, 0.55, d, x, rt + 0.275, z, 0, hvac);
    }
    const int n = 1 + static_cast<int>(std::floor(br() * 3));
    for (int k = 0; k < n; ++k) {
      const double sx = 0.35 + br() * 0.5, sz = 0.3 + br() * 0.4;
      const double x = m.x + (br() - 0.5) * (m.w - 1.2), z = m.z + (br() - 0.5) * (m.d - 1.2);
      if (fitBox(sx, sz, x, z)) mesh.box(sx, 0.3, sz, x, rt + 0.15, z, 0, hvac);
    }
    mesh.setDetail(false);
    return rt;
  }
  if (set == FacadeSet::Modern || set == FacadeSet::Urban) {
    mesh.prism(offsetRing(ring, -0.01), top, 0.04, cx.plain(cx.tint(kMembrane)));
    mesh.ringBand(ring, offsetRing(ring, -0.07), top, 0.12, cx.plain(cx.tint(kModernParapet)));
    const double rt = top + 0.04;
    if (m.w < 1.3 || m.d < 1.3) return rt;
    mesh.setDetail(true);  // roof furniture: not in the zoom-out low-detail range
    const double pick = br();
    if (pick < 0.4) {
      const double dw = m.w * 0.5, dd = m.d * 0.45, dx = m.x - m.w * 0.12, dz = m.z + m.d * 0.1;
      if (fitBox(dw, dd, dx, dz)) {
        mesh.box(dw, 0.03, dd, dx, rt + 0.015, dz, 0, cx.plain(cx.tint(set == FacadeSet::Urban ? kDeckUrban : kDeck)));
      }
      for (int k = 0; k < 2; ++k) {
        const double px = m.x + (k ? 0.25 : -0.3) * m.w, pz = m.z - m.d * 0.26;
        if (!fitBox(0.34, 0.34, px, pz)) continue;
        mesh.box(0.34, 0.14, 0.34, px, rt + 0.07, pz, 0, cx.plain(cx.tint(kPlanter)));
        mesh.octahedron(0.2, px, rt + 0.3, pz, cx.plain(cx.tint(cx.theme.preset.leafA)));
      }
    } else if (pick < 0.75) {
      const int cols = std::min(3, std::max(1, static_cast<int>(std::floor((m.w - 0.4) / 0.5))));
      const int rows = std::min(2, std::max(1, static_cast<int>(std::floor((m.d - 0.4) / 0.45))));
      const Surface solar = cx.plain(cx.tint(kSolar));
      for (int i = 0; i < cols; ++i) {
        for (int j = 0; j < rows; ++j) {
          const double x = m.x - (cols - 1) * 0.25 + i * 0.5, z = m.z - (rows - 1) * 0.225 + j * 0.45;
          if (!fitBox(0.42, 0.34, x, z)) continue;
          mesh.box(0.42, 0.025, 0.34, x, rt + 0.12, z, 0, solar, -0.35);
        }
      }
    } else {
      const double w = m.w * 0.35, d = m.d * 0.3, x = m.x + m.w * 0.15, z = m.z - m.d * 0.15;
      if (fitBox(w, d, x, z)) mesh.box(w, 0.3, d, x, rt + 0.15, z, 0, cx.plain(cx.tint(kHvac)));
    }
    mesh.setDetail(false);
    return rt;
  }
  // toy / none: the light overhanging cap slab.
  mesh.prism(offsetRing(ring, 0.12), top, 0.22, cx.plain(mixColor(col, kWhite, 0.45)));
  return top + 0.22;
}

}  // namespace

// ---------------------------------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------------------------------

std::array<double, 2> lngLatToMercator(const LngLat& lngLat) {
  const double lat = std::max(-kMaxLatitude, std::min(kMaxLatitude, lngLat.lat));
  const double x = (180.0 + lngLat.lng) / 360.0;
  const double y = (180.0 - (180.0 / kPi) * std::log(std::tan(kPi / 4 + lat * kPi / 360.0))) / 360.0;
  return {x, y};
}

LngLat mercatorToLngLat(double x, double y) {
  const double y2 = 180.0 - y * 360.0;
  return LngLat{x * 360.0 - 180.0, 360.0 / kPi * std::atan(std::exp(y2 * kPi / 180.0)) - 90.0};
}

BuildingLayerLight buildingLayerLight(const MapLight& light) {
  BuildingLayerLight out;
  // MapLibre `Position::calculateCartesian` (floats) with anchor `map` (no bearing rotation).
  const float a = static_cast<float>((light.azimuthal + 90.0) * kPi / 180.0);
  const float p = static_cast<float>(light.polar * kPi / 180.0);
  const float r = static_cast<float>(light.radial);
  out.position[0] = r * std::cos(a) * std::sin(p);
  out.position[1] = r * std::sin(a) * std::sin(p);
  out.position[2] = r * std::cos(p);
  out.color[0] = static_cast<float>(((light.color >> 16) & 0xFF) / 255.0);
  out.color[1] = static_cast<float>(((light.color >> 8) & 0xFF) / 255.0);
  out.color[2] = static_cast<float>((light.color & 0xFF) / 255.0);
  out.intensity = static_cast<float>(light.intensity);
  return out;
}

std::array<float, 16> buildingLayerMatrix(const std::array<double, 16>& projection, double zoom, const BuildingLayerData& data) {
  const double worldSize = kTileSize * std::pow(2.0, zoom);
  const double k = worldSize / data.unitsPerMercator;
  // Column-major local units -> world pixels: scale (k, k, 1), translate (origin · worldSize).
  const std::array<double, 16> model{k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1, 0, data.originX * worldSize, data.originY * worldSize, 0, 1};
  std::array<float, 16> out{};
  for (int col = 0; col < 4; ++col) {
    for (int row = 0; row < 4; ++row) {
      double sum = 0;
      for (int i = 0; i < 4; ++i) sum += projection[static_cast<std::size_t>(i * 4 + row)] * model[static_cast<std::size_t>(col * 4 + i)];
      out[static_cast<std::size_t>(col * 4 + row)] = static_cast<float>(sum);
    }
  }
  return out;
}

double glExtrusionDepthRange(double customLayerDepth, int layersAbove) {
  // PaintParameters: numSublayers = 3, depthEpsilon = 2⁻¹⁶ (GL); translucent pass currentLayer counts down to 0 at the top.
  return customLayerDepth - (1.0 + layersAbove) * 3.0 / 65536.0;
}

bool BuildingLayerData::sameContent(const BuildingLayerData& o) const {
  const auto sameBytes = [](const auto& a, const auto& b) {
    return a.size() == b.size() && (a.empty() || std::memcmp(a.data(), b.data(), a.size() * sizeof(a[0])) == 0);
  };
  return originX == o.originX && originY == o.originY && unitsPerMercator == o.unitsPerMercator && sameBytes(vertices, o.vertices) &&
         sameBytes(indices, o.indices) && sameBytes(lowDetailIndices, o.lowDetailIndices) &&sameBytes(lineVertices, o.lineVertices) && sameBytes(lineIndices, o.lineIndices) &&
         std::memcmp(&light, &o.light, sizeof light) == 0 && windowLights == o.windowLights && lineWidth == o.lineWidth;
}

// ---------------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------------

BuildingLayerData buildBuildingLayer(const WorldData& world, const Projection& projection,
                                     const std::vector<RenderedBuilding>& rendered, const ResolvedTheme& theme,
                                     const MapLook& look, const std::map<std::string, BuildingOverride>& overrides) {
  BuildingLayerData out;
  const std::array<double, 2> origin = lngLatToMercator(world.origin);
  out.originX = origin[0];
  out.originY = origin[1];
  out.unitsPerMercator = 2 * kPi * kMercatorEarthRadius * std::cos(world.origin.lat * kPi / 180.0);
  out.light = buildingLayerLight(look.light);
  out.windowLights = static_cast<float>(theme.time.lights);
  out.lineWidth = theme.buildings.outline ? kOutlineWidthDp : 0.f;

  MeshBuilder mesh(projection, world.unitMeters, out);
  Context cx{theme, look, mesh};
  const FacadeSet set = theme.preset.facade;
  const bool shaded = set == FacadeSet::Real || set == FacadeSet::Modern || set == FacadeSet::Urban;
  const std::uint32_t ink = cx.tint(kInk);
  // MapLibre's vertical gradient: fMin at the base, sqrt(height / 150 m) at the top (clamped to [fMin, 1]).
  const float intensity = out.light.intensity;
  const float gradientMin = 0.7f + (0.98f - 0.7f) * (1.f - intensity);

  out.buildings.reserve(rendered.size());
  for (std::size_t ri = 0; ri < rendered.size(); ++ri) {
    const RenderedBuilding& rb = rendered[ri];
    const BuildingFootprint& src = world.buildings[rb.worldIndex];
    const Ring worldRing = normalizeRing(src.footprint);
    if (worldRing.size() < 3) continue;
    const std::optional<Rect> rect = asRectangle(worldRing);
    const Vec2 anchor = rect ? Vec2{rect->x, rect->z} : centroid(worldRing);
    const double yaw = rect ? rect->yaw : 0.0;

    // The footprint in the building frame (engine-web `localRing`, but the true ring for rectangles too:
    // the extrusion draws the true footprint).
    Ring ring;
    ring.reserve(worldRing.size());
    const double c = std::cos(yaw), s = std::sin(yaw);
    for (const Vec2& p : worldRing) {
      const double dx = p[0] - anchor[0], dz = p[1] - anchor[1];
      ring.push_back({dx * c - dz * s, dx * s + dz * c});
    }

    const double h = std::max(world_style::kMinBuildingHeightUnits, src.height);
    const BuildingKind kind = kindFor(src, h);
    const auto oit = overrides.find(src.id);
    const BuildingOverride* o = oit != overrides.end() ? &oit->second : nullptr;
    const bool captured = o != nullptr && o->captured;
    const std::uint32_t col = o != nullptr && (o->color || o->captured) ? buildingOverrideColor(look, rb.ci, rb.index, *o)
                                                                       : buildingThemeColor(look, rb.ci, rb.index);
    const double H = h * theme.buildings.heightScale;

    Mass m;
    m.ring = ring;
    m.h = H;
    m.rect = rect.has_value();
    if (rect) {
      m.x = 0;
      m.z = 0;
      m.w = rect->w;
      m.d = rect->d;
    } else {
      const Bbox bb = bbox(ring);
      const Vec2 cc = centroid(ring);
      m.x = cc[0];
      m.z = cc[1];
      m.w = bb.maxX - bb.minX;
      m.d = bb.maxZ - bb.minZ;
    }

    const double heightMeters = H * world.unitMeters;
    const float gradientTop = std::max(gradientMin, std::min(1.f, static_cast<float>(std::sqrt(heightMeters / 150.0))));
    mesh.begin(anchor[0], anchor[1], yaw, H, gradientMin, gradientTop, static_cast<std::uint8_t>(hashId(src.id) & 0xFF));

    BuildingMeshInfo info;
    info.rendered = ri;
    info.wallTop = H;
    info.rectangular = m.rect;
    info.firstVertex = static_cast<std::uint32_t>(out.vertices.size());
    info.firstIndex = static_cast<std::uint32_t>(out.indices.size());
    info.firstLineVertex = static_cast<std::uint32_t>(out.lineVertices.size());

    js_math::Mulberry32 br(static_cast<double>(rb.index) * 977 + 13);
    const double uo = br() * 4;
    (void)br();  // vo: whole-floor texture offset, no visible change

    const bool facadeOn = theme.buildings.facade && set != FacadeSet::None && !(o != nullptr && o->facade == false);
    const RoofShape roof = o != nullptr && o->roof ? *o->roof : RoofShape::Flat;
    const bool roofSet = o != nullptr && o->roof.has_value();
    // Massing `varied` is not rendered (the extrusion is a box), so the box rules apply.
    const bool flat = !m.rect || roof == RoofShape::Flat || (theme.preset.flatRoofs && !roofSet);
    const bool detailOn = theme.buildings.details && shaded;
    const FacadeLook& fl = facadeLookFor(set, kind, H);
    const double band = shaded && facadeOn && H > 1.2 ? kStoreBand : 0.0;
    const double y0 = band, bh = H - band;
    info.facade = facadeOn;
    info.details = detailOn;

    // Facade walls: the window pattern of the facade set on quads just outside the extrusion walls.
    if (facadeOn && bh > 0) {
      Surface fs;
      fs.color = mulColor(col, fl.wall);
      fs.glass = mulColor(col, fl.glass);
      fs.pattern = fl.pattern;
      fs.cellU = static_cast<float>(fl.cellU);
      fs.cellV = static_cast<float>(fl.cellV);
      fs.window = {unit8(fl.x0), unit8(fl.x1), unit8(fl.y0), unit8(fl.y1)};
      mesh.walls(offsetRing(ring, kFacadeOut), y0, bh, fs, false, uo * fl.tileU);
    }
    // Storefront band (engine-web: shaded sets with facades, masses taller than 1.2 units).
    if (band > 0) {
      Surface ss;
      ss.color = cx.tint(kStorefront);
      ss.glass = cx.tint(kStoreGlass);
      ss.pattern = FacadePattern::Storefront;
      ss.cellU = 2.0f;
      ss.cellV = static_cast<float>(band);
      ss.window = {unit8(0.06), unit8(0.94), unit8(0.10), unit8(0.70)};
      mesh.walls(offsetRing(ring, 0.02), 0, band, ss, false, uo * 2.0);
    }

    // Facade details: slab edges, fins, balconies, cornice, storefront canopy (not in the low-detail range).
    if (detailOn) {
      mesh.setDetail(true);
      std::uint32_t trimColor = set == FacadeSet::Urban ? kUrbanTrims[rb.index % kUrbanTrims.size()] : set == FacadeSet::Real ? kTrimReal : kTrimDefault;
      const Surface trim = cx.plain(cx.tint(trimColor));
      const double top0 = H;
      const Ring innerBand = offsetRing(ring, -0.005);
      const auto bandRing = [&](double off, double y, double hh) { mesh.ringBand(offsetRing(ring, off), innerBand, y - hh / 2, hh, trim); };
      switch (fl.family) {
        case FacadeLook::Family::Glass: {
          for (double y = y0 + kFloor * 4; y < top0 - 0.3; y += kFloor * 4) bandRing(0.025, y, 0.035);
          const double fh = bh + 0.38, fy = y0 + fh / 2;
          for (const Edge& ed : edgesOf(ring)) {
            if (ed.L < 1.2) continue;
            for (double sd = 0.25; sd <= ed.L - 0.2; sd += 0.5) {
              mesh.box(0.03, fh, 0.08, ed.ax + ed.ux * sd + ed.nx * 0.04, fy, ed.az + ed.uz * sd + ed.nz * 0.04, ed.yaw, trim);
            }
          }
          break;
        }
        case FacadeLook::Family::Bands:
          for (double y = y0 + kFloor * 2; y < top0 - 0.2; y += kFloor * 2) bandRing(0.02, y, 0.03);
          for (const Edge& ed : longEdges(m)) {
            for (double sd = 0.375; sd < ed.L; sd += 0.75) {
              mesh.box(0.06, bh, 0.1, ed.ax + ed.ux * sd + ed.nx * 0.05, y0 + bh / 2, ed.az + ed.uz * sd + ed.nz * 0.05, ed.yaw, trim);
            }
          }
          break;
        case FacadeLook::Family::Balconies:
          for (const Edge& ed : longEdges(m)) {
            const double bw = ed.L * 0.82;
            for (double y = y0 + kFloor; y < top0 - 0.15; y += kFloor) {
              mesh.box(bw, 0.03, 0.2, ed.mx + ed.nx * 0.1, y, ed.mz + ed.nz * 0.1, ed.yaw, trim);
            }
          }
          break;
        case FacadeLook::Family::Masonry:
        case FacadeLook::Family::Other:
          for (double y = y0 + kFloor; y < top0 - 0.15; y += kFloor) bandRing(0.08, y, 0.025);
          break;
      }
      if (H > 1.5 && flat) mesh.ringBand(offsetRing(ring, 0.05), offsetRing(ring, -0.07), top0, 0.07, trim);
      if (band > 0) {
        if (const std::optional<Edge> front = frontEdge(ring)) {
          mesh.box(std::min(front->L * 0.55, 1.8), 0.04, 0.38, front->mx + front->nx * 0.19, band + 0.03,
                   front->mz + front->nz * 0.19, front->yaw, trim);
        }
      }
      mesh.setDetail(false);
    }

    // Roof.
    const bool outline = theme.buildings.outline;
    double rt = H;
    if (!flat && roof == RoofShape::Gable) {
      const double bw = m.w, bd = m.d;
      const bool along = bw >= bd;
      const double span = (along ? bd : bw) + 0.3, len = (along ? bw : bd) + 0.3, rh = span * 0.42;
      const std::uint32_t rc = set == FacadeSet::Real ? cx.tint(kRoofTiles)
                               : (set == FacadeSet::Modern || set == FacadeSet::Urban) ? cx.tint(kMetalRoof)
                                                                                        : offsetHsl(col, 0, 0.1, -0.16);
      const Surface rs = cx.plain(rc);
      // Ridge along local x when `along`, else along local z.
      const auto at = [&](double a, double y, double b) { return along ? P3{a, y, b} : P3{b, y, a}; };
      const P3 e0a = at(-len / 2, H, -span / 2), e0b = at(len / 2, H, -span / 2);
      const P3 e1a = at(-len / 2, H, span / 2), e1b = at(len / 2, H, span / 2);
      const P3 ra = at(-len / 2, H + rh, 0), rbb = at(len / 2, H + rh, 0);
      mesh.face({e0a, e0b, rbb, ra}, rs);
      mesh.face({e1b, e1a, ra, rbb}, rs);
      mesh.face({e0a, ra, e1a}, rs);
      mesh.face({e0b, e1b, rbb}, rs);
      rt = H + rh;
      info.roof = RoofShape::Gable;
      if (outline) {
        mesh.line(e0a, e0b, ink);
        mesh.line(e1a, e1b, ink);
        mesh.line(ra, rbb, ink);
        mesh.line(e0a, ra, ink);
        mesh.line(e1a, ra, ink);
        mesh.line(e0b, rbb, ink);
        mesh.line(e1b, rbb, ink);
        mesh.line(e0a, e1a, ink);
        mesh.line(e0b, e1b, ink);
      }
    } else if (!flat && roof == RoofShape::Dome) {
      const double r = std::min(m.w, m.d) * 0.42;
      mesh.cylinder(r, 0.3, 0, H, 0, 24, cx.plain(mixColor(col, kWhite, 0.4)));
      mesh.hemisphere(r, 0, H + 0.3, 0, 1.0, 24, 10, cx.plain(shaded ? cx.tint(kDomeMetal) : offsetHsl(col, 0, 0.1, -0.16)));
      rt = H + 0.3 + r;
      info.roof = RoofShape::Dome;
      if (outline) {
        mesh.circleLines(r, 0, H, 0, 24, ink);
        mesh.circleLines(r, 0, H + 0.3, 0, 24, ink);
        mesh.ringLines(ring, H, ink);
      }
    } else {
      rt = flatRoof(cx, m, H, br, col, kind);
      info.roof = RoofShape::Flat;
      if (outline) {
        if (set == FacadeSet::Toy || set == FacadeSet::None) {
          const Ring capRing = offsetRing(ring, 0.12);
          mesh.ringLines(capRing, H, ink);
          mesh.ringLines(capRing, H + 0.22, ink);
        } else {
          mesh.ringLines(ring, H, ink);
        }
      }
    }
    info.roofTop = rt;

    // Outlines of the walls: ground ring and the corners.
    if (outline) {
      mesh.ringLines(ring, 0, ink);
      const std::size_t n = ring.size();
      for (std::size_t i = 0; i < n; ++i) {
        const Vec2& p = ring[(i + n - 1) % n];
        const Vec2& q = ring[i];
        const Vec2& r = ring[(i + 1) % n];
        const double ax = q[0] - p[0], az = q[1] - p[1], bx = r[0] - q[0], bz = r[1] - q[1];
        const double la = std::hypot(ax, az), lb = std::hypot(bx, bz);
        if (la < 1e-6 || lb < 1e-6) continue;
        if (std::fabs((ax * bz - az * bx) / (la * lb)) < kCornerTurn) continue;
        mesh.line({q[0], 0, q[1]}, {q[0], H, q[1]}, ink);
      }
    }

    // Captured: the flag on the roof (engine-web: pole + ACCENT flag at the top mass centre).
    if (captured) {
      const Surface pole = cx.plain(cx.tint(kPoleColor));
      mesh.cylinder(0.05, 2.4, m.x, rt, m.z, 6, pole);
      mesh.box(1.25, 0.72, 0.05, m.x + 0.66, rt + 1.98, m.z, 0, cx.plain(cx.tint(kAccentColor)));
      info.flag = true;
    }

    info.vertexCount = static_cast<std::uint32_t>(out.vertices.size()) - info.firstVertex;
    info.indexCount = static_cast<std::uint32_t>(out.indices.size()) - info.firstIndex;
    info.lineVertexCount = static_cast<std::uint32_t>(out.lineVertices.size()) - info.firstLineVertex;
    out.buildings.push_back(info);
  }
  return out;
}

}  // namespace maprama
