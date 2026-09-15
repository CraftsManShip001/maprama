#include "maprama/ProceduralMeshes.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <mutex>
#include <string>
#include <tuple>
#include <utility>

#include "maprama/CharacterAnimation.hpp"

namespace maprama {

namespace {

namespace mm = model_math;
constexpr double kPi = mm::kPi;

using P2 = std::array<double, 2>;

// ---------------------------------------------------------------------------------------------------
// three.js-style geometry (positions, normals, indices)
// ---------------------------------------------------------------------------------------------------

struct Geo {
  std::vector<Vec3d> pos;
  std::vector<Vec3d> nor;
  std::vector<std::uint32_t> idx;
  /// Optional per-vertex alpha (gradients of the additive effects).
  std::vector<double> alpha;

  Geo& apply(const Mat4& m) {
    const Mat4 n = mm::normalMatrix(m);
    for (Vec3d& p : pos) p = mm::transformPoint(m, p);
    for (Vec3d& v : nor) v = mm::normalize(mm::transformDirection(n, v));
    return *this;
  }
  Geo& translate(double x, double y, double z) { return apply(mm::translation(x, y, z)); }
  Geo& scale(double x, double y, double z) { return apply(mm::scaling(x, y, z)); }
  Geo& rotateX(double a) { return apply(mm::rotationX(a)); }
  Geo& rotateY(double a) { return apply(mm::rotationY(a)); }
  Geo& rotateZ(double a) { return apply(mm::rotationZ(a)); }
  std::uint32_t vertex(const Vec3d& p, const Vec3d& n) {
    pos.push_back(p);
    nor.push_back(n);
    return static_cast<std::uint32_t>(pos.size() - 1);
  }
  void tri(std::uint32_t a, std::uint32_t b, std::uint32_t c) { idx.insert(idx.end(), {a, b, c}); }
};

Geo box(double w, double h, double d) {
  Geo g;
  const double x = w / 2, y = h / 2, z = d / 2;
  const auto face = [&](Vec3d n, Vec3d a, Vec3d b, Vec3d c, Vec3d e) {
    const std::uint32_t i = g.vertex(a, n);
    g.vertex(b, n);
    g.vertex(c, n);
    g.vertex(e, n);
    g.tri(i, i + 1, i + 2);
    g.tri(i, i + 2, i + 3);
  };
  face({1, 0, 0}, {x, -y, z}, {x, -y, -z}, {x, y, -z}, {x, y, z});
  face({-1, 0, 0}, {-x, -y, -z}, {-x, -y, z}, {-x, y, z}, {-x, y, -z});
  face({0, 1, 0}, {-x, y, z}, {x, y, z}, {x, y, -z}, {-x, y, -z});
  face({0, -1, 0}, {-x, -y, -z}, {x, -y, -z}, {x, -y, z}, {-x, -y, z});
  face({0, 0, 1}, {-x, -y, z}, {x, -y, z}, {x, y, z}, {-x, y, z});
  face({0, 0, -1}, {x, -y, -z}, {-x, -y, -z}, {-x, y, -z}, {x, y, -z});
  return g;
}

Geo sphere(double r, int ws, int hs, double phiStart = 0, double phiLength = 2 * kPi, double thetaStart = 0, double thetaLength = kPi) {
  Geo g;
  const double thetaEnd = std::min(thetaStart + thetaLength, kPi);
  std::vector<std::vector<std::uint32_t>> grid;
  for (int iy = 0; iy <= hs; ++iy) {
    std::vector<std::uint32_t> row;
    const double v = static_cast<double>(iy) / hs;
    for (int ix = 0; ix <= ws; ++ix) {
      const double u = static_cast<double>(ix) / ws;
      const Vec3d p{-r * std::cos(phiStart + u * phiLength) * std::sin(thetaStart + v * thetaLength), r * std::cos(thetaStart + v * thetaLength),
                    r * std::sin(phiStart + u * phiLength) * std::sin(thetaStart + v * thetaLength)};
      row.push_back(g.vertex(p, mm::normalize(p)));
    }
    grid.push_back(std::move(row));
  }
  for (int iy = 0; iy < hs; ++iy) {
    for (int ix = 0; ix < ws; ++ix) {
      const std::uint32_t a = grid[iy][ix + 1], b = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1];
      if (iy != 0 || thetaStart > 0) g.tri(a, b, d);
      if (iy != hs - 1 || thetaEnd < kPi) g.tri(b, c, d);
    }
  }
  return g;
}

Geo cylinder(double rt, double rb, double h, int rs, int hs = 1, bool open = false, double thetaStart = 0, double thetaLength = 2 * kPi) {
  Geo g;
  const double half = h / 2, slope = (rb - rt) / h;
  std::vector<std::vector<std::uint32_t>> grid;
  for (int y = 0; y <= hs; ++y) {
    std::vector<std::uint32_t> row;
    const double v = static_cast<double>(y) / hs, radius = v * (rb - rt) + rt;
    for (int x = 0; x <= rs; ++x) {
      const double theta = static_cast<double>(x) / rs * thetaLength + thetaStart;
      row.push_back(g.vertex({radius * std::sin(theta), -v * h + half, radius * std::cos(theta)},
                             mm::normalize({std::sin(theta), slope, std::cos(theta)})));
    }
    grid.push_back(std::move(row));
  }
  for (int x = 0; x < rs; ++x) {
    for (int y = 0; y < hs; ++y) {
      const std::uint32_t a = grid[y][x], b = grid[y + 1][x], c = grid[y + 1][x + 1], d = grid[y][x + 1];
      g.tri(a, b, d);
      g.tri(b, c, d);
    }
  }
  if (!open) {
    for (const int sign : {1, -1}) {
      const double radius = sign > 0 ? rt : rb;
      if (radius <= 0) continue;
      const Vec3d n{0, static_cast<double>(sign), 0};
      const std::uint32_t center = g.vertex({0, half * sign, 0}, n);
      std::vector<std::uint32_t> ring;
      for (int x = 0; x <= rs; ++x) {
        const double theta = static_cast<double>(x) / rs * thetaLength + thetaStart;
        ring.push_back(g.vertex({radius * std::sin(theta), half * sign, radius * std::cos(theta)}, n));
      }
      for (int x = 0; x < rs; ++x) g.tri(center, ring[static_cast<std::size_t>(x)], ring[static_cast<std::size_t>(x + 1)]);
    }
  }
  return g;
}

/// three.js `LatheGeometry` (profile normals averaged per point, rotated around +Y).
Geo lathe(const std::vector<P2>& pts, int segments) {
  Geo g;
  const std::size_t n = pts.size();
  std::vector<P2> edge(n > 1 ? n - 1 : 0);
  for (std::size_t j = 0; j + 1 < n; ++j) {
    const double dx = pts[j + 1][0] - pts[j][0], dy = pts[j + 1][1] - pts[j][1];
    const double l = std::hypot(dx, dy);
    edge[j] = l > 0 ? P2{dy / l, -dx / l} : P2{1, 0};
  }
  std::vector<P2> normal(n);
  for (std::size_t j = 0; j < n; ++j) {
    P2 s{0, 0};
    if (j > 0) s = {s[0] + edge[j - 1][0], s[1] + edge[j - 1][1]};
    if (j + 1 < n) s = {s[0] + edge[j][0], s[1] + edge[j][1]};
    const double l = std::hypot(s[0], s[1]);
    normal[j] = l > 0 ? P2{s[0] / l, s[1] / l} : P2{1, 0};
  }
  for (int i = 0; i <= segments; ++i) {
    const double phi = static_cast<double>(i) / segments * 2 * kPi, sn = std::sin(phi), cs = std::cos(phi);
    for (std::size_t j = 0; j < n; ++j) {
      g.vertex({pts[j][0] * sn, pts[j][1], pts[j][0] * cs}, mm::normalize({normal[j][0] * sn, normal[j][1], normal[j][0] * cs}));
    }
  }
  for (int i = 0; i < segments; ++i) {
    for (std::size_t j = 0; j + 1 < n; ++j) {
      const std::uint32_t base = static_cast<std::uint32_t>(j + static_cast<std::size_t>(i) * n);
      const std::uint32_t a = base, b = base + static_cast<std::uint32_t>(n), c = b + 1, d = base + 1;
      g.tri(a, b, d);
      g.tri(c, d, b);
    }
  }
  return g;
}

/// engine-web `capsule` (vehicles.ts): lathe of two quarter circles.
Geo capsule(double r, double len, int seg = 10) {
  std::vector<P2> pts;
  for (int i = 0; i <= 5; ++i) {
    const double a = -kPi / 2 + (i / 5.0) * (kPi / 2);
    pts.push_back({std::max(0.0001, std::cos(a) * r), std::sin(a) * r - len / 2});
  }
  for (int i = 0; i <= 5; ++i) {
    const double a = (i / 5.0) * (kPi / 2);
    pts.push_back({std::max(0.0001, std::cos(a) * r), std::sin(a) * r + len / 2});
  }
  return lathe(pts, seg);
}

Geo torus(double radius, double tube, int radialSegments, int tubularSegments) {
  Geo g;
  for (int j = 0; j <= radialSegments; ++j) {
    for (int i = 0; i <= tubularSegments; ++i) {
      const double u = static_cast<double>(i) / tubularSegments * 2 * kPi, v = static_cast<double>(j) / radialSegments * 2 * kPi;
      const Vec3d p{(radius + tube * std::cos(v)) * std::cos(u), (radius + tube * std::cos(v)) * std::sin(u), tube * std::sin(v)};
      const Vec3d c{radius * std::cos(u), radius * std::sin(u), 0};
      g.vertex(p, mm::normalize({p[0] - c[0], p[1] - c[1], p[2] - c[2]}));
    }
  }
  const std::uint32_t row = static_cast<std::uint32_t>(tubularSegments + 1);
  for (int j = 1; j <= radialSegments; ++j) {
    for (int i = 1; i <= tubularSegments; ++i) {
      const std::uint32_t a = row * static_cast<std::uint32_t>(j) + static_cast<std::uint32_t>(i) - 1;
      const std::uint32_t b = row * static_cast<std::uint32_t>(j - 1) + static_cast<std::uint32_t>(i) - 1;
      const std::uint32_t c = row * static_cast<std::uint32_t>(j - 1) + static_cast<std::uint32_t>(i);
      const std::uint32_t d = row * static_cast<std::uint32_t>(j) + static_cast<std::uint32_t>(i);
      g.tri(a, b, d);
      g.tri(b, c, d);
    }
  }
  return g;
}

/// Flat-shaded triangles from positions (octahedron, extrusion caps are built directly).
void flatTri(Geo& g, const Vec3d& a, const Vec3d& b, const Vec3d& c) {
  const Vec3d e1{b[0] - a[0], b[1] - a[1], b[2] - a[2]}, e2{c[0] - a[0], c[1] - a[1], c[2] - a[2]};
  const Vec3d n = mm::normalize({e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]});
  const std::uint32_t i = g.vertex(a, n);
  g.vertex(b, n);
  g.vertex(c, n);
  g.tri(i, i + 1, i + 2);
}

