// Maprama native core — M3b 3D models: the engine vertex format, GPU-ready meshes, the node hierarchy and
// animation clips of a loaded glTF (or a procedural body), and the small matrix / quaternion helpers the
// loader, the animation sampler and the frame builder share (DESIGN.md §6.3, §6.4).
//
// Conventions:
//   - matrices are column-major `double[16]` (`Mat4`), like glTF and MapLibre; quaternions are (x, y, z, w);
//   - model space is glTF's: +Y up, +Z forward (three.js object space of engine-web), meters or world units;
//   - skinning: every vertex has 4 joint indices into the draw's palette and 4 unorm8 weights. Palette entry 0
//     is always the identity (static geometry is baked into model space and bound to it); rigidly animated
//     nodes (the example robot) get one palette entry each with an identity inverse bind matrix, skin joints
//     one entry each with their inverse bind matrix. At most `kMaxJoints` entries per model.
#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace maprama {

/// DESIGN.md §6.4: at most 64 palette entries (joints) per model, 4 influences per vertex.
inline constexpr std::size_t kMaxJoints = 64;

using Mat4 = std::array<double, 16>;
using Vec3d = std::array<double, 3>;
using Quat = std::array<double, 4>;

namespace model_math {

inline constexpr double kPi = 3.14159265358979323846;

inline Mat4 identity() { return Mat4{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}; }

inline Mat4 multiply(const Mat4& a, const Mat4& b) {
  Mat4 out{};
  for (int col = 0; col < 4; ++col) {
    for (int row = 0; row < 4; ++row) {
      double sum = 0;
      for (int i = 0; i < 4; ++i) sum += a[static_cast<std::size_t>(i * 4 + row)] * b[static_cast<std::size_t>(col * 4 + i)];
      out[static_cast<std::size_t>(col * 4 + row)] = sum;
    }
  }
  return out;
}

inline Mat4 translation(double x, double y, double z) { return Mat4{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1}; }
inline Mat4 scaling(double x, double y, double z) { return Mat4{x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1}; }
inline Mat4 rotationX(double a) {
  const double c = std::cos(a), s = std::sin(a);
  return Mat4{1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1};
}
inline Mat4 rotationY(double a) {
  const double c = std::cos(a), s = std::sin(a);
  return Mat4{c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1};
}
inline Mat4 rotationZ(double a) {
  const double c = std::cos(a), s = std::sin(a);
  return Mat4{c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
}

/// three.js `Euler(x, y, z, 'XYZ')`: R = Rx · Ry · Rz.
inline Mat4 eulerXYZ(double x, double y, double z) { return multiply(multiply(rotationX(x), rotationY(y)), rotationZ(z)); }

/// T · R(q) · S (glTF node TRS, three.js `Matrix4.compose`).
inline Mat4 compose(const Vec3d& t, const Quat& q, const Vec3d& s) {
  const double x = q[0], y = q[1], z = q[2], w = q[3];
  const double x2 = x + x, y2 = y + y, z2 = z + z;
  const double xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const double wx = w * x2, wy = w * y2, wz = w * z2;
  return Mat4{(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
              (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
              (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
              t[0], t[1], t[2], 1};
}

inline Vec3d transformPoint(const Mat4& m, const Vec3d& p) {
  return Vec3d{m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
               m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]};
}

inline Vec3d transformDirection(const Mat4& m, const Vec3d& d) {
  return Vec3d{m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]};
}

/// Inverse transpose of the upper 3x3 (normal matrix), as a Mat4 without translation.
inline Mat4 normalMatrix(const Mat4& m) {
  const double a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const double A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const double det = a * A + b * B + c * C;
  const double k = std::fabs(det) > 1e-300 ? 1.0 / det : 0.0;
  // inverse^T: cofactor matrix / det.
  const double D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const double G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  return Mat4{A * k, D * k, G * k, 0, B * k, E * k, H * k, 0, C * k, F * k, I * k, 0, 0, 0, 0, 1};
}

inline Vec3d normalize(const Vec3d& v) {
  const double l = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return l > 1e-12 ? Vec3d{v[0] / l, v[1] / l, v[2] / l} : Vec3d{0, 1, 0};
}

inline Quat normalizeQuat(const Quat& q) {
  const double l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  return l > 1e-12 ? Quat{q[0] / l, q[1] / l, q[2] / l, q[3] / l} : Quat{0, 0, 0, 1};
}

/// three.js `Quaternion.slerpFlat` (shortest path, linear fallback for nearly equal inputs).
inline Quat slerp(const Quat& a, const Quat& b0, double t) {
  if (t <= 0) return a;
  if (t >= 1) return b0;
  Quat b = b0;
  double cosHalf = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  double s = 1 - t;
  const double dir = cosHalf >= 0 ? 1 : -1;
  const double sqrSin = 1 - cosHalf * cosHalf;
  if (sqrSin > 2.220446049250313e-16) {
    const double sinHalf = std::sqrt(sqrSin), len = std::atan2(sinHalf, cosHalf * dir);
    s = std::sin(s * len) / sinHalf;
    t = std::sin(t * len) / sinHalf;
  }
  const double tDir = t * dir;
  Quat out{a[0] * s + b[0] * tDir, a[1] * s + b[1] * tDir, a[2] * s + b[2] * tDir, a[3] * s + b[3] * tDir};
  if (s == 1 - t) out = normalizeQuat(out);
  return out;
}

inline Quat quatFromAxisAngle(const Vec3d& axis, double angle) {
  const double h = angle / 2, s = std::sin(h);
  return Quat{axis[0] * s, axis[1] * s, axis[2] * s, std::cos(h)};
}

inline std::array<float, 16> toFloat(const Mat4& m) {
  std::array<float, 16> out{};
  for (std::size_t i = 0; i < 16; ++i) out[i] = static_cast<float>(m[i]);
  return out;
}

/// glTF colour factors are linear; the layers shade in sRGB (like MapLibre and the building layer).
inline double linearToSrgb(double c) {
  c = c < 0 ? 0 : (c > 1 ? 1 : c);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * std::pow(c, 1.0 / 2.4) - 0.055;
}

}  // namespace model_math

/// One vertex of a model mesh (36 bytes, identical layout in the Metal and GL vertex descriptors).
struct ModelVertex {
  /// Model space (glTF: +Y up, +Z forward).
  float position[3];
  /// Unit normal as snorm8; [3] = 127 marks an unlit surface (engine-web `MeshBasicMaterial`: eyes, lamps).
  std::int8_t normal[4];
  /// Base colour texture coordinates (unused when the part has no texture).
  float uv[2];
  /// sRGB base colour (material factor × vertex colour), a = opacity.
  std::uint8_t color[4];
  /// Palette indices (relative to the draw's palette).
  std::uint8_t joints[4];
  /// Skinning weights (unorm8, sum 255).
  std::uint8_t weights[4];
};
static_assert(sizeof(ModelVertex) == 36, "ModelVertex layout is shared with the shaders");

/// A decoded base colour texture (RGBA8, rows top to bottom, straight alpha).
struct ModelTexture {
  int width = 0;
  int height = 0;
  std::vector<std::uint8_t> rgba;
};

enum class ModelAlpha : std::uint8_t { Opaque, Mask, Blend };

/// A range of triangles with one texture and alpha mode (one draw call per part and instance batch).
struct ModelPart {
  std::uint32_t firstIndex = 0;
  std::uint32_t indexCount = 0;
  /// Index into `ModelMesh::textures`, -1 = untextured.
  int texture = -1;
  ModelAlpha alpha = ModelAlpha::Opaque;
  float alphaCutoff = 0.5f;
  /// Additive glow (drop beams / rings); implies the translucent pass.
  bool additive = false;
  bool translucent() const { return alpha == ModelAlpha::Blend || additive; }
};

/// Immutable GPU-ready geometry, shared between the core and the render thread.
struct ModelMesh {
  /// Unique per process (the platforms cache GPU buffers by it).
  std::uint64_t id = 0;
  std::string name;
  std::vector<ModelVertex> vertices;
  std::vector<std::uint32_t> indices;
  std::vector<ModelPart> parts;
  std::vector<ModelTexture> textures;
  /// Palette entries the vertices reference (≥ 1).
  std::uint32_t joints = 1;
};

/// A fresh `ModelMesh::id`.
std::uint64_t nextModelMeshId();

/// One node of a loaded glTF scene; parents come before their children.
struct ModelNode {
  std::string name;
  int parent = -1;
  Vec3d translation{0, 0, 0};
  Quat rotation{0, 0, 0, 1};
  Vec3d scale{1, 1, 1};
  /// A node given as a matrix (glTF forbids animating those).
  bool hasMatrix = false;
  Mat4 matrix = model_math::identity();

  Mat4 local() const { return hasMatrix ? matrix : model_math::compose(translation, rotation, scale); }
};

/// One palette entry: `global(node) × inverseBind` (node -1 = identity).
struct ModelJoint {
  int node = -1;
  Mat4 inverseBind = model_math::identity();
};

enum class ChannelPath : std::uint8_t { Translation, Rotation, Scale };
enum class ChannelInterpolation : std::uint8_t { Linear, Step, CubicSpline };

/// One animated TRS property. `values` holds 3 (or 4 for rotations) numbers per key, times 3 for cubic splines
/// (in-tangent, value, out-tangent, glTF order).
struct ModelChannel {
  int node = 0;
  ChannelPath path = ChannelPath::Translation;
  ChannelInterpolation interpolation = ChannelInterpolation::Linear;
  std::vector<float> times;
  std::vector<float> values;
};

struct ModelClip {
  std::string name;
  /// Longest channel (three.js `AnimationClip.resetDuration`).
  double duration = 0.0;
  std::vector<ModelChannel> channels;
};

/// A loaded model: its mesh, skeleton (nodes + palette joints), clips and rest-pose bounds.
struct ModelAsset {
  std::string uri;
  std::shared_ptr<const ModelMesh> mesh;
  std::vector<ModelNode> nodes;
  std::vector<ModelJoint> joints;
  std::vector<ModelClip> clips;
  /// Model-space bounds of the skinned rest pose (engine-web `Box3.setFromObject` of the loaded scene).
  Vec3d boundsMin{0, 0, 0};
  Vec3d boundsMax{0, 0, 0};
  /// Diagnostics.
  std::size_t triangles = 0;
  std::size_t skins = 0;
  std::size_t animatedNodes = 0;
};

/// Global (model-space) transforms of the nodes for local transforms `locals` (same order as `nodes`).
std::vector<Mat4> globalTransforms(const std::vector<ModelNode>& nodes, const std::vector<Mat4>& locals);

/// The palette (`joints.size()` matrices) for the given node globals.
std::vector<Mat4> jointPalette(const std::vector<ModelJoint>& joints, const std::vector<Mat4>& globals);

/// Rest-pose palette of an asset (node TRS as loaded).
std::vector<Mat4> restPalette(const ModelAsset& asset);

/// engine-web `normalizeModel`: centred on x/z, feet (min y) at 0, height (or the largest extent with
/// `byMaxExtent`) scaled to `size`; returns the model-space → wrapper matrix.
Mat4 normalizeTransform(const Vec3d& boundsMin, const Vec3d& boundsMax, double size, bool byMaxExtent);

/// A skinned vertex position for a palette (tests, bounds).
Vec3d skinPosition(const ModelVertex& v, const std::vector<Mat4>& palette);

}  // namespace maprama
