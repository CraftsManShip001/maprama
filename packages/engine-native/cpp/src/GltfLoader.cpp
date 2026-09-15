#include "maprama/GltfLoader.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <set>
#include <tuple>
#include <unordered_map>
#include <utility>

// cgltf v1.15 (MIT, cpp/vendor/cgltf/LICENSE): a C99 single-header parser, compiled here once. Its own warnings
// are not ours to fix (the core builds with -Werror).
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#elif defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#pragma GCC diagnostic ignored "-Wextra"
#pragma GCC diagnostic ignored "-Wall"
#endif
#define CGLTF_IMPLEMENTATION
#include "../vendor/cgltf/cgltf.h"
#if defined(__clang__)
#pragma clang diagnostic pop
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace maprama {

namespace {

namespace mm = model_math;

int base64Value(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+' || c == '-') return 62;
  if (c == '/' || c == '_') return 63;
  return -1;
}

std::optional<std::string> base64Decode(std::string_view s) {
  std::string out;
  out.reserve(s.size() * 3 / 4);
  std::uint32_t acc = 0;
  int bits = 0;
  for (const char c : s) {
    if (c == '=') break;
    if (std::isspace(static_cast<unsigned char>(c))) continue;
    const int v = base64Value(c);
    if (v < 0) return std::nullopt;
    acc = (acc << 6) | static_cast<std::uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<char>((acc >> bits) & 0xFFu));
    }
  }
  return out;
}

int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

std::string percentDecode(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size() && hexValue(s[i + 1]) >= 0 && hexValue(s[i + 2]) >= 0) {
      out.push_back(static_cast<char>(hexValue(s[i + 1]) * 16 + hexValue(s[i + 2])));
      i += 2;
    } else {
      out.push_back(s[i]);
    }
  }
  return out;
}

const char* resultText(cgltf_result r) {
  switch (r) {
    case cgltf_result_data_too_short:
      return "the file is truncated";
    case cgltf_result_unknown_format:
      return "not a glTF 2.0 / GLB file";
    case cgltf_result_invalid_json:
      return "invalid glTF JSON";
    case cgltf_result_invalid_gltf:
      return "invalid glTF";
    case cgltf_result_out_of_memory:
      return "out of memory";
    case cgltf_result_legacy_gltf:
      return "glTF 1.0 files are not supported";
    case cgltf_result_file_not_found:
    case cgltf_result_io_error:
      return "a buffer could not be read";
    default:
      return "cannot parse the model";
  }
}

std::uint8_t unorm8(double v) { return static_cast<std::uint8_t>(std::lround(std::clamp(v, 0.0, 1.0) * 255.0)); }

std::int8_t snorm8(double v) { return static_cast<std::int8_t>(std::lround(std::clamp(v, -1.0, 1.0) * 127.0)); }

const cgltf_accessor* attribute(const cgltf_primitive& p, cgltf_attribute_type type, int index = 0) {
  for (cgltf_size i = 0; i < p.attributes_count; ++i) {
    if (p.attributes[i].type == type && p.attributes[i].index == index) return p.attributes[i].data;
  }
  return nullptr;
}

/// Triangle list indices of a primitive (strips and fans converted).
std::vector<std::uint32_t> triangleIndices(const cgltf_primitive& p, std::size_t vertexCount) {
  std::vector<std::uint32_t> raw;
  if (p.indices != nullptr) {
    raw.resize(p.indices->count);
    for (cgltf_size i = 0; i < p.indices->count; ++i) raw[i] = static_cast<std::uint32_t>(cgltf_accessor_read_index(p.indices, i));
  } else {
    raw.resize(vertexCount);
    for (std::size_t i = 0; i < vertexCount; ++i) raw[i] = static_cast<std::uint32_t>(i);
  }
  std::vector<std::uint32_t> out;
  if (p.type == cgltf_primitive_type_triangles) {
    out.assign(raw.begin(), raw.begin() + static_cast<std::ptrdiff_t>(raw.size() - raw.size() % 3));
  } else if (p.type == cgltf_primitive_type_triangle_strip) {
    for (std::size_t i = 2; i < raw.size(); ++i) {
      if (i % 2 == 0) {
        out.insert(out.end(), {raw[i - 2], raw[i - 1], raw[i]});
      } else {
        out.insert(out.end(), {raw[i - 1], raw[i - 2], raw[i]});
      }
    }
  } else if (p.type == cgltf_primitive_type_triangle_fan) {
    for (std::size_t i = 2; i < raw.size(); ++i) out.insert(out.end(), {raw[0], raw[i - 1], raw[i]});
  }
  // Out-of-range indices (cgltf_validate checks accessors, not index values against the vertex count).
  for (std::uint32_t& i : out) {
    if (i >= vertexCount) i = 0;
  }
  return out;
}