Geo octahedron(double r) {
  Geo g;
  const std::array<Vec3d, 6> v{Vec3d{r, 0, 0}, Vec3d{-r, 0, 0}, Vec3d{0, r, 0}, Vec3d{0, -r, 0}, Vec3d{0, 0, r}, Vec3d{0, 0, -r}};
  const int faces[8][3] = {{0, 2, 4}, {0, 4, 3}, {0, 3, 5}, {0, 5, 2}, {1, 2, 5}, {1, 5, 3}, {1, 3, 4}, {1, 4, 2}};
  for (const auto& f : faces) flatTri(g, v[static_cast<std::size_t>(f[0])], v[static_cast<std::size_t>(f[1])], v[static_cast<std::size_t>(f[2])]);
  return g;
}

/// engine-web `rod`: a cylinder between two points.
Geo rod(const Vec3d& a, const Vec3d& b, double r) {
  const Vec3d d{b[0] - a[0], b[1] - a[1], b[2] - a[2]};
  const double len = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  Geo g = cylinder(r, r, len, 8);
  const Vec3d u = mm::normalize(d);
  // Quaternion.setFromUnitVectors((0, 1, 0), u).
  Quat q;
  const double w = u[1] + 1;
  if (w < 1e-8) {
    q = Quat{0, 0, 1, 0};
  } else {
    q = mm::normalizeQuat(Quat{u[2], 0, -u[0], w});
  }
  g.apply(mm::compose({0, 0, 0}, q, {1, 1, 1}));
  return g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
}

