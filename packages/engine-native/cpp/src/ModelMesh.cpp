#include "maprama/ModelMesh.hpp"

#include <algorithm>
#include <atomic>

namespace maprama {

std::uint64_t nextModelMeshId() {
  static std::atomic<std::uint64_t> next{1};
  return next.fetch_add(1);
}

std::vector<Mat4> globalTransforms(const std::vector<ModelNode>& nodes, const std::vector<Mat4>& locals) {
  std::vector<Mat4> out(nodes.size());
  for (std::size_t i = 0; i < nodes.size(); ++i) {
    const int parent = nodes[i].parent;
    out[i] = parent >= 0 && static_cast<std::size_t>(parent) < i ? model_math::multiply(out[static_cast<std::size_t>(parent)], locals[i])
                                                                   : locals[i];
  }
  return out;
}

std::vector<Mat4> jointPalette(const std::vector<ModelJoint>& joints, const std::vector<Mat4>& globals) {
  std::vector<Mat4> out;
  out.reserve(joints.size());
  for (const ModelJoint& j : joints) {
    if (j.node < 0 || static_cast<std::size_t>(j.node) >= globals.size()) {
      out.push_back(j.inverseBind);
    } else {
      out.push_back(model_math::multiply(globals[static_cast<std::size_t>(j.node)], j.inverseBind));
    }
  }
  return out;
}

std::vector<Mat4> restPalette(const ModelAsset& asset) {
  std::vector<Mat4> locals;
  locals.reserve(asset.nodes.size());
  for (const ModelNode& n : asset.nodes) locals.push_back(n.local());
  return jointPalette(asset.joints, globalTransforms(asset.nodes, locals));
}

Mat4 normalizeTransform(const Vec3d& boundsMin, const Vec3d& boundsMax, double size, bool byMaxExtent) {
  const double sx = boundsMax[0] - boundsMin[0], sy = boundsMax[1] - boundsMin[1], sz = boundsMax[2] - boundsMin[2];
  const double ref = byMaxExtent ? std::max(sx, std::max(sy, sz)) : sy;
  const double k = ref > 1e-6 && std::isfinite(ref) ? size / ref : 1.0;
  const double cx = k * (boundsMin[0] + boundsMax[0]) / 2, cz = k * (boundsMin[2] + boundsMax[2]) / 2;
  return model_math::multiply(model_math::translation(-cx, -k * boundsMin[1], -cz), model_math::scaling(k, k, k));
}

Vec3d skinPosition(const ModelVertex& v, const std::vector<Mat4>& palette) {
  const Vec3d p{v.position[0], v.position[1], v.position[2]};
  Vec3d out{0, 0, 0};
  double total = 0;
  for (int k = 0; k < 4; ++k) {
    const double w = v.weights[k] / 255.0;
    if (w <= 0 || v.joints[k] >= palette.size()) continue;
    const Vec3d q = model_math::transformPoint(palette[v.joints[k]], p);
    for (int c = 0; c < 3; ++c) out[static_cast<std::size_t>(c)] += q[static_cast<std::size_t>(c)] * w;
    total += w;
  }
  if (total <= 0) return p;
  for (double& c : out) c /= total;
  return out;
}

}  // namespace maprama
