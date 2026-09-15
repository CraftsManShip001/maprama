#include "maprama/ProceduralWorld.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <utility>

// Keep V8's double arithmetic (see RoadGraph.cpp): a fused multiply-add changes the last bit of the lot
// geometry and, through the occupancy grid, which lots get a building.
#if defined(__clang__)
#pragma clang fp contract(off)
#endif

namespace maprama {

namespace {

using json::Value;
using js_math::Mulberry32;

constexpr double kPi = 3.141592653589793;  // Math.PI

// ---------------------------------------------------------------------------------------------------
// polygon.ts
// ---------------------------------------------------------------------------------------------------

double signedArea(const std::vector<Vec2>& poly) {
  const std::size_t n = poly.size();
  if (n == 0) return 0.0;
  double a = 0.0;
  for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
    const Vec2& p = poly[i];
    const Vec2& q = poly[j];
    a += q[0] * p[1] - p[0] * q[1];
  }
  return a / 2;
}

std::vector<Vec2> dedupeRing(const std::vector<Vec2>& poly, double eps = 1e-6) {
  std::vector<Vec2> out;
  out.reserve(poly.size());
  for (const Vec2& p : poly) {
    if (out.empty() || std::fabs(out.back()[0] - p[0]) > eps || std::fabs(out.back()[1] - p[1]) > eps) out.push_back(p);
  }
  if (out.size() > 1) {
    const Vec2& a = out.front();
    const Vec2& b = out.back();
    if (std::fabs(a[0] - b[0]) <= eps && std::fabs(a[1] - b[1]) <= eps) out.pop_back();
  }
  return out;
}

std::vector<Vec2> normalizeRing(const std::vector<Vec2>& poly) {
  std::vector<Vec2> out = dedupeRing(poly);
  if (signedArea(out) < 0) std::reverse(out.begin(), out.end());
  return out;
}

std::vector<Vec2> rectCorners(double cx, double cz, double yaw, double w, double d) {
  // Object3D rotation.y maps local (u, v) -> world (u·cos + v·sin, −u·sin + v·cos)
  const double c = std::cos(yaw), s = std::sin(yaw);
  const double corners[4][2] = {{-w / 2, -d / 2}, {w / 2, -d / 2}, {w / 2, d / 2}, {-w / 2, d / 2}};
  std::vector<Vec2> pts;
  pts.reserve(4);
  for (const auto& uv : corners) {
    const double u = uv[0], v = uv[1];
    pts.push_back(Vec2{cx + u * c + v * s, cz - u * s + v * c});
  }
  return normalizeRing(pts);
}

bool pointInPolygon(double x, double z, const std::vector<Vec2>& poly) {
  bool ins = false;
  const std::size_t n = poly.size();
  if (n == 0) return false;
  for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
    const double xi = poly[i][0], zi = poly[i][1];
    const double xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) != (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
  }
  return ins;
}

// ---------------------------------------------------------------------------------------------------
// shapes.ts
// ---------------------------------------------------------------------------------------------------

MassShape autoShapeFor(int idx, double h, double w, double d, bool infill = false) {
  const double sr = Mulberry32(static_cast<double>(idx) * 131 + 17).next();
  const double minWD = std::min(w, d), maxWD = std::max(w, d);
  if (infill) {
    if (h > 3.0 && minWD > 2.8 && sr < 0.5) return MassShape::Setback;
    if (minWD > 2.8 && sr < 0.75) return MassShape::L;
    return MassShape::Box;
  }
  if (h > 5.4 && maxWD > 3.0 && sr < 0.35) return MassShape::Twin;
  if (h > 3.6 && minWD > 2.6 && sr < 0.62) return MassShape::Podium;
  if (h > 3.0 && minWD > 2.8 && sr < 0.82) return MassShape::Setback;
  if (h <= 4.6 && minWD > 2.8 && sr < 0.92) return MassShape::L;
  return MassShape::Box;
}

RoofShape roofFor(double h, double q, double minWD) {
  return h > 4.6 ? RoofShape::Flat : q < 0.52 ? RoofShape::Flat : q < 0.84 || minWD < 2.2 ? RoofShape::Gable : RoofShape::Dome;
}

BuildingKind kindFor(double h, RoofShape roof, Mulberry32& r) {
  if (h > 5.0) return BuildingKind::Glass;
  if (h > 3.2) return r() < 0.55 ? BuildingKind::Apartment : BuildingKind::Office;
  if (roof == RoofShape::Gable) return BuildingKind::Brick;
  return r() < 0.5 ? BuildingKind::Brick : BuildingKind::Office;
}

// ---------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------

/// `Array.prototype.slice(begin, end)` for non-negative indices.
std::vector<Vec2> slice(const std::vector<Vec2>& v, std::size_t begin, std::size_t end) {
  begin = std::min(begin, v.size());
  end = std::min(end, v.size());
  return begin < end ? std::vector<Vec2>(v.begin() + static_cast<std::ptrdiff_t>(begin), v.begin() + static_cast<std::ptrdiff_t>(end))
                     : std::vector<Vec2>{};
}