double area2(const std::vector<P2>& p) {
  double s = 0;
  for (std::size_t i = 0; i < p.size(); ++i) {
    const P2& a = p[i];
    const P2& b = p[(i + 1) % p.size()];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s;
}

/// Ear clipping of a simple polygon (small shapes only); returns index triples into `p`, counter-clockwise.
std::vector<std::array<std::size_t, 3>> earClip(const std::vector<P2>& p) {
  std::vector<std::size_t> v(p.size());
  for (std::size_t i = 0; i < p.size(); ++i) v[i] = i;
  if (area2(p) < 0) std::reverse(v.begin(), v.end());
  std::vector<std::array<std::size_t, 3>> out;
  const auto cross = [&](std::size_t a, std::size_t b, std::size_t c) {
    return (p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0]);
  };
  std::size_t guard = 0;
  while (v.size() > 3 && guard++ < 10000) {
    bool clipped = false;
    for (std::size_t i = 0; i < v.size(); ++i) {
      const std::size_t a = v[(i + v.size() - 1) % v.size()], b = v[i], c = v[(i + 1) % v.size()];
      if (cross(a, b, c) <= 1e-12) continue;
      bool inside = false;
      for (const std::size_t q : v) {
        if (q == a || q == b || q == c) continue;
        if (cross(a, b, q) >= 0 && cross(b, c, q) >= 0 && cross(c, a, q) >= 0) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push_back({a, b, c});
      v.erase(v.begin() + static_cast<std::ptrdiff_t>(i));
      clipped = true;
      break;
    }
    if (!clipped) break;  // degenerate: fan the rest
  }
  for (std::size_t i = 1; i + 1 < v.size(); ++i) out.push_back({v[0], v[i], v[i + 1]});
  return out;
}

/// three.js `ExtrudeGeometry` without bevel: the shape (x, y) extruded along +z from 0 to `depth`.
Geo extrude(const std::vector<P2>& shape, double depth) {
  Geo g;
  const auto tris = earClip(shape);
  for (const double z : {0.0, depth}) {
    const Vec3d n{0, 0, z > 0 ? 1.0 : -1.0};
    std::vector<std::uint32_t> ids;
    for (const P2& p : shape) ids.push_back(g.vertex({p[0], p[1], z}, n));
    for (const auto& t : tris) g.tri(ids[t[0]], ids[t[1]], ids[t[2]]);
  }
  const double orient = area2(shape) >= 0 ? 1.0 : -1.0;
  for (std::size_t i = 0; i < shape.size(); ++i) {
    const P2& a = shape[i];
    const P2& b = shape[(i + 1) % shape.size()];
    const double dx = b[0] - a[0], dy = b[1] - a[1];
    const double l = std::hypot(dx, dy);
    if (l <= 0) continue;
    const Vec3d n{orient * dy / l, -orient * dx / l, 0};
    const std::uint32_t k = g.vertex({a[0], a[1], 0}, n);
    g.vertex({b[0], b[1], 0}, n);
    g.vertex({b[0], b[1], depth}, n);
    g.vertex({a[0], a[1], depth}, n);
    g.tri(k, k + 1, k + 2);
    g.tri(k, k + 2, k + 3);
  }
  return g;
}

/// Flat ring (annulus) in the XZ plane at height y, facing +y (or -y), with an optional colour per angle.
Geo annulus(double inner, double outer, int segments, double y, bool up) {
  Geo g;
  const Vec3d n{0, up ? 1.0 : -1.0, 0};
  for (int i = 0; i <= segments; ++i) {
    const double a = static_cast<double>(i) / segments * 2 * kPi;
    g.vertex({inner * std::sin(a), y, inner * std::cos(a)}, n);
    g.vertex({outer * std::sin(a), y, outer * std::cos(a)}, n);
  }
  for (int i = 0; i < segments; ++i) {
    const std::uint32_t a = static_cast<std::uint32_t>(2 * i);
    g.tri(a, a + 1, a + 3);
    g.tri(a, a + 3, a + 2);
  }
  return g;
}

// ---------------------------------------------------------------------------------------------------
// Mesh builder
// ---------------------------------------------------------------------------------------------------

std::uint8_t unorm8(double v) { return static_cast<std::uint8_t>(std::lround(std::clamp(v, 0.0, 1.0) * 255.0)); }
std::int8_t snorm8(double v) { return static_cast<std::int8_t>(std::lround(std::clamp(v, -1.0, 1.0) * 127.0)); }

class MeshBuilder {
 public:
  /// Subsequent `add`s go to a part with this alpha mode.
  void part(ModelAlpha alpha, bool additive = false) { current_ = key(alpha, additive); }

  void add(const Geo& g, std::uint32_t rgb, std::uint8_t joint = 0, double alpha = 1, bool unlit = false,
           const std::vector<std::uint32_t>* perVertexRgb = nullptr) {
    const std::uint32_t base = static_cast<std::uint32_t>(vertices_.size());
    for (std::size_t i = 0; i < g.pos.size(); ++i) {
      ModelVertex v{};
      for (std::size_t c = 0; c < 3; ++c) {
        v.position[c] = static_cast<float>(g.pos[i][c]);
        v.normal[c] = snorm8(g.nor[i][c]);
      }
      v.normal[3] = unlit ? 127 : 0;
      const std::uint32_t color = perVertexRgb != nullptr ? (*perVertexRgb)[i] : rgb;
      v.color[0] = static_cast<std::uint8_t>((color >> 16) & 0xFF);
      v.color[1] = static_cast<std::uint8_t>((color >> 8) & 0xFF);
      v.color[2] = static_cast<std::uint8_t>(color & 0xFF);
      v.color[3] = unorm8(i < g.alpha.size() ? g.alpha[i] * alpha : alpha);
      v.joints[0] = joint;
      v.weights[0] = 255;
      vertices_.push_back(v);
    }
    std::vector<std::uint32_t>& list = parts_[current_];
    for (const std::uint32_t i : g.idx) list.push_back(base + i);
  }

  std::shared_ptr<const ModelMesh> finish(const std::string& name, std::uint32_t joints) {
    auto mesh = std::make_shared<ModelMesh>();
    mesh->id = nextModelMeshId();
    mesh->name = name;
    mesh->joints = joints;
    mesh->vertices = std::move(vertices_);
    for (const auto& [k, list] : parts_) {
      if (list.empty()) continue;
      ModelPart p;
      p.firstIndex = static_cast<std::uint32_t>(mesh->indices.size());
      p.indexCount = static_cast<std::uint32_t>(list.size());
      p.alpha = static_cast<ModelAlpha>(k / 2);
      p.additive = (k % 2) != 0;
      mesh->indices.insert(mesh->indices.end(), list.begin(), list.end());
      mesh->parts.push_back(p);
    }
    return mesh;
  }

 private:
  static int key(ModelAlpha alpha, bool additive) { return static_cast<int>(alpha) * 2 + (additive ? 1 : 0); }
  std::vector<ModelVertex> vertices_;
  std::map<int, std::vector<std::uint32_t>> parts_;
  int current_ = 0;
};

std::uint32_t ch(std::uint32_t c, int shift) { return (c >> shift) & 0xFF; }

std::uint32_t toHex(double r, double g, double b) {
  const auto c = [](double v) { return static_cast<std::uint32_t>(std::clamp(std::lround(v), 0L, 255L)); };
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

// engine-web colours.
constexpr std::uint32_t kSkin = 0xE8C2A4, kPants = 0x2C3342, kHair = 0x2A211C, kShoes = 0xE6E2DA, kPack = 0x3A3F47, kEye = 0x1E1A24;
constexpr std::uint32_t kTire = 0x1F2023, kChrome = 0xC9CDD2, kGlassDark = 0x27313B;
constexpr std::uint32_t kBikeFrame = 0x1F7F6A, kCarPaint = 0xB0342C, kHeadLight = 0xFFF1D2, kTailLight = 0xC8231C;
constexpr std::uint32_t kPlaneBody = 0xF7F9FC, kPlaneAccent = 0x4DA3FF, kGhost = 0x2E9E6B, kGhostHi = 0xC8FFE4;
constexpr std::uint32_t kGold = 0xFFC93C, kGem = 0x8FE3F0;
/// engine-web `RARITY_COLORS`.
constexpr std::array<std::uint32_t, 3> kRarity{0x6FB7FF, 0xB07CFF, 0xFFC24A};

/// engine-web `PLANE_SCALE` and vehicle bases / wheel radii (bike, car, plane, subway).
constexpr std::array<double, 4> kVehicleBase{1.0, 1.25, 0.9, 1.0};
constexpr std::array<double, 4> kWheelRadius{0.33, 0.27, 1.0, 1.0};
constexpr double kCarWidth = 1.12;
/// engine-web `CAR_BOB_FULL_SPEED`.
constexpr double kCarBobFullSpeed = 1.0;

template <class F>
std::shared_ptr<const ModelMesh> cached(const std::string& key, F&& make) {
  static std::mutex mutex;
  static std::map<std::string, std::shared_ptr<const ModelMesh>> cache;
  std::lock_guard<std::mutex> lock(mutex);
  auto it = cache.find(key);
  if (it != cache.end()) return it->second;
  auto mesh = make();
  cache.emplace(key, mesh);
  return mesh;
}

// ---- Vehicles (vehicles.ts buildVehicles) ----------------------------------------------------------

/// ExtrudeGeometry(shape, depth) rotated -90° about Y and centred on x (engine-web `ext`).
Geo carExtrude(const std::vector<P2>& shape, double depth) {
  Geo g = extrude(shape, depth);
  g.rotateY(-kPi / 2);
  return g.translate(depth / 2, 0, 0);
}

std::shared_ptr<const ModelMesh> buildBike() {
  MeshBuilder b;
  // Joints: 0 = group, 1 = front wheel (z 0.52), 2 = rear wheel (z -0.52), 3 = crank.
  for (const std::uint8_t joint : {std::uint8_t{1}, std::uint8_t{2}}) {
    b.add(torus(0.31, 0.04, 8, 32).rotateY(kPi / 2), kTire, joint);
    b.add(torus(0.27, 0.012, 6, 28).rotateY(kPi / 2), kChrome, joint);
    for (int s = 0; s < 6; ++s) {
      const double a = (s / 6.0) * kPi;
      b.add(rod({0, std::cos(a) * 0.27, std::sin(a) * 0.27}, {0, -std::cos(a) * 0.27, -std::sin(a) * 0.27}, 0.005), kChrome, joint);
    }
    b.add(cylinder(0.03, 0.03, 0.08, 8).rotateZ(kPi / 2), kChrome, joint);
  }
  const Vec3d rear{0, 0.34, -0.52}, bb{0, 0.3, -0.02}, seatT{0, 0.8, -0.17}, headT{0, 0.86, 0.36}, headB{0, 0.68, 0.41}, front{0, 0.34, 0.52};
  const std::vector<std::tuple<Vec3d, Vec3d, double>> tubes{{bb, seatT, 0.022},   {seatT, headT, 0.02}, {bb, headB, 0.024},
                                                            {bb, rear, 0.015},    {seatT, rear, 0.014}, {headB, front, 0.016},
                                                            {headB, headT, 0.026}, {headT, {0, 0.96, 0.33}, 0.016}};
  for (const auto& [a, c, r] : tubes) b.add(rod(a, c, r), kBikeFrame);
  b.add(rod({-0.24, 0.96, 0.33}, {0.24, 0.96, 0.33}, 0.016), kChrome);
  b.add(box(0.12, 0.05, 0.24).translate(0, 0.845, -0.2), kTire);
  b.add(rod({0.07, 0, 0}, {0.07, -0.14, 0}, 0.012), kChrome, 3);
  b.add(rod({-0.07, 0, 0}, {-0.07, 0.14, 0}, 0.012), kChrome, 3);
  b.add(cylinder(0.07, 0.07, 0.02, 16).rotateZ(kPi / 2).translate(0.04, 0, 0), kChrome, 3);
  return b.finish("vehicle:bike", 4);
}

std::shared_ptr<const ModelMesh> buildCar() {
  MeshBuilder b;
  // Joints: 0 = group, 1 = body (engine bob), 2..5 = wheels.
  const double W = kCarWidth;
  b.add(carExtrude({{-1.2, 0.3}, {-1.22, 0.6}, {-1.08, 0.68}, {-0.78, 0.7}, {-0.48, 0.98}, {0.2, 1.0}, {0.58, 0.72}, {1.1, 0.63}, {1.22, 0.5}, {1.22, 0.3}}, W),
        kCarPaint, 1);
  b.add(box(W - 0.02, 0.1, 2.36).translate(0, 0.28, 0), kTire, 1);
  const std::vector<P2> side{{-0.7, 0.73}, {-0.47, 0.95}, {0.18, 0.965}, {0.52, 0.735}};
  for (const double sx : {-1.0, 1.0}) {
    b.add(carExtrude(side, 0.012).translate(sx * (W / 2 + 0.006), 0, 0), kGlassDark, 1);
    b.add(box(0.02, 0.24, 0.05).translate(sx * (W / 2 + 0.012), 0.84, -0.12), kCarPaint, 1);
    b.add(box(0.1, 0.06, 0.1).translate(sx * (W / 2 + 0.06), 0.76, 0.5), kCarPaint, 1);
  }
  b.add(box(W * 0.88, 0.44, 0.012).rotateX(-0.935).translate(0, 0.868, 0.396), kGlassDark, 1);
  b.add(box(W * 0.86, 0.36, 0.012).rotateX(0.82).translate(0, 0.847, -0.637), kGlassDark, 1);
  for (const double sx : {-1.0, 1.0}) {
    b.add(box(0.24, 0.08, 0.02).translate(sx * 0.36, 0.55, 1.225), kHeadLight, 1, 1, true);
    b.add(box(0.22, 0.07, 0.02).translate(sx * 0.4, 0.6, -1.225), kTailLight, 1, 1, true);
  }
  b.add(sphere(0.12, 12, 10).scale(1, 1.1, 1).translate(-0.24, 0.84, -0.05), kSkin, 1);
  for (std::uint8_t w = 0; w < 4; ++w) {
    b.add(cylinder(0.27, 0.27, 0.2, 18).rotateZ(kPi / 2), kTire, static_cast<std::uint8_t>(2 + w));
    b.add(cylinder(0.15, 0.15, 0.205, 12).rotateZ(kPi / 2), kChrome, static_cast<std::uint8_t>(2 + w));
  }
  return b.finish("vehicle:car", 6);
}

std::shared_ptr<const ModelMesh> buildPlane() {
  MeshBuilder b;
  // Joints: 0 = group (pitch + scale), 1 = propeller.
  b.add(capsule(0.34, 2.0, 16).rotateX(kPi / 2).translate(0, 1.0, 0), kPlaneBody);
  b.add(box(3.3, 0.08, 0.72).translate(0, 0.95, 0.15), kPlaneBody);
  b.add(box(1.25, 0.06, 0.42).translate(0, 1.08, -1.2), kPlaneBody);
  b.add(box(0.06, 0.62, 0.5).translate(0, 1.38, -1.22), kPlaneAccent);
  b.add(box(3.32, 0.09, 0.16).translate(0, 0.95, 0.42), kPlaneAccent);
  b.add(sphere(0.24, 14, 10).scale(1, 0.72, 1.35).translate(0, 1.2, 0.72), kGlassDark);
  b.add(sphere(0.11, 10, 8).translate(0, 1.0, 1.36), kPlaneAccent);
  b.add(box(1.0, 0.09, 0.03), kTire, 1);
  return b.finish("vehicle:plane", 2);
}

std::shared_ptr<const ModelMesh> buildSubway() {
  MeshBuilder b;
  // engine-web draws the ghost train translucent without depth test on top of everything; here it is blended
  // with depth test (buildings in front hide it).
  b.part(ModelAlpha::Blend);
  for (int k = 0; k < 3; ++k) {
    b.add(capsule(0.4, 1.3, 14).rotateX(kPi / 2).translate(0, 0.45, -k * 2.2), kGhost, 0, 0.55, true);
    b.add(box(0.84, 0.14, 1.5).translate(0, 0.62, -k * 2.2), kGhostHi, 0, 0.85, true);
  }
  return b.finish("vehicle:subway", 1);
}

// ---- Drops (drops.ts geos) -------------------------------------------------------------------------

std::vector<P2> quadratic(const P2& from, const P2& c, const P2& to, int divisions) {
  std::vector<P2> out;
  for (int i = 1; i <= divisions; ++i) {
    const double t = static_cast<double>(i) / divisions, u = 1 - t;
    out.push_back({u * u * from[0] + 2 * u * t * c[0] + t * t * to[0], u * u * from[1] + 2 * u * t * c[1] + t * t * to[1]});
  }
  return out;
}

Geo noteGeometry() {
  // head: absellipse(0, 0, 0.19, 0.135, 0, 2π, false, 0.35), 24 points (three.js curveSegments 12 × 2).
  std::vector<P2> head;
  for (int i = 0; i < 24; ++i) {
    const double a = i / 24.0 * 2 * kPi, x = 0.19 * std::cos(a), y = 0.135 * std::sin(a);
    head.push_back({x * std::cos(0.35) - y * std::sin(0.35), x * std::sin(0.35) + y * std::cos(0.35)});
  }
  std::vector<P2> stem{{0.13, 0.04}, {0.19, 0.04}, {0.19, 0.6}};
  for (const P2& p : quadratic({0.19, 0.6}, {0.33, 0.55}, {0.36, 0.36}, 12)) stem.push_back(p);
  for (const P2& p : quadratic({0.36, 0.36}, {0.42, 0.62}, {0.19, 0.8}, 12)) stem.push_back(p);
  stem.push_back({0.13, 0.8});
  // Depth 0.07 plus both bevel thicknesses (the 0.015 bevel itself is not modelled).
  constexpr double depth = 0.07 + 2 * 0.02;
  Geo g = extrude(head, depth);
  Geo s = extrude(stem, depth);
  const std::uint32_t base = static_cast<std::uint32_t>(g.pos.size());
  g.pos.insert(g.pos.end(), s.pos.begin(), s.pos.end());
  g.nor.insert(g.nor.end(), s.nor.begin(), s.nor.end());
  for (const std::uint32_t i : s.idx) g.idx.push_back(base + i);
  // note.center(); note.scale(1.45).
  Vec3d lo{1e9, 1e9, 1e9}, hi{-1e9, -1e9, -1e9};
  for (const Vec3d& p : g.pos) {
    for (std::size_t c = 0; c < 3; ++c) {
      lo[c] = std::min(lo[c], p[c]);
      hi[c] = std::max(hi[c], p[c]);
    }
  }
  g.translate(-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -(lo[2] + hi[2]) / 2);
  return g.scale(1.45, 1.45, 1.45);
}

/// hsl(h°, s, l) → sRGB hex.
std::uint32_t hsl(double h, double s, double l) {
  const double q = l <= 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const auto f = [&](double t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1.0 / 6) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2.0 / 3) return p + (q - p) * 6 * (2.0 / 3 - t);
    return p;
  };
  const double hh = std::fmod(h, 360.0) / 360.0;
  return toHex(f(hh + 1.0 / 3) * 255, f(hh) * 255, f(hh - 1.0 / 3) * 255);
}