struct PartKey {
  int texture = -1;
  ModelAlpha alpha = ModelAlpha::Opaque;
  float cutoff = 0.5f;
  bool operator<(const PartKey& o) const {
    return std::tie(texture, alpha, cutoff) < std::tie(o.texture, o.alpha, o.cutoff);
  }
};

class Builder {
 public:
  Builder(cgltf_data* data, const ModelResources& resources, const ImageDecoder& decode, GltfLoadResult& result)
      : data_(data), resources_(resources), decode_(decode), result_(result) {}

  bool run(const std::string& uri) {
    collectNodes();
    if (!assignJoints()) return false;
    std::vector<Mat4> locals;
    locals.reserve(nodes_.size());
    for (const ModelNode& n : nodes_) locals.push_back(n.local());
    globals_ = globalTransforms(nodes_, locals);
    buildMesh();
    if (mesh_->indices.empty()) {
      result_.error = "the model has no triangles";
      return false;
    }
    buildClips();

    auto asset = std::make_shared<ModelAsset>();
    asset->uri = uri;
    asset->nodes = nodes_;
    asset->joints = joints_;
    asset->clips = std::move(clips_);
    asset->triangles = mesh_->indices.size() / 3;
    asset->skins = skinBase_.size();
    asset->animatedNodes = static_cast<std::size_t>(std::count(animated_.begin(), animated_.end(), 1));
    mesh_->joints = static_cast<std::uint32_t>(joints_.size());
    mesh_->id = nextModelMeshId();
    mesh_->name = uri.size() > 64 ? uri.substr(0, 64) + "…" : uri;
    const std::vector<Mat4> palette = jointPalette(joints_, globals_);
    Vec3d lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300};
    for (const ModelVertex& v : mesh_->vertices) {
      const Vec3d p = skinPosition(v, palette);
      for (std::size_t c = 0; c < 3; ++c) {
        lo[c] = std::min(lo[c], p[c]);
        hi[c] = std::max(hi[c], p[c]);
      }
    }
    asset->boundsMin = lo;
    asset->boundsMax = hi;
    asset->mesh = std::move(mesh_);
    result_.asset = std::move(asset);
    return true;
  }

 private:
  void collectNodes() {
    std::vector<const cgltf_node*> roots;
    const cgltf_scene* scene = data_->scene != nullptr ? data_->scene : (data_->scenes_count > 0 ? &data_->scenes[0] : nullptr);
    if (scene != nullptr) {
      for (cgltf_size i = 0; i < scene->nodes_count; ++i) roots.push_back(scene->nodes[i]);
    } else {
      for (cgltf_size i = 0; i < data_->nodes_count; ++i) {
        if (data_->nodes[i].parent == nullptr) roots.push_back(&data_->nodes[i]);
      }
    }
    // Depth-first with an explicit stack: parents before children, children in file order.
    std::vector<std::pair<const cgltf_node*, int>> stack;
    for (auto it = roots.rbegin(); it != roots.rend(); ++it) stack.emplace_back(*it, -1);
    while (!stack.empty()) {
      const auto [node, parent] = stack.back();
      stack.pop_back();
      if (node == nullptr || index_.count(node) != 0) continue;
      const int i = static_cast<int>(order_.size());
      index_[node] = i;
      order_.push_back(node);
      ModelNode n;
      n.name = node->name != nullptr ? node->name : "";
      n.parent = parent;
      if (node->has_matrix) {
        n.hasMatrix = true;
        for (std::size_t k = 0; k < 16; ++k) n.matrix[k] = node->matrix[k];
      } else {
        if (node->has_translation) n.translation = Vec3d{node->translation[0], node->translation[1], node->translation[2]};
        if (node->has_rotation) n.rotation = mm::normalizeQuat(Quat{node->rotation[0], node->rotation[1], node->rotation[2], node->rotation[3]});
        if (node->has_scale) n.scale = Vec3d{node->scale[0], node->scale[1], node->scale[2]};
      }
      nodes_.push_back(n);
      for (cgltf_size c = node->children_count; c > 0; --c) stack.emplace_back(node->children[c - 1], i);
    }
    animated_.assign(nodes_.size(), 0);
    for (cgltf_size a = 0; a < data_->animations_count; ++a) {
      const cgltf_animation& anim = data_->animations[a];
      for (cgltf_size c = 0; c < anim.channels_count; ++c) {
        const cgltf_animation_channel& ch = anim.channels[c];
        if (ch.target_path == cgltf_animation_path_type_weights || ch.target_path == cgltf_animation_path_type_invalid) continue;
        const auto it = index_.find(ch.target_node);
        if (it != index_.end()) animated_[static_cast<std::size_t>(it->second)] = 1;
      }
    }
    dynamic_.assign(nodes_.size(), 0);
    for (std::size_t i = 0; i < nodes_.size(); ++i) {
      const int p = nodes_[i].parent;
      dynamic_[i] = animated_[i] != 0 || (p >= 0 && dynamic_[static_cast<std::size_t>(p)] != 0) ? 1 : 0;
    }
  }

  bool assignJoints() {
    joints_.push_back(ModelJoint{});  // palette 0: identity (static geometry)
    for (std::size_t i = 0; i < order_.size(); ++i) {
      const cgltf_node* node = order_[i];
      if (node->mesh == nullptr) continue;
      if (node->skin != nullptr) {
        const cgltf_skin* skin = node->skin;
        if (skinBase_.count(skin) != 0) continue;
        skinBase_[skin] = static_cast<std::uint32_t>(joints_.size());
        for (cgltf_size j = 0; j < skin->joints_count; ++j) {
          ModelJoint joint;
          const auto it = index_.find(skin->joints[j]);
          joint.node = it != index_.end() ? it->second : -1;
          if (skin->inverse_bind_matrices != nullptr && j < skin->inverse_bind_matrices->count) {
            cgltf_float m[16];
            if (cgltf_accessor_read_float(skin->inverse_bind_matrices, j, m, 16)) {
              for (std::size_t k = 0; k < 16; ++k) joint.inverseBind[k] = m[k];
            }
          }
          joints_.push_back(joint);
        }
      } else if (dynamic_[i] != 0) {
        nodeSlot_[static_cast<int>(i)] = static_cast<std::uint32_t>(joints_.size());
        joints_.push_back(ModelJoint{static_cast<int>(i), mm::identity()});
      }
    }
    if (joints_.size() > kMaxJoints) {
      result_.error = "the model needs " + std::to_string(joints_.size() - 1) +
                      " skinning joints / animated nodes; engine-native supports at most " + std::to_string(kMaxJoints - 1);
      return false;
    }
    return true;
  }

  int textureFor(const cgltf_texture* texture) {
    if (texture == nullptr || texture->image == nullptr) return -1;
    const cgltf_image* image = texture->image;
    const auto cached = textures_.find(image);
    if (cached != textures_.end()) return cached->second;
    int out = -1;
    const std::uint8_t* bytes = nullptr;
    std::size_t size = 0;
    std::optional<std::string> holder;
    if (image->buffer_view != nullptr) {
      bytes = cgltf_buffer_view_data(image->buffer_view);
      size = image->buffer_view->size;
    } else if (image->uri != nullptr) {
      if (isDataUri(image->uri)) {
        holder = decodeDataUri(image->uri);
      } else {
        const auto it = resources_.find(image->uri);
        if (it != resources_.end()) holder = *it->second;
      }
      if (holder) {
        bytes = reinterpret_cast<const std::uint8_t*>(holder->data());
        size = holder->size();
      }
    }
    if (bytes == nullptr || size == 0) {
      warn("a base colour texture has no image data");
    } else if (!decode_) {
      warn("base colour textures are skipped: no platform image decoder");
    } else {
      ModelTexture t;
      if (decode_(bytes, size, t) && t.width > 0 && t.height > 0 &&
          t.rgba.size() == static_cast<std::size_t>(t.width) * static_cast<std::size_t>(t.height) * 4) {
        mesh_->textures.push_back(std::move(t));
        out = static_cast<int>(mesh_->textures.size() - 1);
      } else {
        warn(std::string("a base colour texture could not be decoded") + (image->mime_type != nullptr ? std::string(" (") + image->mime_type + ")" : ""));
      }
    }
    textures_[image] = out;
    return out;
  }

  void buildMesh() {
    std::map<PartKey, std::vector<std::uint32_t>> parts;
    std::vector<PartKey> partOrder;
    for (std::size_t i = 0; i < order_.size(); ++i) {
      const cgltf_node* node = order_[i];
      if (node->mesh == nullptr) continue;
      const bool skinned = node->skin != nullptr && skinBase_.count(node->skin) != 0;
      Mat4 bake = mm::identity();
      std::uint8_t slot = 0;
      if (!skinned) {
        if (dynamic_[i] != 0) {
          slot = static_cast<std::uint8_t>(nodeSlot_[static_cast<int>(i)]);
        } else {
          bake = globals_[i];
        }
      }
      const Mat4 normals = mm::normalMatrix(bake);
      const std::uint32_t skinBase = skinned ? skinBase_[node->skin] : 0;
      const cgltf_size skinJoints = skinned ? node->skin->joints_count : 0;
      for (cgltf_size pi = 0; pi < node->mesh->primitives_count; ++pi) {
        const cgltf_primitive& prim = node->mesh->primitives[pi];
        if (prim.type != cgltf_primitive_type_triangles && prim.type != cgltf_primitive_type_triangle_strip &&
            prim.type != cgltf_primitive_type_triangle_fan) {
          continue;
        }
        const cgltf_accessor* pos = attribute(prim, cgltf_attribute_type_position);
        if (pos == nullptr || pos->count == 0) continue;
        const cgltf_material* material = prim.material;
        double factor[4] = {1, 1, 1, 1};
        PartKey key;
        bool unlit = false;
        int uvSet = 0;
        if (material != nullptr) {
          if (material->has_pbr_metallic_roughness) {
            const cgltf_pbr_metallic_roughness& pbr = material->pbr_metallic_roughness;
            for (int k = 0; k < 4; ++k) factor[k] = pbr.base_color_factor[k];
            if (pbr.base_color_texture.texture != nullptr) {
              key.texture = textureFor(pbr.base_color_texture.texture);
              uvSet = pbr.base_color_texture.texcoord;
            }
          }
          key.alpha = material->alpha_mode == cgltf_alpha_mode_blend  ? ModelAlpha::Blend
                      : material->alpha_mode == cgltf_alpha_mode_mask ? ModelAlpha::Mask
                                                                      : ModelAlpha::Opaque;
          key.cutoff = key.alpha == ModelAlpha::Mask ? material->alpha_cutoff : 0.5f;
          unlit = material->unlit != 0;
        }
        const cgltf_accessor* nor = attribute(prim, cgltf_attribute_type_normal);
        const cgltf_accessor* uv = key.texture >= 0 ? attribute(prim, cgltf_attribute_type_texcoord, uvSet) : nullptr;
        const cgltf_accessor* col = attribute(prim, cgltf_attribute_type_color);
        const cgltf_accessor* jnt = skinned ? attribute(prim, cgltf_attribute_type_joints) : nullptr;
        const cgltf_accessor* wgt = skinned ? attribute(prim, cgltf_attribute_type_weights) : nullptr;

        const std::size_t count = pos->count;
        const std::uint32_t base = static_cast<std::uint32_t>(mesh_->vertices.size());
        std::vector<Vec3d> faceNormals;
        for (std::size_t v = 0; v < count; ++v) {
          ModelVertex mv{};
          cgltf_float p[3] = {0, 0, 0};
          cgltf_accessor_read_float(pos, v, p, 3);
          const Vec3d wp = mm::transformPoint(bake, Vec3d{p[0], p[1], p[2]});
          for (int c = 0; c < 3; ++c) mv.position[c] = static_cast<float>(wp[static_cast<std::size_t>(c)]);
          if (nor != nullptr && v < nor->count) {
            cgltf_float n[3] = {0, 1, 0};
            cgltf_accessor_read_float(nor, v, n, 3);
            const Vec3d wn = mm::normalize(mm::transformDirection(normals, Vec3d{n[0], n[1], n[2]}));
            for (int c = 0; c < 3; ++c) mv.normal[c] = snorm8(wn[static_cast<std::size_t>(c)]);
          }
          mv.normal[3] = unlit ? 127 : 0;
          if (uv != nullptr && v < uv->count) {
            cgltf_float t[2] = {0, 0};
            cgltf_accessor_read_float(uv, v, t, 2);
            mv.uv[0] = t[0];
            mv.uv[1] = t[1];
          }
          double vc[4] = {1, 1, 1, 1};
          if (col != nullptr && v < col->count) {
            cgltf_float c4[4] = {1, 1, 1, 1};
            cgltf_accessor_read_float(col, v, c4, cgltf_num_components(col->type));
            for (int c = 0; c < 4; ++c) vc[c] = c4[c];
          }
          for (int c = 0; c < 3; ++c) mv.color[c] = unorm8(mm::linearToSrgb(factor[c] * vc[c]));
          mv.color[3] = unorm8(factor[3] * vc[3]);
          if (skinned) {
            skinVertex(mv, jnt, wgt, v, skinBase, skinJoints);
          } else {
            mv.joints[0] = slot;
            mv.weights[0] = 255;
          }
          mesh_->vertices.push_back(mv);
        }
        std::vector<std::uint32_t> tris = triangleIndices(prim, count);
        if (nor == nullptr) smoothNormals(base, count, tris);
        auto& list = parts[key];
        if (list.empty()) partOrder.push_back(key);
        for (const std::uint32_t t : tris) list.push_back(base + t);
      }
    }
    for (const PartKey& key : partOrder) {
      const std::vector<std::uint32_t>& list = parts[key];
      ModelPart part;
      part.firstIndex = static_cast<std::uint32_t>(mesh_->indices.size());
      part.indexCount = static_cast<std::uint32_t>(list.size());
      part.texture = key.texture;
      part.alpha = key.alpha;
      part.alphaCutoff = key.cutoff;
      mesh_->indices.insert(mesh_->indices.end(), list.begin(), list.end());
      mesh_->parts.push_back(part);
    }
  }

  static void skinVertex(ModelVertex& mv, const cgltf_accessor* jnt, const cgltf_accessor* wgt, std::size_t v, std::uint32_t skinBase,
                         cgltf_size skinJoints) {
    cgltf_uint j[4] = {0, 0, 0, 0};
    cgltf_float w[4] = {0, 0, 0, 0};
    if (jnt != nullptr && v < jnt->count) cgltf_accessor_read_uint(jnt, v, j, 4);
    if (wgt != nullptr && v < wgt->count) cgltf_accessor_read_float(wgt, v, w, 4);
    double sum = 0;
    for (int k = 0; k < 4; ++k) {
      if (j[k] >= skinJoints || !(w[k] > 0)) w[k] = 0;
      sum += w[k];
    }
    if (!(sum > 0)) {
      mv.joints[0] = 0;
      mv.weights[0] = 255;
      return;
    }
    int q[4];
    int total = 0, largest = 0;
    for (int k = 0; k < 4; ++k) {
      q[k] = static_cast<int>(std::lround(w[k] / sum * 255.0));
      total += q[k];
      if (w[k] > w[largest]) largest = k;
    }
    q[largest] += 255 - total;
    for (int k = 0; k < 4; ++k) {
      mv.joints[k] = w[k] > 0 ? static_cast<std::uint8_t>(skinBase + j[k]) : 0;
      mv.weights[k] = static_cast<std::uint8_t>(std::clamp(q[k], 0, 255));
    }
  }

  void smoothNormals(std::uint32_t base, std::size_t count, const std::vector<std::uint32_t>& tris) {
    std::vector<Vec3d> acc(count, Vec3d{0, 0, 0});
    const auto at = [&](std::uint32_t i) {
      const ModelVertex& v = mesh_->vertices[base + i];
      return Vec3d{v.position[0], v.position[1], v.position[2]};
    };
    for (std::size_t t = 0; t + 2 < tris.size(); t += 3) {
      const Vec3d a = at(tris[t]), b = at(tris[t + 1]), c = at(tris[t + 2]);
      const Vec3d e1{b[0] - a[0], b[1] - a[1], b[2] - a[2]}, e2{c[0] - a[0], c[1] - a[1], c[2] - a[2]};
      const Vec3d n{e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]};
      for (int k = 0; k < 3; ++k) {
        Vec3d& s = acc[tris[t + static_cast<std::size_t>(k)]];
        for (std::size_t c2 = 0; c2 < 3; ++c2) s[c2] += n[c2];
      }
    }
    for (std::size_t i = 0; i < count; ++i) {
      const Vec3d n = mm::normalize(acc[i]);
      ModelVertex& v = mesh_->vertices[base + i];
      for (int c = 0; c < 3; ++c) v.normal[c] = snorm8(n[static_cast<std::size_t>(c)]);
    }
  }

  void buildClips() {
    for (cgltf_size a = 0; a < data_->animations_count; ++a) {
      const cgltf_animation& anim = data_->animations[a];
      ModelClip clip;
      // three.js GLTFLoader: unnamed animations are called `animation_<index>`.
      clip.name = anim.name != nullptr ? anim.name : "animation_" + std::to_string(a);
      for (cgltf_size c = 0; c < anim.channels_count; ++c) {
        const cgltf_animation_channel& ch = anim.channels[c];
        const auto it = index_.find(ch.target_node);
        if (it == index_.end() || ch.sampler == nullptr || ch.sampler->input == nullptr || ch.sampler->output == nullptr) continue;
        ModelChannel out;
        out.node = it->second;
        if (ch.target_path == cgltf_animation_path_type_translation) {
          out.path = ChannelPath::Translation;
        } else if (ch.target_path == cgltf_animation_path_type_rotation) {
          out.path = ChannelPath::Rotation;
        } else if (ch.target_path == cgltf_animation_path_type_scale) {
          out.path = ChannelPath::Scale;
        } else {
          continue;  // morph target weights are not supported
        }
        const cgltf_animation_sampler& s = *ch.sampler;
        out.interpolation = s.interpolation == cgltf_interpolation_type_step           ? ChannelInterpolation::Step
                            : s.interpolation == cgltf_interpolation_type_cubic_spline ? ChannelInterpolation::CubicSpline
                                                                                       : ChannelInterpolation::Linear;
        const std::size_t keys = s.input->count;
        const std::size_t comps = out.path == ChannelPath::Rotation ? 4 : 3;
        const std::size_t perKey = out.interpolation == ChannelInterpolation::CubicSpline ? 3 : 1;
        if (keys == 0 || s.output->count != keys * perKey || cgltf_num_components(s.output->type) != comps) continue;
        out.times.resize(keys);
        cgltf_accessor_unpack_floats(s.input, out.times.data(), keys);
        out.values.resize(s.output->count * comps);
        cgltf_accessor_unpack_floats(s.output, out.values.data(), out.values.size());
        clip.duration = std::max(clip.duration, static_cast<double>(out.times.back()));
        clip.channels.push_back(std::move(out));
      }
      clips_.push_back(std::move(clip));
    }
  }

  void warn(const std::string& message) {
    if (std::find(result_.warnings.begin(), result_.warnings.end(), message) == result_.warnings.end()) {
      result_.warnings.push_back(message);
    }
  }

  cgltf_data* data_;
  const ModelResources& resources_;
  const ImageDecoder& decode_;
  GltfLoadResult& result_;
  std::shared_ptr<ModelMesh> mesh_ = std::make_shared<ModelMesh>();
  std::vector<const cgltf_node*> order_;
  std::unordered_map<const cgltf_node*, int> index_;
  std::vector<ModelNode> nodes_;
  std::vector<char> animated_;
  std::vector<char> dynamic_;
  std::vector<ModelJoint> joints_;
  std::unordered_map<const cgltf_skin*, std::uint32_t> skinBase_;
  std::unordered_map<int, std::uint32_t> nodeSlot_;
  std::vector<Mat4> globals_;
  std::unordered_map<const cgltf_image*, int> textures_;
  std::vector<ModelClip> clips_;
};