ProceduralBuilding makeBuilding(std::string id, int idx, double x, double z, double yaw, double w, double d, double h,
                                RoofShape roof, int ci, BuildingKind kind, bool landmark) {
  ProceduralBuilding b;
  b.id = std::move(id);
  b.idx = idx;
  b.x = x;
  b.z = z;
  b.yaw = yaw;
  b.w = w;
  b.d = d;
  b.footprint = rectCorners(x, z, yaw, w, d);
  b.h = h;
  b.kind = kind;
  b.roof = roof;
  b.ci = ci;
  b.landmark = landmark;
  return b;
}

Poi poi(std::string id, std::string name, PoiCategory cat, double x, double z) {
  return Poi{std::move(id), std::move(name), cat, x, z};
}

}  // namespace

std::string_view massShapeName(MassShape shape) {
  switch (shape) {
    case MassShape::Box:
      return "box";
    case MassShape::Podium:
      return "podium";
    case MassShape::Setback:
      return "setback";
    case MassShape::L:
      return "L";
    case MassShape::Twin:
      return "twin";
  }
  return "box";
}

std::string_view gridBlockKindName(ProceduralGridBlock::Kind kind) {
  switch (kind) {
    case ProceduralGridBlock::Kind::City:
      return "city";
    case ProceduralGridBlock::Kind::Plaza:
      return "plaza";
    case ProceduralGridBlock::Kind::Park:
      return "park";
  }
  return "city";
}

double townRiverZ(double x) { return 44 + 7 * std::sin(x / 38 + 0.6); }

// ---------------------------------------------------------------------------------------------------
// town.ts
// ---------------------------------------------------------------------------------------------------

