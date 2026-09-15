#include "maprama/RoadGraph.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <utility>

// The generators must reproduce V8's double arithmetic: no fused multiply-add (arm64 clang contracts
// `a * b + c` by default, which changes the last bit and eventually which lots get a building).
#if defined(__clang__)
#pragma clang fp contract(off)
#endif

namespace maprama {

namespace js_math {

std::int32_t toInt32(double value) {
  if (!std::isfinite(value)) return 0;
  double m = std::fmod(std::trunc(value), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return static_cast<std::int32_t>(static_cast<std::uint32_t>(m));
}

double round(double value) {
  if (!std::isfinite(value) || value == 0.0) return value;
  if (value > 0.0 && value < 0.5) return 0.0;
  if (value < 0.0 && value >= -0.5) return -0.0;
  double r = std::floor(value);
  if (value - r >= 0.5) r += 1.0;
  return r;
}

double hypot(double a, double b) {
  const double values[2] = {std::fabs(a), std::fabs(b)};
  bool nan = false;
  double max = 0.0;
  for (double v : values) {
    if (std::isnan(v)) {
      nan = true;
    } else if (v > max) {
      max = v;
    }
  }
  if (max == std::numeric_limits<double>::infinity()) return max;
  if (nan) return std::numeric_limits<double>::quiet_NaN();
  if (max == 0.0) return 0.0;
  double sum = 0.0;
  double compensation = 0.0;
  for (double v : values) {
    const double n = v / max;
    const double summand = n * n - compensation;
    const double preliminary = sum + summand;
    compensation = (preliminary - sum) - summand;
    sum = preliminary;
  }
  return std::sqrt(sum) * max;
}

double clamp(double v, double lo, double hi) {
  if (std::isnan(v) || std::isnan(lo) || std::isnan(hi)) return std::numeric_limits<double>::quiet_NaN();
  const double m = v < hi ? v : hi;
  return m > lo ? m : lo;
}

double Mulberry32::next() {
  // a |= 0; a = (a + 0x6d2b79f5) | 0; t = imul(a ^ a >>> 15, 1 | a); t = (t + imul(t ^ t >>> 7, 61 | t)) ^ t;
  // return ((t ^ t >>> 14) >>> 0) / 4294967296  -- all in wrapping 32-bit arithmetic.
  a_ += 0x6d2b79f5u;
  std::uint32_t t = (a_ ^ (a_ >> 15)) * (1u | a_);
  t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
  return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
}

}  // namespace js_math

double roadWidthUnits(RoadClass cls) {
  switch (cls) {
    case RoadClass::Arterial:
      return 3.0;
    case RoadClass::Local:
      return 2.0;
    case RoadClass::Alley:
      return 1.3;
  }
  return 2.0;
}

RoadGraph buildRoadGraph(std::vector<GraphRoad> roads, double pruneLength, double minSegment) {
  RoadGraph g;
  g.roads = std::move(roads);
  std::vector<GraphNode>& nodes = g.nodes;
  std::vector<GraphEdge>& edges = g.edges;
  std::vector<std::vector<int>>& adj = g.adj;

  std::map<std::pair<long long, long long>, int> nodeKey;
  const auto node = [&](double x, double z) -> int {
    const std::pair<long long, long long> key{static_cast<long long>(js_math::round(x * 2)),
                                              static_cast<long long>(js_math::round(z * 2))};
    const auto found = nodeKey.find(key);
    if (found != nodeKey.end()) return found->second;
    const int id = static_cast<int>(nodes.size());
    nodes.push_back(GraphNode{x, z});
    adj.emplace_back();
    nodeKey.emplace(key, id);
    return id;
  };
  const auto edge = [&](int a, int b, int roadIndex) {
    if (a == b) return;
    for (int ei : adj[a]) {
      const GraphEdge& e = edges[ei];
      if (e.a == b || e.b == b) return;
    }
    const GraphNode A = nodes[a];
    const GraphNode B = nodes[b];
    const int id = static_cast<int>(edges.size());
    adj[a].push_back(id);
    adj[b].push_back(id);
    const GraphRoad& r = g.roads[roadIndex];
    edges.push_back(GraphEdge{a, b, r.cls, roadIndex, r.bridge, js_math::hypot(B.x - A.x, B.z - A.z)});
  };

  struct Seg {
    int ri;
    Vec2 a;
    Vec2 b;
    std::vector<double> ts;
  };
  std::vector<Seg> segs;
  for (std::size_t ri = 0; ri < g.roads.size(); ++ri) {
    const std::vector<Vec2>& pts = g.roads[ri].pts;
    for (std::size_t i = 0; i + 1 < pts.size(); ++i) segs.push_back(Seg{static_cast<int>(ri), pts[i], pts[i + 1], {0.0, 1.0}});
  }
  // bbox pre-check keeps the O(n²) pass fast for real data
  std::vector<std::array<double, 4>> boxes;
  boxes.reserve(segs.size());
  for (const Seg& s : segs) {
    boxes.push_back({std::min(s.a[0], s.b[0]), std::min(s.a[1], s.b[1]), std::max(s.a[0], s.b[0]), std::max(s.a[1], s.b[1])});
  }
  for (std::size_t i = 0; i < segs.size(); ++i) {
    Seg& s = segs[i];
    const std::array<double, 4>& bs = boxes[i];
    for (std::size_t j = i + 1; j < segs.size(); ++j) {
      const std::array<double, 4>& bt = boxes[j];
      if (bt[0] > bs[2] + 1e-6 || bt[2] < bs[0] - 1e-6 || bt[1] > bs[3] + 1e-6 || bt[3] < bs[1] - 1e-6) continue;
      Seg& t = segs[j];
      const double rx = s.b[0] - s.a[0], rz = s.b[1] - s.a[1], qx = t.b[0] - t.a[0], qz = t.b[1] - t.a[1];
      const double den = rx * qz - rz * qx;
      if (std::fabs(den) < 1e-9) continue;
      const double wx = t.a[0] - s.a[0], wz = t.a[1] - s.a[1];
      const double u = (wx * qz - wz * qx) / den, v = (wx * rz - wz * rx) / den;
      if (u > 1e-6 && u < 1 - 1e-6 && v >= -1e-6 && v <= 1 + 1e-6) s.ts.push_back(u);
      if (v > 1e-6 && v < 1 - 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) t.ts.push_back(v);
    }
  }
  for (const Seg& s : segs) {
    std::vector<double> ts;
    ts.reserve(s.ts.size());
    for (double t : s.ts) ts.push_back(js_math::round(t * 1e5) / 1e5);
    std::sort(ts.begin(), ts.end());
    ts.erase(std::unique(ts.begin(), ts.end()), ts.end());
    for (std::size_t k = 0; k + 1 < ts.size(); ++k) {
      const double x0 = s.a[0] + (s.b[0] - s.a[0]) * ts[k], z0 = s.a[1] + (s.b[1] - s.a[1]) * ts[k];
      const double x1 = s.a[0] + (s.b[0] - s.a[0]) * ts[k + 1], z1 = s.a[1] + (s.b[1] - s.a[1]) * ts[k + 1];
      if (js_math::hypot(x1 - x0, z1 - z0) < minSegment) continue;
      // JS evaluates the two `node()` calls left to right; node ids depend on that order.
      const int a = node(x0, z0);
      const int b = node(x1, z1);
      edge(a, b, s.ri);
    }
  }

  std::vector<std::uint8_t> dead(edges.size(), 0);
  const auto degree = [&](int n) {
    int count = 0;
    for (int ei : adj[n]) {
      if (!dead[ei]) ++count;
    }
    return count;
  };
  for (bool changed = true; changed;) {
    changed = false;
    for (std::size_t i = 0; i < edges.size(); ++i) {
      const GraphEdge& e = edges[i];
      if (!dead[i] && e.len < pruneLength && (degree(e.a) == 1 || degree(e.b) == 1)) {
        dead[i] = 1;
        changed = true;
      }
    }
  }
  std::vector<GraphEdge> kept;
  kept.reserve(edges.size());
  for (std::size_t i = 0; i < edges.size(); ++i) {
    if (!dead[i]) kept.push_back(edges[i]);
  }
  edges = std::move(kept);
  adj.assign(nodes.size(), {});
  for (std::size_t i = 0; i < edges.size(); ++i) {
    adj[edges[i].a].push_back(static_cast<int>(i));
    adj[edges[i].b].push_back(static_cast<int>(i));
  }
  return g;
}

std::optional<GraphSnap> snapToGraph(const RoadGraph& graph, double x, double z) {
  std::optional<GraphSnap> best;
  double bd = std::numeric_limits<double>::infinity();
  for (std::size_t i = 0; i < graph.edges.size(); ++i) {
    const GraphEdge& e = graph.edges[i];
    const GraphNode& A = graph.nodes[e.a];
    const GraphNode& B = graph.nodes[e.b];
    const double dx = B.x - A.x, dz = B.z - A.z;
    double L2 = dx * dx + dz * dz;
    if (!(L2 != 0.0)) L2 = 1.0;  // `|| 1` (0 and NaN)
    const double t = js_math::clamp(((x - A.x) * dx + (z - A.z) * dz) / L2, 0, 1);
    const double px = A.x + dx * t, pz = A.z + dz * t;
    const double d = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d < bd) {
      bd = d;
      best = GraphSnap{px, pz, static_cast<int>(i), t, 0.0};
    }
  }
  if (best) best->dist = std::sqrt(bd);
  return best;
}

namespace {

/// engine-web's binary min-heap of `[priority, value]` (same sift order, so equal priorities pop alike).
class MinHeap {
 public:
  std::size_t size() const { return h_.size(); }