std::shared_ptr<const ModelMesh> buildDisc(bool cd, Rarity rarity) {
  // CylinderGeometry(0.58, 0.58, 0.03, 48) with the label texture (drops.ts `discTexture`, 256 px = 0.58 units):
  // CD: silver with faint rainbow sectors, the rarity label (r 80 px), a light centre (r 30 px), hole (r 14 px);
  // LP: black vinyl, the rarity label (r 42 px), hole (r 5 px). The mesh is stood up (rotation.x = π/2).
  MeshBuilder b;
  const double R = 0.58, px = R / 128.0;
  const std::uint32_t color = kRarity[static_cast<std::size_t>(rarity)];
  const Mat4 up = mm::rotationX(kPi / 2);
  b.add(cylinder(R, R, 0.03, 48, 1, true).apply(up), cd ? kChrome : kTire);
  for (const bool top : {true, false}) {
    const double y = top ? 0.015 : -0.015;
    const auto ring = [&](double inner, double outer, std::uint32_t c, bool rainbow) {
      Geo g = annulus(inner, outer, 48, y, top);
      std::vector<std::uint32_t> colors(g.pos.size(), c);
      if (rainbow) {
        for (std::size_t i = 0; i < g.pos.size(); ++i) {
          const double a = std::atan2(g.pos[i][0], g.pos[i][2]) * 180 / kPi + 360;
          const double r = std::hypot(g.pos[i][0], g.pos[i][2]);
          const std::uint32_t silver = mixHex(0xF4F6F8, 0xAEB6BE, std::clamp((r / px - 20) / 108.0, 0.0, 1.0));
          colors[i] = mixHex(silver, hsl(std::fmod(a * 2, 360.0), 0.9, 0.65), 0.24);
        }
      }
      g.apply(up);
      b.add(g, c, 0, 1, false, &colors);
    };
    if (cd) {
      ring(80 * px, R, 0xAEB6BE, true);
      ring(30 * px, 80 * px, mixHex(0xCED4DA, color, 0.9), false);
      ring(14 * px, 30 * px, 0xE8EEF2, false);
    } else {
      ring(42 * px, R, 0x141416, false);
      ring(5 * px, 42 * px, color, false);
    }
  }
  return b.finish(cd ? "drop:cd" : "drop:vinyl", 1);
}

}  // namespace