ProceduralWorld buildTownWorld(double seed) {
  const auto riverZ = townRiverZ;
  std::vector<GraphRoad> roads;
  Mulberry32 lr(2024 + seed);
  const double R = 72;
  int rid = 0;
  const auto road = [&](const std::string& name, RoadClass cls, bool bridge, std::vector<Vec2> pts) {
    roads.push_back(GraphRoad{"town:r" + std::to_string(rid++), name, cls, bridge, std::move(pts)});
  };
  const auto curve = [](double (*f)(double), double x0, double x1, double step) {
    std::vector<Vec2> p;
    for (double x = x0; x <= x1 + 1e-6; x += step) p.push_back(Vec2{x, f(x)});
    return p;
  };
  road("강나루로", RoadClass::Arterial, false, curve([](double x) { return townRiverZ(x) - 11; }, -110, 110, 6));
  road("남강변로", RoadClass::Arterial, false, curve([](double x) { return townRiverZ(x) + 12; }, -110, 110, 6));
  road("은행나무길", RoadClass::Arterial, false, {{-110, -18}, {-30, -20}, {10, -16}, {110, -22}});
  road("하늘로", RoadClass::Arterial, false, {{2, -110}, {0, -40}, {-3, 0}, {0, 20}, {3, riverZ(3) - 11}});
  road("새솔대로", RoadClass::Arterial, false, {{-100, -96}, {-20, -34}, {70, 26}});
  road("하늘대교", RoadClass::Arterial, true, {{3, riverZ(3) - 11}, {4, riverZ(4) + 12}});
  road("나루교", RoadClass::Local, true, {{-46, riverZ(-46) - 11}, {-47, riverZ(-47) + 12}});
  road("하늘로", RoadClass::Arterial, false, {{4, riverZ(4) + 12}, {6, 110}});

  const char* const vNames[] = {"모래내길", "느티길", "솔바람길", "골목시장길", "책방길", "은하수길", "별빛길", "다락길"};
  const double vXs[] = {-58, -44, -30, -15, 14, 28, 42, 57};
  for (int k = 0; k < 8; ++k) {
    const double x = vXs[k];
    const double z1 = riverZ(x) - 10;
    std::vector<Vec2> pts;
    for (double z = -R; z < z1; z += 12) pts.push_back(Vec2{x + (lr() - 0.5) * 4, z});
    pts.push_back(Vec2{x + (lr() - 0.5) * 2, z1});
    if (lr() < 0.35) {
      const double cut = 1 + std::floor(lr() * (static_cast<double>(pts.size()) - 3));
      const std::size_t c = static_cast<std::size_t>(cut);
      road(vNames[k], RoadClass::Local, false, slice(pts, 0, c + 1));
      road(vNames[k], RoadClass::Local, false, slice(pts, c + 2, pts.size()));
    } else {
      road(vNames[k], RoadClass::Local, false, pts);
    }
  }
  const char* const hNames[] = {"물빛로", "다온길", "꽃담길", "새벽길", "마루길", "한별길"};
  const double hZs[] = {-58, -44, -31, -6, 8, 24};
  for (int k = 0; k < 6; ++k) {
    const double z = hZs[k];
    const double x0 = -R + (lr() < 0.3 ? lr() * 30 : 0);
    const double x1 = R - (lr() < 0.3 ? lr() * 30 : 0);
    std::vector<Vec2> pts;
    for (double x = x0; x < x1; x += 14) pts.push_back(Vec2{x, z + (lr() - 0.5) * 4});
    pts.push_back(Vec2{x1, z + (lr() - 0.5) * 2});
    std::vector<Vec2> kept;
    for (const Vec2& p : pts) {
      if (p[1] < riverZ(p[0]) - 11.5) kept.push_back(p);
    }
    road(hNames[k], RoadClass::Local, false, std::move(kept));
  }
  const char* const nNames[] = {"나루1길", "나루2길", "나루3길", "나루4길"};
  const double nXs[] = {-34, -12, 20, 44};
  for (int k = 0; k < 4; ++k) {
    const double x = nXs[k];
    const Vec2 a{x, riverZ(x) + 11};
    const Vec2 b{x + (lr() - 0.5) * 6, 80};
    const Vec2 c{x + (lr() - 0.5) * 6, 104};
    road(nNames[k], RoadClass::Local, false, {a, b, c});
  }
  road("강변남길", RoadClass::Local, false, {{-70, 78}, {-20, 82}, {30, 76}, {80, 80}});
  for (int k = 0; k < 9; ++k) {
    const double x = -60 + lr() * 120;
    const double z = -64 + lr() * 80;
    const double a = lr() * kPi * 2;
    const double L = 8 + lr() * 6;
    if (z > riverZ(x) - 16) continue;
    road("골목", RoadClass::Alley, false,
         {{x, z},
          {x + std::cos(a) * L * 0.5, z + std::sin(a) * L * 0.5 + 1.5},
          {x + std::cos(a) * L, z + std::sin(a) * L}});
  }
  std::vector<GraphRoad> graphRoads;
  for (GraphRoad& r : roads) {
    if (r.pts.size() > 1) graphRoads.push_back(std::move(r));
  }

  ProceduralWorld world;
  world.layout = ProceduralLayout::Town;
  world.graph = buildRoadGraph(std::move(graphRoads));
  const RoadGraph& graph = world.graph;
  const ProceduralPlaza plaza{8.5, 1, 6.4};
  world.parks = {
      Park{std::string("솔마루 공원"), {{-41, -3.5}, {-33, -4.5}, {-32, 5.5}, {-40.5, 6}}},
      Park{std::string("다온 어린이공원"), {{31, -40}, {39.5, -41}, {40, -34}, {31.5, -33}}},
  };

  // ---- building placement along street frontages ----
  std::vector<ProceduralBuilding>& buildings = world.buildings;
  const double RES = 0.5, EXT = 115;
  const long N = static_cast<long>(js_math::round((EXT * 2) / RES));
  std::vector<std::uint8_t> occ(static_cast<std::size_t>(N * N), 0);
  const auto cell = [&](double x, double z) -> long {
    const double i = std::floor((x + EXT) / RES), j = std::floor((z + EXT) / RES);
    return i < 0 || j < 0 || i >= static_cast<double>(N) || j >= static_cast<double>(N) ? -1
                                                                                          : static_cast<long>(i) * N + static_cast<long>(j);
  };
  const auto markCapsule = [&](double ax, double az, double bx, double bz, double r) {
    const double x0 = std::min(ax, bx) - r, x1 = std::max(ax, bx) + r, z0 = std::min(az, bz) - r, z1 = std::max(az, bz) + r;
    const double dx = bx - ax, dz = bz - az;
    double L2 = dx * dx + dz * dz;
    if (!(L2 != 0.0)) L2 = 1;
    for (double x = x0; x <= x1; x += RES) {
      for (double z = z0; z <= z1; z += RES) {
        const double t = js_math::clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
        const double px = ax + dx * t - x, pz = az + dz * t - z;
        if (px * px + pz * pz <= r * r) {
          const long c = cell(x, z);
          if (c >= 0) occ[static_cast<std::size_t>(c)] = 1;
        }
      }
    }
  };
  // `fn` returning false stops the scan (and makes rectPoints return false), like the JS callback.
  const auto rectPoints = [&](double cx, double cz, double yaw, double w, double d, const auto& fn) -> bool {
    const double ax = std::cos(yaw), az = -std::sin(yaw), bx = std::sin(yaw), bz = std::cos(yaw);
    for (double u = -w / 2; u <= w / 2 + 1e-6; u += RES) {
      for (double v = -d / 2; v <= d / 2 + 1e-6; v += RES) {
        if (!fn(cx + ax * u + bx * v, cz + az * u + bz * v)) return false;
      }
    }
    return true;
  };
  const auto inDistrict = [&](double x, double z) {
    return std::fabs(x) < 86 && z > -86 && z < 108 && (z < riverZ(x) - 8.5 || z > riverZ(x) + 9);
  };
  const auto isFree = [&](double x, double z) {
    const long c = cell(x, z);
    return c >= 0 && !occ[static_cast<std::size_t>(c)] && inDistrict(x, z);
  };
  const auto mark = [&](double x, double z) {
    const long c = cell(x, z);
    if (c >= 0) occ[static_cast<std::size_t>(c)] = 1;
    return true;
  };

  for (const GraphEdge& e : graph.edges) {
    const GraphNode& A = graph.nodes[e.a];
    const GraphNode& Bn = graph.nodes[e.b];
    markCapsule(A.x, A.z, Bn.x, Bn.z, roadWidthUnits(e.cls) / 2 + 0.95);
  }
  for (double x = -EXT; x < EXT; x += 1) markCapsule(x, riverZ(x), x + 1, riverZ(x + 1), 8.6);
  for (const Park& p : world.parks) {
    for (double x = -EXT; x < EXT; x += RES) {
      for (double z = -EXT; z < EXT; z += RES) {
        if (pointInPolygon(x, z, p.poly)) mark(x, z);
      }
    }
  }
  markCapsule(plaza.x, plaza.z, plaza.x, plaza.z, 6.2);

  const auto add = [&](const std::string* id, double x, double z, double w, double d, double yaw, double h, RoofShape roof,
                       int ci, BuildingKind kind, bool landmark) -> ProceduralBuilding& {
    const int idx = static_cast<int>(buildings.size());
    buildings.push_back(makeBuilding(id != nullptr ? *id : "town:b" + std::to_string(idx), idx, x, z, yaw, w, d, h, roof,
                                     ci, kind, landmark));
    return buildings.back();
  };
  const std::string landmarkId = "landmark";
  add(&landmarkId, plaza.x, plaza.z, 5, 5, 0, 8, RoofShape::Flat, 0, BuildingKind::Glass, true);

  Mulberry32 r(77 + seed);
  std::vector<int> order(graph.edges.size());
  std::iota(order.begin(), order.end(), 0);
  std::vector<double> key(graph.edges.size());
  for (std::size_t i = 0; i < graph.edges.size(); ++i) {
    const GraphNode& m = graph.nodes[graph.edges[i].a];
    key[i] = js_math::hypot(m.x, m.z);
  }
  // Array.prototype.sort is stable (TimSort); ties keep edge order.
  std::stable_sort(order.begin(), order.end(), [&](int i, int j) { return key[i] < key[j]; });
  for (int ei : order) {
    const GraphEdge& e = graph.edges[ei];
    if (e.bridge) continue;
    const GraphNode A = graph.nodes[e.a];
    const GraphNode Bn = graph.nodes[e.b];
    const double len = e.len;
    if (len < 3.5) continue;
    const double ux = (Bn.x - A.x) / len, uz = (Bn.z - A.z) / len;
    for (const double side : {1.0, -1.0}) {
      double s = 1.3;
      while (s < len - 1.3 && buildings.size() < 340) {
        const double fw = 2.4 + r() * 3.6;
        const double depth = 2.8 + r() * (e.cls == RoadClass::Arterial ? 4.6 : 3.4);
        if (s + fw > len - 1.0) break;
        const double nx = -uz * side, nz = ux * side, off = roadWidthUnits(e.cls) / 2 + 1.0 + depth / 2;
        const double px = A.x + ux * (s + fw / 2) + nx * off, pz = A.z + uz * (s + fw / 2) + nz * off;
        const double yaw = std::atan2(-nx, -nz);
        const bool free = inDistrict(px, pz) && rectPoints(px, pz, yaw, fw + 0.5, depth + 0.4, isFree);
        if (!free) {
          s += 1.1;
          continue;
        }
        rectPoints(px, pz, yaw, fw + 0.5, depth + 0.4, mark);
        const double center = 1.25 - std::min(js_math::hypot(px, pz) / 110, 0.55);
        double h;
        if (e.cls == RoadClass::Arterial) {
          h = 3.2 + std::pow(r(), 1.3) * 6.5;
        } else if (e.cls == RoadClass::Local) {
          h = 1.5 + std::pow(r(), 1.8) * 4.6;
        } else {
          h = 1.2 + r() * 1.8;
        }
        h = h * center;
        const RoofShape roof = roofFor(h, r(), std::min(fw, depth));
        const BuildingKind kind = kindFor(h, roof, r);
        const int ci = static_cast<int>(std::floor(r() * 6));
        ProceduralBuilding& b = add(nullptr, px, pz, fw, depth, yaw, h, roof, ci, kind, false);
        const double dq = r();
        if (dq < 0.12) {
          b.antenna = true;
        } else if (dq < 0.22 && roof == RoofShape::Flat) {
          b.garden = true;
        } else if (dq < 0.4 && h < 3.6) {
          b.sign = true;
        }
        b.autoShape = autoShapeFor(b.idx, h, fw, depth);
        s += fw + 0.45;
      }
    }
  }
  // infill: fill block interiors so blocks don't read as empty lots
  for (int k = 0; k < 1400 && buildings.size() < 460; ++k) {
    const double px = (r() - 0.5) * 150;
    const double pz = -74 + r() * 176;
    if (!inDistrict(px, pz) || js_math::hypot(px - plaza.x, pz - plaza.z) < 8) continue;
    const std::optional<GraphSnap> sn = snapToGraph(graph, px, pz);
    if (!sn) continue;
    const double dToRoad = js_math::hypot(sn->x - px, sn->z - pz);
    if (dToRoad < 4 || dToRoad > 16) continue;
    const double yaw = std::atan2(sn->x - px, sn->z - pz);
    const double fw = 2.4 + r() * 3.2;
    const double depth = 2.4 + r() * 3.2;
    if (!rectPoints(px, pz, yaw, fw + 0.6, depth + 0.6, isFree)) continue;
    rectPoints(px, pz, yaw, fw + 0.6, depth + 0.6, mark);
    const double h = (1.4 + std::pow(r(), 1.7) * 3.6) * (1.15 - std::min(js_math::hypot(px, pz) / 120, 0.5));
    const RoofShape roof = h > 3.6 || r() < 0.55 ? RoofShape::Flat : RoofShape::Gable;
    BuildingKind kind;
    if (h > 3.2) {
      kind = r() < 0.6 ? BuildingKind::Apartment : BuildingKind::Office;
    } else {
      kind = roof == RoofShape::Gable ? BuildingKind::Brick : BuildingKind::Office;
    }
    const int ci = static_cast<int>(std::floor(r() * 6));
    ProceduralBuilding& b = add(nullptr, px, pz, fw, depth, yaw, h, roof, ci, kind, false);
    if (r() < 0.15 && roof == RoofShape::Flat) b.garden = true;
    b.autoShape = autoShapeFor(b.idx, h, fw, depth, true);
  }

  // ---- landuse ----
  std::vector<Vec2> north{{-92, -92}, {92, -92}};
  std::vector<Vec2> south{{-92, 112}, {92, 112}};
  for (double x = 92; x >= -92; x -= 6) {
    north.push_back(Vec2{x, riverZ(x) - 8});
    south.push_back(Vec2{x, riverZ(x) + 8});
  }
  std::vector<Vec2> riverPts;
  for (double x = -160; x <= 160; x += 4) riverPts.push_back(Vec2{x, riverZ(x)});
  world.waterRibbons = {ProceduralRibbon{riverPts, 13}};
  world.banks = {ProceduralRibbon{riverPts, 18}};
  Mulberry32 sr(991 + seed);
  for (double x = -80; x < 80; x += 7) {
    if (sr() < 0.7) {
      const double tx = x + sr() * 3;
      const double ts = 0.7 + sr() * 0.4;
      world.sceneryTrees.push_back(ProceduralTree{tx, 0.02, riverZ(x) - 7.3, ts, false});
    }
  }

  world.stations = {
      Station{"town:s0", "나루역", -5, -21},
      Station{"town:s1", "강변역", 42, riverZ(42) - 15},
      Station{"town:s2", "새솔역", -50, -52},
      Station{"town:s3", "하늘역", 6, 80},
  };
  world.name = "Procedural town";
  world.origin = kProceduralOrigin;
  world.unitMeters = 8;
  world.bounds = WorldBounds{-110, -110, 110, 110};
  world.pads = {std::move(north), std::move(south)};
  world.plaza = plaza;
  world.ground = "lawn";
  world.buildingBaseY = 0.06;
  world.pois = {
      poi("town:p0", "나루역", PoiCategory::Subway, -5, -21),
      poi("town:p1", "모퉁이 커피", PoiCategory::Cafe, -18, -9),
      poi("town:p2", "24 편의점", PoiCategory::Store, 16, -30),
      poi("town:p3", "동네 LP숍", PoiCategory::Music, -30, 10),
      poi("town:p4", "새솔초등학교", PoiCategory::School, -50, -38),
      poi("town:p5", "골목서점", PoiCategory::Book, 30, 14),
      poi("town:p6", "중앙 광장", PoiCategory::Plaza, 8.5, 1),
      poi("town:p7", "솔마루 공원", PoiCategory::Park, -36.5, 1),
      poi("town:p8", "강변 수변공원", PoiCategory::Park, 40, riverZ(40) - 6),
      poi("town:p9", "강변역", PoiCategory::Subway, 42, riverZ(42) - 15),
      poi("town:p10", "새솔역", PoiCategory::Subway, -50, -52),
      poi("town:p11", "하늘역", PoiCategory::Subway, 6, 80),
  };
  world.districts = {
      District{"새솔동", -40, -45, std::nullopt},
      District{"은빛동", 38, -50, std::nullopt},
      District{"나루동", -38, 14, std::nullopt},
      District{"하늘동", 38, 8, std::nullopt},
      District{"강남 나루마을", -10, 92, std::nullopt},
      District{"푸른강", -60, riverZ(-60), true},
  };
  world.start = WorldPoint{-30, -19};
  world.spawn = {{-24, -19.5}, {-17, -20}, {-9, -19}, {-2, -18}, {14, -8}, {14, 6}, {-15, -30}};
  world.loopWays = {{-30, -19}, {14, -17}, {14, 22}, {-30, 23}};
  return world;
}