  void push(double d, int n) {
    h_.emplace_back(d, n);
    std::size_t i = h_.size() - 1;
    while (i > 0) {
      const std::size_t p = (i - 1) >> 1;
      if (h_[p].first <= h_[i].first) break;
      std::swap(h_[p], h_[i]);
      i = p;
    }
  }

  std::pair<double, int> pop() {
    const std::pair<double, int> top = h_[0];
    const std::pair<double, int> last = h_.back();
    h_.pop_back();
    if (!h_.empty()) {
      h_[0] = last;
      std::size_t i = 0;
      for (;;) {
        const std::size_t l = 2 * i + 1, r = l + 1;
        std::size_t m = i;
        if (l < h_.size() && h_[l].first < h_[m].first) m = l;
        if (r < h_.size() && h_[r].first < h_[m].first) m = r;
        if (m == i) break;
        std::swap(h_[m], h_[i]);
        i = m;
      }
    }
    return top;
  }

 private:
  std::vector<std::pair<double, int>> h_;
};

/// `Math.min(a, b)` for the non-negative distances used here (NaN propagates like JS).
double jsMin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  return b < a ? b : a;
}

}  // namespace

std::vector<WorldPoint> routeOnGraph(const RoadGraph& g, const GraphSnap& s, const GraphSnap& e) {
  if (s.e == e.e) return {WorldPoint{s.x, s.z}, WorldPoint{e.x, e.z}};
  const std::size_t n = g.nodes.size();
  std::vector<double> dist(n, std::numeric_limits<double>::infinity());
  std::vector<int> prev(n, -1);
  std::vector<std::uint8_t> done(n, 0);
  MinHeap heap;
  const GraphEdge& es = g.edges[static_cast<std::size_t>(s.e)];
  const GraphEdge& ee = g.edges[static_cast<std::size_t>(e.e)];
  for (const int node : {es.a, es.b}) {
    const GraphNode& p = g.nodes[static_cast<std::size_t>(node)];
    dist[node] = jsMin(dist[node], js_math::hypot(p.x - s.x, p.z - s.z));
    heap.push(dist[node], node);
  }
  while (heap.size() > 0) {
    const std::pair<double, int> top = heap.pop();
    const double d = top.first;
    const int u = top.second;
    if (done[u]) continue;
    done[u] = 1;
    for (const int ei : g.adj[static_cast<std::size_t>(u)]) {
      const GraphEdge& ed = g.edges[static_cast<std::size_t>(ei)];
      const int v = ed.a == u ? ed.b : ed.a;
      const double nd = d + ed.len;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(nd, v);
      }
    }
  }
  int endNode = -1;
  double bestT = std::numeric_limits<double>::infinity();
  for (const int node : {ee.a, ee.b}) {
    const GraphNode& p = g.nodes[static_cast<std::size_t>(node)];
    const double t = dist[node] + js_math::hypot(p.x - e.x, p.z - e.z);
    if (t < bestT) {
      bestT = t;
      endNode = node;
    }
  }
  if (endNode < 0 || !std::isfinite(bestT)) return {WorldPoint{s.x, s.z}};
  std::vector<int> chain;
  for (int u = endNode; u >= 0; u = prev[u]) chain.push_back(u);
  std::reverse(chain.begin(), chain.end());
  std::vector<WorldPoint> pts;
  pts.reserve(chain.size() + 2);
  pts.push_back(WorldPoint{s.x, s.z});
  for (const int u : chain) pts.push_back(WorldPoint{g.nodes[static_cast<std::size_t>(u)].x, g.nodes[static_cast<std::size_t>(u)].z});
  pts.push_back(WorldPoint{e.x, e.z});
  // `pts.filter((p, i) => i === 0 || hypot(p - pts[i - 1]) > 0.01)`: compares with the unfiltered predecessor.
  std::vector<WorldPoint> out;
  out.reserve(pts.size());
  for (std::size_t i = 0; i < pts.size(); ++i) {
    if (i == 0 || js_math::hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z) > 0.01) out.push_back(pts[i]);
  }
  return out;
}

double polylineLength(const std::vector<WorldPoint>& pts) {
  double d = 0.0;
  for (std::size_t i = 0; i + 1 < pts.size(); ++i) d += js_math::hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
  return d;
}

}  // namespace maprama
