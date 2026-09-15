// Maprama native core — planar road graph (port of engine-web `src/world/graph.ts`).
//
// `buildRoadGraph` planarizes road polylines exactly like engine-web's `buildGraph`: every pair of
// segments is intersected, segments are split at crossings, nodes merge on a 0.5-unit key grid, duplicate
// edges are dropped and short dangling edges are pruned iteratively. The operation order (and the JS
// `Math.round` / `Math.hypot` semantics in `js_math`) is kept so a generated world matches engine-web's
// node for node (DESIGN.md §6.8). `snapToGraph` is engine-web's `snap` (nearest point on any edge).
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "maprama/types.hpp"

namespace maprama {

/// JavaScript `Math` semantics the ported generators rely on (bit-for-bit with V8).
namespace js_math {
/// ECMAScript `ToInt32` (used by `x | 0`).
std::int32_t toInt32(double value);
/// `Math.round`: rounds half up (towards +Infinity), keeps -0 / NaN like V8.
double round(double value);
/// V8's `Math.hypot(a, b)`: normalises by the larger magnitude and sums with Kahan compensation.
double hypot(double a, double b);
/// `Math.max(lo, Math.min(hi, v))` (engine-web `clamp`).
double clamp(double v, double lo, double hi);

/// engine-web `mulberry32` PRNG: identical 32-bit state updates and output in [0, 1).
class Mulberry32 {
 public:
  explicit Mulberry32(double seed) : a_(static_cast<std::uint32_t>(toInt32(seed))) {}
  double next();
  double operator()() { return next(); }

 private:
  std::uint32_t a_;
};
}  // namespace js_math

/// engine-web `ROAD_W`: road width in world units per class.
double roadWidthUnits(RoadClass cls);

/// Input polyline of `buildRoadGraph` (engine-web `GraphRoad`).
struct GraphRoad {
  std::string id;
  std::optional<std::string> name;
  RoadClass cls = RoadClass::Local;
  bool bridge = false;
  std::vector<Vec2> pts;
};

struct GraphNode {
  double x = 0.0;
  double z = 0.0;
};

struct GraphEdge {
  int a = 0;
  int b = 0;
  RoadClass cls = RoadClass::Local;
  /// Index of the source road in `RoadGraph::roads` (engine-web keeps `roadId` / `name` copies).
  int road = 0;
  bool bridge = false;
  double len = 0.0;
};

struct RoadGraph {
  std::vector<GraphNode> nodes;
  std::vector<GraphEdge> edges;
  /// Edge indices incident to each node.
  std::vector<std::vector<int>> adj;
  /// The source roads (the input of `buildRoadGraph`).
  std::vector<GraphRoad> roads;
};

struct GraphSnap {
  double x = 0.0;
  double z = 0.0;
  /// Edge index.
  int e = 0;
  /// Parameter along the edge from `a` (0) to `b` (1).
  double t = 0.0;
  /// Distance from the query point, world units.
  double dist = 0.0;
};

/// engine-web `buildGraph(roads, {pruneLength, minSegment})`.
RoadGraph buildRoadGraph(std::vector<GraphRoad> roads, double pruneLength = 2.5, double minSegment = 0.3);

/// engine-web `snap`: nearest point on any edge; `std::nullopt` for a graph without edges.
std::optional<GraphSnap> snapToGraph(const RoadGraph& graph, double x, double z);

}  // namespace maprama