// ---------------------------------------------------------------------------------------------------
// grid.ts
// ---------------------------------------------------------------------------------------------------

ProceduralWorld buildGridWorld(double seed) {
  const double B = 10, O = -40;
  const int NN = 9;
  std::vector<GraphRoad> roads;
  const char* const ns[] = {"첫째길", "둘째길", "셋째길", "넷째길", "다섯째길", "여섯째길", "일곱째길", "여덟째길", "아홉째길"};
  for (int i = 0; i < NN; ++i) {
    const RoadClass cls = i % 4 == 0 ? RoadClass::Arterial : RoadClass::Local;
    const double c = -40 + i * 10;
    roads.push_back(GraphRoad{"grid:v" + std::to_string(i), std::string("새솔 ") + ns[i], cls, false, {{c, -40}, {c, 40}}});
    roads.push_back(GraphRoad{"grid:h" + std::to_string(i), std::string("은빛 ") + ns[i], cls, false, {{-40, c}, {40, c}}});
  }
  ProceduralWorld world;
  world.layout = ProceduralLayout::Grid;
  world.graph = buildRoadGraph(std::move(roads));

  Mulberry32 rng(11 + seed);
  std::vector<ProceduralBuilding>& buildings = world.buildings;
  std::vector<ProceduralGridBlock>& blocks = world.gridBlocks;
  struct Lot {
    double x, z, w, d;
  };
  const auto lotsFor = [&](double x0, double z0) {
    const double inner = 7.4, s = x0 + 1.3, t = z0 + 1.3, p = rng();
    std::vector<std::array<double, 4>> cells;
    if (p < 0.18) {
      cells = {{0, 0, 1, 1}};
    } else if (p < 0.42) {
      cells = {{0, 0, 0.5, 1}, {0.5, 0, 0.5, 1}};
    } else if (p < 0.62) {
      cells = {{0, 0, 1, 0.5}, {0, 0.5, 1, 0.5}};
    } else {
      cells = {{0, 0, 0.5, 0.5}, {0.5, 0, 0.5, 0.5}, {0, 0.5, 0.5, 0.5}, {0.5, 0.5, 0.5, 0.5}};
    }
    std::vector<Lot> lots;
    for (const auto& [u, v, w, d] : cells) {
      const double gw = w * inner, gd = d * inner;
      const double lw = gw - 0.8 - rng() * 0.7;
      const double ld = gd - 0.8 - rng() * 0.7;
      lots.push_back(Lot{s + u * inner + gw / 2, t + v * inner + gd / 2, lw, ld});
    }
    return lots;
  };
  const auto add = [&](const std::string* id, double x, double z, double w, double d, double h, RoofShape roof, int ci,
                       BuildingKind kind, bool landmark) -> ProceduralBuilding& {
    const int idx = static_cast<int>(buildings.size());
    buildings.push_back(
        makeBuilding(id != nullptr ? *id : "grid:b" + std::to_string(idx), idx, x, z, 0, w, d, h, roof, ci, kind, landmark));
    return buildings.back();
  };

  for (int bi = 0; bi < 8; ++bi) {
    for (int bj = 0; bj < 8; ++bj) {
      const double x0 = O + bi * B, z0 = O + bj * B;
      const ProceduralGridBlock::Kind kind = bi == 4 && bj == 4                                   ? ProceduralGridBlock::Kind::Plaza
                                             : (bi == 2 && bj == 5) || (bi == 6 && bj == 1) ? ProceduralGridBlock::Kind::Park
                                                                                                    : ProceduralGridBlock::Kind::City;
      blocks.push_back(ProceduralGridBlock{x0 + 5, z0 + 5, kind, bi, bj});
      if (kind == ProceduralGridBlock::Kind::City) {
        for (const Lot& lot : lotsFor(x0, z0)) {
          const double dist = js_math::hypot(lot.x, lot.z);
          const double h = (1.4 + std::pow(rng(), 1.6) * 6.2) * (1 - std::min(dist / 70, 0.45));
          const RoofShape roof = roofFor(h, rng(), std::min(lot.w, lot.d));
          const BuildingKind bkind = kindFor(h, roof, rng);
          const int ci = static_cast<int>(std::floor(rng() * 6));
          ProceduralBuilding& b = add(nullptr, lot.x, lot.z, lot.w, lot.d, h, roof, ci, bkind, false);
          const double q = rng();
          if (q < 0.14) {
            b.antenna = true;
          } else if (q < 0.26 && roof == RoofShape::Flat) {
            b.garden = true;
          } else if (q < 0.36 && h < 3.6) {
            b.sign = true;
          }
          b.autoShape = autoShapeFor(b.idx, h, lot.w, lot.d);
        }
      } else if (kind == ProceduralGridBlock::Kind::Plaza) {
        const std::string landmarkId = "landmark";
        add(&landmarkId, x0 + 5, z0 + 5, 5, 5, 8, RoofShape::Flat, 0, BuildingKind::Glass, true);
      }
    }
  }

  Mulberry32 sr(99);
  std::vector<ProceduralTree>& trees = world.sceneryTrees;
  for (const ProceduralGridBlock& bl : blocks) {
    if (bl.kind == ProceduralGridBlock::Kind::Park) {
      for (int k = 0; k < 8; ++k) {
        const double a = (k / 8.0) * kPi * 2 + sr() * 0.4;
        const double rr = 2.9 + sr() * 0.5;
        const double s = 0.9 + sr() * 0.5;
        trees.push_back(ProceduralTree{bl.cx + std::cos(a) * rr, 0.14, bl.cz + std::sin(a) * rr, s, false});
      }
    } else if (bl.kind == ProceduralGridBlock::Kind::Plaza) {
      const double corners[4][2] = {{-1, -1}, {1, -1}, {-1, 1}, {1, 1}};
      for (const auto& c : corners) trees.push_back(ProceduralTree{bl.cx + c[0] * 3.3, 0.14, bl.cz + c[1] * 3.3, 0.85, false});
    }
  }
  for (int k = 0; k < 46; ++k) {
    const double a = sr() * kPi * 2;
    const double r = 47 + sr() * 50;
    const double s = 1.2 + sr() * 1.1;
    const double x = std::cos(a) * r, z = std::sin(a) * r;
    if (std::fabs(std::fmod(std::fmod(x - O, B) + B, B)) < 1.6 || std::fabs(std::fmod(std::fmod(z - O, B) + B, B)) < 1.6) continue;
    trees.push_back(ProceduralTree{x, 0, z, s, true});
  }

  world.stations = {
      Station{"grid:s0", "나루역", -10, -10},
      Station{"grid:s1", "은빛역", 30, -30},
      Station{"grid:s2", "새솔역", -30, 30},
      Station{"grid:s3", "하늘역", 30, 30},
  };
  world.name = "Procedural grid";
  world.origin = kProceduralOrigin;
  world.unitMeters = 8;
  world.bounds = WorldBounds{-50, -50, 50, 50};
  world.plaza = ProceduralPlaza{5, 5, 4};
  world.ground = "grass";
  world.buildingBaseY = 0.14;
  world.pois = {
      poi("grid:p0", "중앙 광장", PoiCategory::Plaza, 5, 5),
      poi("grid:p1", "물빛공원", PoiCategory::Park, -15, 15),
      poi("grid:p2", "솔마루 공원", PoiCategory::Park, 25, -25),
  };
  for (std::size_t i = 0; i < world.stations.size(); ++i) {
    const Station& s = world.stations[i];
    world.pois.push_back(poi("grid:ps" + std::to_string(i), s.name, PoiCategory::Subway, s.x, s.z));
  }
  world.districts = {
      District{"새솔동", -22, -22, std::nullopt},
      District{"은빛동", 24, -20, std::nullopt},
      District{"나루동", -20, 22, std::nullopt},
      District{"하늘동", 26, 26, std::nullopt},
  };
  world.start = WorldPoint{-30, 0};
  world.spawn = {{-24, 0}, {-17, 0}, {-9.5, 0}, {-30, 7}, {20, -6}, {-2, -10}, {14, 20}};
  world.loopWays = {{-30, 0}, {20, 0}, {20, 30}, {-30, 30}};
  return world;
}