bool usedAsBaseColour(const cgltf_data* data, const cgltf_image* image) {
  for (cgltf_size i = 0; i < data->materials_count; ++i) {
    const cgltf_texture* t = data->materials[i].pbr_metallic_roughness.base_color_texture.texture;
    if (t != nullptr && t->image == image) return true;
  }
  return false;
}

}  // namespace

bool isDataUri(std::string_view uri) { return uri.size() >= 5 && uri.compare(0, 5, "data:") == 0; }

std::optional<std::string> decodeDataUri(std::string_view uri) {
  if (!isDataUri(uri)) return std::nullopt;
  const std::size_t comma = uri.find(',');
  if (comma == std::string_view::npos) return std::nullopt;
  const std::string_view meta = uri.substr(5, comma - 5);
  const std::string_view payload = uri.substr(comma + 1);
  if (meta.size() >= 7 && meta.compare(meta.size() - 7, 7, ";base64") == 0) return base64Decode(payload);
  return percentDecode(payload);
}

std::string resolveUri(const std::string& base, const std::string& relative) {
  if (isDataUri(relative) || relative.find("://") != std::string::npos) return relative;
  const std::string b = base.substr(0, base.find_first_of("?#"));
  if (!relative.empty() && relative[0] == '/') {
    const std::size_t scheme = b.find("://");
    if (scheme == std::string::npos) return relative;
    const std::size_t host = b.find('/', scheme + 3);
    return b.substr(0, host == std::string::npos ? b.size() : host) + relative;
  }
  const std::size_t slash = b.rfind('/');
  return (slash == std::string::npos ? std::string() : b.substr(0, slash + 1)) + relative;
}