// ---------------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------------

std::uint32_t mixHex(std::uint32_t a, std::uint32_t b, double t) {
  return toHex(ch(a, 16) + (static_cast<double>(ch(b, 16)) - ch(a, 16)) * t, ch(a, 8) + (static_cast<double>(ch(b, 8)) - ch(a, 8)) * t,
               ch(a, 0) + (static_cast<double>(ch(b, 0)) - ch(a, 0)) * t);
}

std::uint32_t offsetHslHex(std::uint32_t hex, double dh, double ds, double dl) {
  const double r = ch(hex, 16) / 255.0, g = ch(hex, 8) / 255.0, b = ch(hex, 0) / 255.0;
  const double mx = std::max(r, std::max(g, b)), mn = std::min(r, std::min(g, b));
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
  s = std::clamp(s + ds, 0.0, 1.0);
  const double L = std::clamp(l + dl, 0.0, 1.0);
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

double easeOutBack(double x) {
  const double c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * std::pow(x - 1, 3) + c1 * std::pow(x - 1, 2);
}

// ---------------------------------------------------------------------------------------------------
// Procedural character (characters.ts geos / buildProcedural)
// ---------------------------------------------------------------------------------------------------

std::shared_ptr<const ModelMesh> proceduralCharacterMesh(std::uint32_t color, bool isPlayer) {
  char key[48];
  std::snprintf(key, sizeof key, "body:%06x:%d", color & 0xFFFFFFu, isPlayer ? 1 : 0);
  return cached(key, [&] {
    namespace pr = procedural_rig;
    MeshBuilder b;
    const std::vector<P2> torsoProfile{{0, 0}, {0.17, 0.012}, {0.205, 0.09}, {0.19, 0.24}, {0.225, 0.44},
                                       {0.215, 0.55}, {0.15, 0.62}, {0.07, 0.655}, {0, 0.66}};
    std::vector<P2> torso;
    for (const P2& p : torsoProfile) torso.push_back({std::max(0.0001, p[0]), p[1]});
    b.add(lathe(torso, 16).scale(1, 1, 0.72).translate(0, 0.86, 0), color, pr::kRoot);
    b.add(cylinder(0.055, 0.06, 0.12, 8).translate(0, 1.56, 0), kSkin, pr::kRoot);
    b.add(sphere(0.17, 20, 16).scale(1, 1.12, 1.04).translate(0, 1.73, 0), kSkin, pr::kRoot);
    if (isPlayer) {
      const std::uint32_t cap = offsetHslHex(color, 0, 0, -0.1);
      b.add(sphere(0.188, 20, 10, 0, 2 * kPi, 0, kPi * 0.46).scale(1, 1.05, 1.06).translate(0, 1.76, -0.005), cap, pr::kRoot);
      b.add(cylinder(0.13, 0.13, 0.025, 16, 1, false, -kPi / 2, kPi).scale(1, 1, 1.1).translate(0, 1.775, 0.12), cap, pr::kRoot);
      b.add(box(0.28, 0.32, 0.13).translate(0, 1.2, -0.18), kPack, pr::kRoot);
    } else {
      b.add(sphere(0.182, 20, 12, 0, 2 * kPi, 0, kPi * 0.52).scale(1, 1.12, 1.08).translate(0, 1.745, -0.012), kHair, pr::kRoot);
    }
    b.add(sphere(0.022, 8, 6).translate(-0.062, 1.745, 0.163), kEye, pr::kRoot, 1, true);
    b.add(sphere(0.022, 8, 6).translate(0.062, 1.745, 0.163), kEye, pr::kRoot, 1, true);
    for (int s = 0; s < 2; ++s) {
      const std::uint8_t hip = s == 0 ? pr::kHipL : pr::kHipR, knee = s == 0 ? pr::kKneeL : pr::kKneeR;
      b.add(capsule(0.085, 0.28).translate(0, -0.225, 0), kPants, hip);
      b.add(capsule(0.07, 0.3).translate(0, -0.22, 0), kPants, knee);
      b.add(box(0.13, 0.08, 0.26).translate(0, -0.445, 0.05), kShoes, knee);
    }
    for (int s = 0; s < 2; ++s) {
      const std::uint8_t sh = s == 0 ? pr::kShoulderL : pr::kShoulderR, el = s == 0 ? pr::kElbowL : pr::kElbowR;
      b.add(capsule(0.062, 0.18).translate(0, -0.15, 0), color, sh);
      b.add(capsule(0.052, 0.17).translate(0, -0.13, 0), kSkin, el);
      b.add(sphere(0.058, 10, 8).translate(0, -0.29, 0.01), kSkin, el);
    }
    return b.finish(key, pr::kJoints);
  });
}

void animateProceduralRig(ProceduralRigState& r, double dt, double t, TravelMode mode, double speed, double scale, bool onBike) {
  r.rigX = r.rigY = r.rigZ = 0;
  r.rigRotX = r.rigRotY = 0;
  r.rigScaleY = 1;
  if (onBike) {
    r.phase += dt * speed * 1.3;
    r.crank = r.phase;
    r.rigY = 0.02;
    r.rigZ = -0.17;
    r.rigRotX = 0.32;
    for (int s = 0; s < 2; ++s) {
      const double w = std::sin(r.phase + s * kPi);
      r.hip[static_cast<std::size_t>(s)] = -1.2 + w * 0.38;
      r.knee[static_cast<std::size_t>(s)] = 1.25 - w * 0.45;
      r.shoulder[static_cast<std::size_t>(s)] = -1.05;
      r.elbow[static_cast<std::size_t>(s)] = -0.25;
    }
  } else if (mode != TravelMode::Car) {
    // cadence relative to the character size, at least MIN_CADENCE while moving
    const double k = std::max(walkCadence(speed, scale), kMinCadence), amp = std::min(k, 1.0), run = std::clamp((k - 1.2) / 0.8, 0.0, 1.0);
    if (speed < kIdleSpeed) {
      for (int s = 0; s < 2; ++s) {
        r.hip[static_cast<std::size_t>(s)] = 0;
        r.knee[static_cast<std::size_t>(s)] = 0.02;
        r.shoulder[static_cast<std::size_t>(s)] = std::sin(t * 1.6 + s) * 0.03;
        r.elbow[static_cast<std::size_t>(s)] = -0.12;
      }
      r.rigScaleY = 1 + std::sin(t * 2.4 + r.phase) * 0.01;
    } else {
      r.phase += dt * k * kWalkCadenceSpeed * (2.3 - run * 0.5);
      for (int s = 0; s < 2; ++s) {
        const double a = r.phase + s * kPi, sn = std::sin(a), cs = std::cos(a);
        r.hip[static_cast<std::size_t>(s)] = sn * (0.5 + run * 0.35) * amp;
        r.knee[static_cast<std::size_t>(s)] = (0.1 + std::max(0.0, -cs) * (0.9 + run * 0.6)) * amp;
        r.shoulder[static_cast<std::size_t>(s)] = -sn * (0.45 + run * 0.3) * amp;
        r.elbow[static_cast<std::size_t>(s)] = -(0.2 + run * 1.0) * amp - 0.1;
      }
      r.rigRotY = std::sin(r.phase) * 0.06 * amp;
      r.rigY = (0.025 - std::fabs(std::sin(r.phase)) * 0.04) * amp;
      r.rigRotX = run * 0.22;
    }
  }
}

std::vector<Mat4> proceduralRigPalette(const ProceduralRigState& r) {
  using mm::multiply;
  std::vector<Mat4> out(procedural_rig::kJoints);
  const Mat4 rig = multiply(multiply(mm::translation(r.rigX, r.rigY, r.rigZ), mm::eulerXYZ(r.rigRotX, r.rigRotY, 0)), mm::scaling(1, r.rigScaleY, 1));
  out[procedural_rig::kRoot] = rig;
  for (int s = 0; s < 2; ++s) {
    const std::size_t i = static_cast<std::size_t>(s);
    const double hx = s == 0 ? -0.1 : 0.1, sx = s == 0 ? -0.255 : 0.255;
    const Mat4 hip = multiply(rig, multiply(mm::translation(hx, 0.9, 0), mm::rotationX(r.hip[i])));
    const Mat4 knee = multiply(hip, multiply(mm::translation(0, -0.44, 0), mm::rotationX(r.knee[i])));
    const Mat4 shoulder = multiply(rig, multiply(mm::translation(sx, 1.46, 0), mm::eulerXYZ(r.shoulder[i], 0, sx < 0 ? -0.08 : 0.08)));
    const Mat4 elbow = multiply(shoulder, multiply(mm::translation(0, -0.29, 0), mm::rotationX(r.elbow[i])));
    out[s == 0 ? procedural_rig::kHipL : procedural_rig::kHipR] = hip;
    out[s == 0 ? procedural_rig::kKneeL : procedural_rig::kKneeR] = knee;
    out[s == 0 ? procedural_rig::kShoulderL : procedural_rig::kShoulderR] = shoulder;
    out[s == 0 ? procedural_rig::kElbowL : procedural_rig::kElbowR] = elbow;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------------------------------

int vehicleIndex(TravelMode mode) {
  switch (mode) {
    case TravelMode::Bike:
      return 0;
    case TravelMode::Car:
      return 1;
    case TravelMode::Plane:
      return 2;
    case TravelMode::Subway:
      return 3;
    case TravelMode::Walk:
      break;
  }
  return -1;
}

std::shared_ptr<const ModelMesh> vehicleMesh(TravelMode mode) {
  switch (mode) {
    case TravelMode::Bike:
      return cached("vehicle:bike", buildBike);
    case TravelMode::Car:
      return cached("vehicle:car", buildCar);
    case TravelMode::Plane:
      return cached("vehicle:plane", buildPlane);
    case TravelMode::Subway:
      return cached("vehicle:subway", buildSubway);
    case TravelMode::Walk:
      break;
  }
  return nullptr;
}

void switchVehicle(VehicleSetState& set, TravelMode mode) {
  set.built = true;
  for (int k = 0; k < 4; ++k) {
    VehicleState& v = set.vehicles[static_cast<std::size_t>(k)];
    if (k == vehicleIndex(mode)) {
      v.visible = true;
      v.dir = 1;
    } else if (v.visible) {
      v.dir = -1;
    }
  }
}

void stepVehicles(VehicleSetState& set, TravelMode mode, double speed, double dt, double t, double planePitch) {
  for (int k = 0; k < 4; ++k) {
    VehicleState& v = set.vehicles[static_cast<std::size_t>(k)];
    if (v.dir != 0) {
      v.p = std::clamp(v.p + (v.dir * dt) / 0.35, 0.0, 1.0);
      if (v.p == 0 && v.dir < 0) {
        v.visible = false;
        v.dir = 0;
      }
      if (v.p == 1) v.dir = 0;
    }
    if (vehicleIndex(mode) == k) v.wheel += (speed * dt) / kWheelRadius[static_cast<std::size_t>(k)];
  }
  if (set.vehicles[2].visible) set.prop += dt * 35;
  set.planePitch = planePitch;
  set.carBob = mode == TravelMode::Car ? std::sin(t * 18) * 0.012 * std::min(1.0, speed / kCarBobFullSpeed) : 0.0;
}

double vehicleScale(const VehicleSetState& set, TravelMode mode) {
  const int k = vehicleIndex(mode);
  if (k < 0) return 0;
  return std::max(0.001, easeOutBack(set.vehicles[static_cast<std::size_t>(k)].p) * kVehicleBase[static_cast<std::size_t>(k)]);
}

std::vector<Mat4> vehiclePalette(const VehicleSetState& set, TravelMode mode, double crank) {
  using mm::multiply;
  const int k = vehicleIndex(mode);
  if (k < 0) return {mm::identity()};
  const double s = vehicleScale(set, mode);
  const double wheel = set.vehicles[static_cast<std::size_t>(k)].wheel;
  // three.js group: T(0) · R(plane pitch) · S(pop scale).
  const Mat4 root = multiply(mode == TravelMode::Plane ? mm::rotationX(set.planePitch) : mm::identity(), mm::scaling(s, s, s));
  std::vector<Mat4> out{root};
  if (mode == TravelMode::Bike) {
    out.push_back(multiply(root, multiply(mm::translation(0, 0.34, 0.52), mm::rotationX(wheel))));
    out.push_back(multiply(root, multiply(mm::translation(0, 0.34, -0.52), mm::rotationX(wheel))));
    out.push_back(multiply(root, multiply(mm::translation(0, 0.3, -0.02), mm::rotationX(crank))));
  } else if (mode == TravelMode::Car) {
    out.push_back(multiply(root, mm::translation(0, set.carBob, 0)));
    const double wx = kCarWidth / 2 + 0.01;
    for (const auto& [x, z] : std::array<std::pair<double, double>, 4>{{{1, 0.78}, {-1, 0.78}, {1, -0.78}, {-1, -0.78}}}) {
      out.push_back(multiply(root, multiply(mm::translation(x * wx, 0.27, z), mm::rotationX(wheel))));
    }
  } else if (mode == TravelMode::Plane) {
    out.push_back(multiply(root, multiply(mm::translation(0, 1.0, 1.42), mm::rotationZ(set.prop))));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------------------------------

std::shared_ptr<const ModelMesh> dropMesh(DropType type, Rarity rarity, bool gem) {
  switch (type) {
    case DropType::Cd:
    case DropType::Vinyl: {
      const bool cd = type == DropType::Cd;
      return cached(std::string(cd ? "drop:cd:" : "drop:vinyl:") + std::string(enumName(rarity)), [&] { return buildDisc(cd, rarity); });
    }
    case DropType::Note:
      return cached("drop:note:" + std::string(enumName(rarity)), [&] {
        MeshBuilder b;
        b.add(noteGeometry(), kRarity[static_cast<std::size_t>(rarity)]);
        return b.finish("drop:note", 1);
      });
    case DropType::Coin:
    case DropType::Model:
      break;
  }
  if (gem) {
    return cached("drop:gem", [] {
      MeshBuilder b;
      b.add(octahedron(0.46), kGem);
      return b.finish("drop:gem", 1);
    });
  }
  return cached("drop:coin", [] {
    MeshBuilder b;
    b.add(cylinder(0.46, 0.46, 0.14, 24).rotateX(kPi / 2), kGold);
    return b.finish("drop:coin", 1);
  });
}

std::shared_ptr<const ModelMesh> dropBeamMesh() {
  return cached("drop:beam", [] {
    MeshBuilder b;
    b.part(ModelAlpha::Blend, true);
    Geo g = cylinder(0.22, 0.42, 5, 20, 1, true).translate(0, 2.5, 0);
    for (const Vec3d& p : g.pos) g.alpha.push_back(std::pow(std::clamp(1 - p[1] / 5.0, 0.0, 1.0), 1.4));
    b.add(g, 0xFFFFFF, 0, 1, true);
    return b.finish("drop:beam", 1);
  });
}

std::shared_ptr<const ModelMesh> dropRingMesh() {
  return cached("drop:ring", [] {
    MeshBuilder b;
    b.part(ModelAlpha::Blend, true);
    Geo g;
    const Vec3d up{0, 1, 0};
    const int segments = 32;
    const std::uint32_t center = g.vertex({0, 0, 0}, up);
    g.alpha.push_back(1.0);
    for (const auto& [r, a] : std::array<std::pair<double, double>, 2>{{{0.55, 0.45}, {1.1, 0.0}}}) {
      for (int i = 0; i <= segments; ++i) {
        const double t = static_cast<double>(i) / segments * 2 * kPi;
        g.vertex({r * std::sin(t), 0, r * std::cos(t)}, up);
        g.alpha.push_back(a);
      }
    }
    const std::uint32_t inner = center + 1, outer = inner + segments + 1;
    for (int i = 0; i < segments; ++i) {
      const std::uint32_t a = inner + static_cast<std::uint32_t>(i), o = outer + static_cast<std::uint32_t>(i);
      g.tri(center, a, a + 1);
      g.tri(a, o, o + 1);
      g.tri(a, o + 1, a + 1);
    }
    b.add(g, 0xFFFFFF, 0, 1, true);
    return b.finish("drop:ring", 1);
  });
}

std::shared_ptr<const ModelMesh> iconDiscMesh() {
  return cached("icon:disc", [] {
    MeshBuilder b;
    Geo g;
    const Vec3d up{0, 1, 0};
    const int segments = 24;
    std::vector<std::uint32_t> colors;
    const std::uint32_t center = g.vertex({0, 0, 0}, up);
    colors.push_back(0xFFFFFF);
    // Fill ring (white), then the rim between r 0.76 and 1 (dark: 30 % of the instance colour).
    for (const auto& [r, c] : std::array<std::pair<double, std::uint32_t>, 3>{{{0.76, 0xFFFFFF}, {0.76, 0x4D4D4D}, {1.0, 0x4D4D4D}}}) {
      for (int i = 0; i <= segments; ++i) {
        const double t = static_cast<double>(i) / segments * 2 * kPi;
        g.vertex({r * std::sin(t), 0, r * std::cos(t)}, up);
        colors.push_back(c);
      }
    }
    const std::uint32_t fill = center + 1, rimIn = fill + segments + 1, rimOut = rimIn + segments + 1;
    for (int i = 0; i < segments; ++i) {
      const auto k = static_cast<std::uint32_t>(i);
      g.tri(center, fill + k, fill + k + 1);
      g.tri(rimIn + k, rimOut + k, rimOut + k + 1);
      g.tri(rimIn + k, rimOut + k + 1, rimIn + k + 1);
    }
    b.add(g, 0xFFFFFF, 0, 1, true, &colors);
    return b.finish("icon:disc", 1);
  });
}

MeshStats meshStats(const ModelMesh& mesh) { return MeshStats{mesh.vertices.size(), mesh.indices.size() / 3}; }

}  // namespace maprama