ProceduralWorld buildProceduralWorld(ProceduralLayout layout, double seed) {
  return layout == ProceduralLayout::Town ? buildTownWorld(seed) : buildGridWorld(seed);
}

// ---------------------------------------------------------------------------------------------------
// WorldData conversion
// ---------------------------------------------------------------------------------------------------

namespace {

Value pointsValue(const std::vector<Vec2>& pts) {
  Value out = Value::array();
  out.items().reserve(pts.size());
  for (const Vec2& p : pts) out.push(Value::array({p[0], p[1]}));
  return out;
}

/// Outline of a ribbon (polyline with width) as a simple polygon: both sides offset by width/2 along the
/// per-vertex normal (the town river's curvature radius is > 200 units, so the sides never cross).
std::vector<Vec2> ribbonPolygon(const std::vector<Vec2>& pts, double width) {
  const std::size_t n = pts.size();
  std::vector<Vec2> left, right;
  if (n < 2) return {};
  for (std::size_t i = 0; i < n; ++i) {
    const Vec2& a = pts[i == 0 ? 0 : i - 1];
    const Vec2& b = pts[i + 1 < n ? i + 1 : n - 1];
    double tx = b[0] - a[0], tz = b[1] - a[1];
    const double len = std::sqrt(tx * tx + tz * tz);
    if (len <= 0) continue;
    tx /= len;
    tz /= len;
    const double hw = width / 2;
    left.push_back(Vec2{pts[i][0] - tz * hw, pts[i][1] + tx * hw});
    right.push_back(Vec2{pts[i][0] + tz * hw, pts[i][1] - tx * hw});
  }
  std::vector<Vec2> ring = left;
  ring.insert(ring.end(), right.rbegin(), right.rend());
  return normalizeRing(ring);
}

std::vector<Vec2> circlePolygon(double cx, double cz, double radius, int segments) {
  std::vector<Vec2> ring;
  for (int k = 0; k < segments; ++k) {
    const double a = (static_cast<double>(k) / segments) * kPi * 2;
    ring.push_back(Vec2{cx + std::cos(a) * radius, cz + std::sin(a) * radius});
  }
  return normalizeRing(ring);
}

}  // namespace