GltfLoadResult loadGltf(std::string_view bytes, const ModelResources& resources, const ImageDecoder& decodeImage, const std::string& uri) {
  GltfLoadResult result;
  cgltf_options options{};
  cgltf_data* data = nullptr;
  const cgltf_result parsed = cgltf_parse(&options, bytes.data(), bytes.size(), &data);
  if (parsed != cgltf_result_success) {
    result.error = resultText(parsed);
    return result;
  }
  struct Guard {
    cgltf_data* d;
    ~Guard() { cgltf_free(d); }
  } guard{data};

  for (cgltf_size i = 0; i < data->extensions_required_count; ++i) {
    const std::string ext = data->extensions_required[i] != nullptr ? data->extensions_required[i] : "";
    if (ext == "KHR_draco_mesh_compression") {
      result.error = "Draco-compressed geometry (KHR_draco_mesh_compression) is not supported by engine-native";
      return result;
    }
    if (ext == "EXT_meshopt_compression" || ext == "KHR_meshopt_compression") {
      result.error = "meshopt-compressed geometry (" + ext + ") is not supported by engine-native";
      return result;
    }
  }

  std::set<std::string> missing;
  for (cgltf_size i = 0; i < data->buffers_count; ++i) {
    cgltf_buffer& b = data->buffers[i];
    if (b.data != nullptr || b.uri == nullptr || isDataUri(b.uri)) continue;
    const auto it = resources.find(b.uri);
    if (it == resources.end()) {
      missing.insert(b.uri);
      continue;
    }
    if (it->second->size() < b.size) {
      result.error = std::string("buffer ") + b.uri + " is shorter than declared";
      return result;
    }
    b.data = const_cast<char*>(it->second->data());
    b.data_free_method = cgltf_data_free_method_none;
  }
  for (cgltf_size i = 0; i < data->images_count; ++i) {
    const cgltf_image& img = data->images[i];
    if (img.uri == nullptr || isDataUri(img.uri) || resources.count(img.uri) != 0 || !usedAsBaseColour(data, &img)) continue;
    missing.insert(img.uri);
  }
  if (!missing.empty()) {
    result.missing.assign(missing.begin(), missing.end());
    return result;
  }
  const cgltf_result loaded = cgltf_load_buffers(&options, data, nullptr);
  if (loaded != cgltf_result_success) {
    result.error = std::string("cannot load the glTF buffers: ") + resultText(loaded);
    return result;
  }
  if (cgltf_validate(data) != cgltf_result_success) {
    result.error = "invalid glTF (an accessor or buffer view is out of range)";
    return result;
  }
  Builder builder(data, resources, decodeImage, result);
  builder.run(uri);
  return result;
}

}  // namespace maprama