Value proceduralWorldData(const ProceduralWorld& world) {
  Value roads = Value::array();
  for (const GraphRoad& r : world.graph.roads) {
    Value road = Value::object({{"id", r.id}});
    if (r.name) road.set("name", *r.name);
    road.set("cls", std::string(enumName(r.cls)));
    if (r.bridge) road.set("bridge", true);
    road.set("pts", pointsValue(r.pts));
    roads.push(std::move(road));
  }
  Value buildings = Value::array();
  for (const ProceduralBuilding& b : world.buildings) {
    buildings.push(Value::object({{"id", b.id},
                                  {"footprint", pointsValue(b.footprint)},
                                  {"height", b.h},
                                  {"kind", std::string(enumName(b.kind))}}));
  }
  Value water = Value::array();
  Value parks = Value::array();
  for (const ProceduralRibbon& r : world.waterRibbons) water.push(pointsValue(ribbonPolygon(r.pts, r.width)));
  for (const ProceduralRibbon& r : world.banks) parks.push(Value::object({{"poly", pointsValue(ribbonPolygon(r.pts, r.width))}}));
  for (const Park& p : world.parks) {
    Value park = Value::object();
    if (p.name) park.set("name", *p.name);
    park.set("poly", pointsValue(p.poly));
    parks.push(std::move(park));
  }
  for (const ProceduralGridBlock& bl : world.gridBlocks) {
    if (bl.kind != ProceduralGridBlock::Kind::Park) continue;
    // engine-web: an 8x8 grass pad with a pond (radius 2.1) in the middle.
    const std::vector<Vec2> pad{{bl.cx - 4, bl.cz - 4}, {bl.cx + 4, bl.cz - 4}, {bl.cx + 4, bl.cz + 4}, {bl.cx - 4, bl.cz + 4}};
    parks.push(Value::object({{"poly", pointsValue(normalizeRing(pad))}}));
    water.push(pointsValue(circlePolygon(bl.cx, bl.cz, 2.1, 24)));
  }
  Value pois = Value::array();
  for (const Poi& p : world.pois) {
    pois.push(Value::object({{"id", p.id}, {"name", p.name}, {"cat", std::string(enumName(p.cat))}, {"x", p.x}, {"z", p.z}}));
  }
  Value stations = Value::array();
  for (const Station& s : world.stations) {
    stations.push(Value::object({{"id", s.id}, {"name", s.name}, {"x", s.x}, {"z", s.z}}));
  }
  Value districts = Value::array();
  for (const District& d : world.districts) {
    Value district = Value::object({{"name", d.name}, {"x", d.x}, {"z", d.z}});
    if (d.water) district.set("water", *d.water);
    districts.push(std::move(district));
  }
  Value out = Value::object({
      {"version", 1},
      {"name", world.name},
      {"origin", Value::object({{"lng", world.origin.lng}, {"lat", world.origin.lat}})},
      {"unitMeters", world.unitMeters},
      {"bounds", Value::object({{"minX", world.bounds.minX},
                                {"minZ", world.bounds.minZ},
                                {"maxX", world.bounds.maxX},
                                {"maxZ", world.bounds.maxZ}})},
      {"roads", std::move(roads)},
      {"buildings", std::move(buildings)},
      {"water", std::move(water)},
      {"parks", std::move(parks)},
      {"pois", std::move(pois)},
      {"stations", std::move(stations)},
      {"districts", std::move(districts)},
  });
  if (world.plaza) out.set("plaza", Value::object({{"x", world.plaza->x}, {"z", world.plaza->z}}));
  out.set("attribution", Value::array());
  return out;
}

}  // namespace maprama
