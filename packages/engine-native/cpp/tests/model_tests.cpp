// M3b 3D models: the glTF loader (cgltf) on the example robot (glTF + GLB) and a generated skinned model, clip
// sampling and the cross-fading animator against three.js (characters.json, exported from GLTFLoader +
// AnimationMixer), engine-web's clip rules and cadence, the skinning palette, procedural meshes / rig / vehicles,
// drop item transforms, the model library's fetch flow and the game session's model frames and
// `model_load_failed` errors (emitted envelopes are validated by scripts/verify-emitted-events.mjs).
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "harness.hpp"
#include "map_harness.hpp"
#include "maprama/CharacterAnimation.hpp"
#include "maprama/GltfLoader.hpp"
#include "maprama/ModelLayer.hpp"
#include "maprama/ModelLibrary.hpp"
#include "maprama/ProceduralMeshes.hpp"
#include "maprama/Projection.hpp"

namespace {

using maprama::AnimationClips;
using maprama::AnimationName;
using maprama::LngLat;
using maprama::Mat4;
using maprama::ModelAsset;
using maprama::TravelMode;
using maprama::json::Value;
using namespace maprama::test::maptest;
namespace mm = maprama::model_math;

double num(const Value& v) { return v.asNumber(); }

std::string str(const Value* v) { return v != nullptr && v->isString() ? v->asString() : std::string(); }

AnimationClips clipsFrom(const Value* object) {
  AnimationClips out;
  if (object == nullptr || !object->isObject()) return out;
  for (std::size_t i = 0; i < out.size(); ++i) {
    const Value* v = object->find(maprama::EnumNames<AnimationName>::values[i]);
    if (v != nullptr && v->isString()) out[i] = v->asString();
  }
  return out;
}

std::shared_ptr<const ModelAsset> loadUri(maprama::test::Context& ctx, const std::string& uri, const std::string& what) {
  const std::optional<std::string> bytes = maprama::decodeDataUri(uri);
  if (!ctx.check(bytes.has_value(), what + ": data URI decodes")) return nullptr;
  const maprama::GltfLoadResult r = maprama::loadGltf(*bytes, {}, nullptr, uri);
  ctx.check(r.error.empty() && r.missing.empty() && r.asset != nullptr, what + " loads: " + r.error);
  return r.asset;
}

int nodeIndex(const ModelAsset& a, const std::string& name) {
  for (std::size_t i = 0; i < a.nodes.size(); ++i) {
    if (a.nodes[i].name == name) return static_cast<int>(i);
  }
  return -1;
}

int clipIndex(const ModelAsset& a, const std::string& name) {
  for (std::size_t i = 0; i < a.clips.size(); ++i) {
    if (a.clips[i].name == name) return static_cast<int>(i);
  }
  return -1;
}

/// Node globals of a single clip at `time` (three.js `action.play(); mixer.update(time)`: LoopRepeat wrap).
std::vector<Mat4> clipGlobals(const ModelAsset& a, const maprama::ModelClip& clip, double time) {
  double t = time;
  if (clip.duration > 0 && t >= clip.duration) t -= clip.duration * std::floor(t / clip.duration);
  maprama::NodePose pose = maprama::restPose(a);
  double v[4];
  for (const maprama::ModelChannel& ch : clip.channels) {
    maprama::sampleChannel(ch, t, v);
    const auto n = static_cast<std::size_t>(ch.node);
    if (ch.path == maprama::ChannelPath::Rotation) {
      pose.rotation[n] = maprama::Quat{v[0], v[1], v[2], v[3]};
    } else if (ch.path == maprama::ChannelPath::Translation) {
      pose.translation[n] = maprama::Vec3d{v[0], v[1], v[2]};
    } else {
      pose.scale[n] = maprama::Vec3d{v[0], v[1], v[2]};
    }
  }
  return maprama::globalTransforms(a.nodes, maprama::poseLocals(a, pose));
}

double maxDiff(const Mat4& m, const Value& expected) {
  double d = 0;
  for (std::size_t i = 0; i < 16; ++i) d = std::max(d, std::fabs(m[i] - expected.items()[i].asNumber()));
  return d;
}

std::string base64(const std::string& bytes) {
  static const char* kAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  std::size_t i = 0;
  for (; i + 2 < bytes.size(); i += 3) {
    const unsigned v = (static_cast<unsigned char>(bytes[i]) << 16) | (static_cast<unsigned char>(bytes[i + 1]) << 8) | static_cast<unsigned char>(bytes[i + 2]);
    out += {kAlphabet[(v >> 18) & 63], kAlphabet[(v >> 12) & 63], kAlphabet[(v >> 6) & 63], kAlphabet[v & 63]};
  }
  if (i + 1 == bytes.size()) {
    const unsigned v = static_cast<unsigned char>(bytes[i]) << 16;
    out += {kAlphabet[(v >> 18) & 63], kAlphabet[(v >> 12) & 63], '=', '='};
  } else if (i + 2 == bytes.size()) {
    const unsigned v = (static_cast<unsigned char>(bytes[i]) << 16) | (static_cast<unsigned char>(bytes[i + 1]) << 8);
    out += {kAlphabet[(v >> 18) & 63], kAlphabet[(v >> 12) & 63], kAlphabet[(v >> 6) & 63], '='};
  }
  return out;
}

std::string floats(std::initializer_list<float> values) {
  std::string out;
  for (const float f : values) out.append(reinterpret_cast<const char*>(&f), sizeof f);
  return out;
}

/// A glTF with `count` animated mesh nodes (each needs a palette entry).
std::string manyNodesGltf(int count) {
  const std::string bin = floats({0, 0, 0, 1, 0, 0, 0, 1, 0}) + floats({0, 1}) + floats({0, 0, 0, 1, 0, 0});
  std::string nodes, children, channels, samplers;
  for (int i = 0; i < count; ++i) {
    nodes += std::string(i ? "," : "") + "{\"mesh\":0}";
    children += std::string(i ? "," : "") + std::to_string(i);
    channels += std::string(i ? "," : "") + "{\"sampler\":0,\"target\":{\"node\":" + std::to_string(i) + ",\"path\":\"translation\"}}";
  }
  return "{\"asset\":{\"version\":\"2.0\"},\"scene\":0,\"scenes\":[{\"nodes\":[" + children + "]}],\"nodes\":[" + nodes +
         "],\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0}}]}],"
         "\"accessors\":[{\"bufferView\":0,\"componentType\":5126,\"count\":3,\"type\":\"VEC3\",\"min\":[0,0,0],\"max\":[1,1,0]},"
         "{\"bufferView\":1,\"componentType\":5126,\"count\":2,\"type\":\"SCALAR\",\"min\":[0],\"max\":[1]},"
         "{\"bufferView\":2,\"componentType\":5126,\"count\":2,\"type\":\"VEC3\"}],"
         "\"bufferViews\":[{\"buffer\":0,\"byteOffset\":0,\"byteLength\":36},{\"buffer\":0,\"byteOffset\":36,\"byteLength\":8},"
         "{\"buffer\":0,\"byteOffset\":44,\"byteLength\":24}],"
         "\"buffers\":[{\"byteLength\":68,\"uri\":\"data:application/octet-stream;base64," +
         base64(bin) + "\"}],\"animations\":[{\"samplers\":[{\"input\":1,\"output\":2}],\"channels\":[" + channels + "]}]}";
}

struct RecordingListener final : maprama::ModelLibrary::Listener {
  void modelReady(const std::string& uri, const std::shared_ptr<const ModelAsset>& asset) override { ready.emplace_back(uri, asset); }
  void modelFailed(const std::string& uri, const std::string& message) override { failed.emplace_back(uri, message); }
  void modelWarning(const std::string& uri, const std::string& message) override { warnings.emplace_back(uri, message); }
  std::vector<std::pair<std::string, std::shared_ptr<const ModelAsset>>> ready;
  std::vector<std::pair<std::string, std::string>> failed;
  std::vector<std::pair<std::string, std::string>> warnings;
};

Value lastVisual(const Harness& h, maprama::ModelVisual::Kind kind, const std::string& id) {
  const Value collection = h.adapter->modelCollection(kind);
  if (!collection.isObject()) return Value();
  for (const Value& f : collection.find("features")->items()) {
    if (str(f.find("properties")->find("id")) == id) return *f.find("properties");
  }
  return Value();
}

Value characterLayerFeature(const Harness& h, const std::string& id) {
  const Value collection = h.adapter->modelCollection(maprama::ModelVisual::Kind::Character);
  for (const Value& f : collection.find("features")->items()) {
    if (str(f.find("properties")->find("id")) == id) return f;
  }
  return Value();
}

LngLat pointOf(const Value& feature) {
  const Value& c = *feature.find("geometry")->find("coordinates");
  return LngLat{c.items()[0].asNumber(), c.items()[1].asNumber()};
}

std::size_t countErrors(const Harness& h, const std::string& code) {
  std::size_t n = 0;
  for (const Value& e : h.sink->eventsOfType("error")) n += str(e.find("code")) == code ? 1 : 0;
  return n;
}

}  // namespace

MAPRAMA_TEST(m3b_character_animation_rules_match_engine_web) {
  const Value fx = loadFixture(ctx, "characters.json");
  std::size_t checked = 0;
  for (const Value& c : fx.find("resolveClips")->items()) {
    std::vector<std::string> names;
    for (const Value& n : c.find("names")->items()) names.push_back(n.asString());
    const AnimationClips got = maprama::resolveClips(names, clipsFrom(c.find("mapping")));
    ctx.check(got == clipsFrom(c.find("clips")), "resolveClips " + maprama::json::stringify(c));
    ++checked;
  }
  for (const Value& c : fx.find("chooseAnimation")->items()) {
    AnimationClips available;
    for (const Value& n : c.find("available")->items()) available[static_cast<std::size_t>(*maprama::parseEnum<AnimationName>(n.asString()))] = n.asString();
    const std::optional<AnimationName> got = maprama::chooseAnimation(*maprama::parseEnum<TravelMode>(c.find("mode")->asString()),
                                                                      num(*c.find("speed")), available, num(*c.find("scale")));
    const Value* want = c.find("result");
    ctx.check(want->isNull() ? !got.has_value() : (got && maprama::enumName(*got) == want->asString()), "chooseAnimation " + maprama::json::stringify(c));
    ++checked;
  }
  for (const Value& c : fx.find("cadence")->items()) {
    const double cadence = maprama::walkCadence(num(*c.find("speed")), num(*c.find("scale")));
    ctx.check(cadence == num(*c.find("cadence")), "walkCadence " + maprama::json::stringify(c));
    ctx.check(maprama::clipTimeScale(AnimationName::Walk, cadence) == num(*c.find("walk")) &&
                  maprama::clipTimeScale(AnimationName::Run, cadence) == num(*c.find("run")),
              "clipTimeScale " + maprama::json::stringify(c));
    ++checked;
  }
  for (const Value& c : fx.find("heading")->items()) {
    ctx.near(maprama::headingFromYaw(num(*c.find("yaw"))), num(*c.find("heading")), 1e-9, "headingFromYaw");
    ++checked;
  }
  ctx.check(num(*fx.find("constants")->find("CHARACTER_HEIGHT")) == maprama::kCharacterHeight &&
                num(*fx.find("constants")->find("WALK_CADENCE_SPEED")) == maprama::kWalkCadenceSpeed &&
                num(*fx.find("constants")->find("MIN_CADENCE")) == maprama::kMinCadence,
            "engine-web constants");
  std::cout << "    " << checked << " clip-rule / cadence cases\n";
}

MAPRAMA_TEST(m3b_gltf_loader_sample_robot_matches_three) {
  const Value fx = loadFixture(ctx, "characters.json");
  const Value& robot = *fx.find("robot");
  const auto asset = loadUri(ctx, robot.find("uri")->asString(), "example robot (glTF + data: buffer)");
  if (!asset) return;
  // 7 mesh nodes, all under animated nodes (rigid node animation): identity + 7 palette entries, 7 boxes.
  ctx.check(asset->joints.size() == 8 && asset->mesh->joints == 8 && asset->triangles == 7 * 12 && asset->skins == 0,
            "robot: 8 palette entries (identity + 7 rigid nodes), 84 triangles, no skin (got " + std::to_string(asset->joints.size()) +
                ", " + std::to_string(asset->triangles) + ")");
  ctx.check(asset->mesh->parts.size() == 1 && asset->mesh->textures.empty(), "robot: one untextured opaque part");
  const auto& clips = robot.find("clips")->items();
  ctx.check(asset->clips.size() == clips.size(), "clip count");
  for (const Value& c : clips) {
    const int i = clipIndex(*asset, c.find("name")->asString());
    ctx.check(i >= 0 && asset->clips[static_cast<std::size_t>(i)].duration == num(*c.find("duration")) &&
                  asset->clips[static_cast<std::size_t>(i)].channels.size() == static_cast<std::size_t>(num(*c.find("tracks"))),
              "clip " + c.find("name")->asString() + " duration and channels");
  }
  const Value& bounds = *robot.find("bounds");
  for (std::size_t k = 0; k < 3; ++k) {
    ctx.near(asset->boundsMin[k], bounds.find("min")->items()[k].asNumber(), 1e-6, "rest bounds min (three.js Box3)");
    ctx.near(asset->boundsMax[k], bounds.find("max")->items()[k].asNumber(), 1e-6, "rest bounds max (three.js Box3)");
  }
  // The base colour factor is linear: the vertex colour is its sRGB encoding (three.js output colour space).
  const maprama::ModelVertex& v0 = asset->mesh->vertices.front();
  ctx.check(v0.color[0] == 255 && std::abs(v0.color[1] - 173) <= 1 && std::abs(v0.color[2] - 63) <= 1, "torso colour (1, 0.42, 0.05) linear -> sRGB");
  // Normalization to CHARACTER_HEIGHT (engine-web normalizeModel): 1.6 m tall -> scale 1.9 / 1.6, feet at 0.
  const Mat4 n = maprama::normalizeTransform(asset->boundsMin, asset->boundsMax, maprama::kCharacterHeight, false);
  ctx.near(n[0], 1.9 / 1.6, 1e-7, "normalize scale (float bounds)");
  ctx.near(mm::transformPoint(n, asset->boundsMax)[1], 1.9, 1e-12, "normalized top at 1.9");
  ctx.near(mm::transformPoint(n, asset->boundsMin)[1], 0.0, 1e-12, "normalized feet at 0");

  double worst = 0;
  std::size_t samples = 0;
  for (const Value& s : robot.find("samples")->items()) {
    const int clip = clipIndex(*asset, s.find("clip")->asString());
    if (!ctx.check(clip >= 0, "sample clip")) continue;
    const std::vector<Mat4> globals = clipGlobals(*asset, asset->clips[static_cast<std::size_t>(clip)], num(*s.find("time")));
    for (const maprama::json::Member& m : s.find("nodes")->members()) {
      const int node = nodeIndex(*asset, m.key);
      if (!ctx.check(node >= 0, "node " + m.key)) continue;
      const double d = maxDiff(globals[static_cast<std::size_t>(node)], m.value);
      worst = std::max(worst, d);
      ctx.check(d < 1e-6, "robot " + s.find("clip")->asString() + " @" + std::to_string(num(*s.find("time"))) + " " + m.key + " matrixWorld");
      ++samples;
    }
  }
  std::cout << "    robot: " << samples << " node matrices vs three.js, max |diff| " << worst << "\n";

  // The GLB copy loads to the same mesh.
  const std::optional<std::string> glb = maprama::decodeDataUri("data:;base64," + robot.find("glb")->asString());
  const maprama::GltfLoadResult r = maprama::loadGltf(*glb, {}, nullptr, "robot.glb");
  ctx.check(r.asset && r.asset->mesh->vertices.size() == asset->mesh->vertices.size() && r.asset->mesh->indices == asset->mesh->indices &&
                r.asset->boundsMax == asset->boundsMax && r.asset->clips.size() == asset->clips.size(),
            "GLB copy: same vertices, indices, bounds and clips (" + r.error + ")");
}

MAPRAMA_TEST(m3b_model_animator_crossfade_matches_three) {
  const Value fx = loadFixture(ctx, "characters.json");
  const Value& robot = *fx.find("robot");
  const auto asset = loadUri(ctx, robot.find("uri")->asString(), "example robot");
  if (!asset) return;
  maprama::ModelAnimator animator(asset, AnimationClips{});
  const double crossFade = num(*robot.find("crossfade")->find("crossFade"));
  double worst = 0;
  std::size_t frame = 0;
  for (const Value& step : robot.find("crossfade")->find("steps")->items()) {
    animator.update(num(*step.find("dt")), TravelMode::Walk, num(*step.find("speed")), 1.0, crossFade);
    const Value* current = step.find("current");
    const std::optional<AnimationName> got = animator.current();
    ctx.check(current->isNull() ? !got : (got && maprama::enumName(*got) == current->asString()), "frame " + std::to_string(frame) + ": current clip");
    const maprama::NodePose pose = animator.pose();
    for (const maprama::json::Member& m : step.find("nodes")->members()) {
      const auto n = static_cast<std::size_t>(nodeIndex(*asset, m.key));
      const auto& t = m.value.find("t")->items();
      const auto& q = m.value.find("q")->items();
      double d = 0;
      for (std::size_t k = 0; k < 3; ++k) d = std::max(d, std::fabs(pose.translation[n][k] - t[k].asNumber()));
      double dot = 0;
      for (std::size_t k = 0; k < 4; ++k) dot += pose.rotation[n][k] * q[k].asNumber();
      d = std::max(d, 1 - std::fabs(dot));
      worst = std::max(worst, d);
      ctx.check(d < 1e-6, "frame " + std::to_string(frame) + " " + m.key + " TRS vs three.js AnimationMixer");
    }
    ++frame;
  }
  std::cout << "    " << frame << " mixer frames (idle -> walk x1.3 -> idle -> walk, 150 ms cross-fades), max |diff| " << worst << "\n";
  // The palette follows the pose: leg_l's palette entry is its node global, entry 0 the identity.
  const int leg = nodeIndex(*asset, "leg_l");
  const std::vector<Mat4> palette = animator.palette();
  const std::vector<Mat4> globals = maprama::globalTransforms(asset->nodes, maprama::poseLocals(*asset, animator.pose()));
  bool found = false;
  for (std::size_t j = 0; j < asset->joints.size(); ++j) {
    if (asset->joints[j].node == leg) found = palette[j] == globals[static_cast<std::size_t>(leg)];
  }
  ctx.check(found && palette.size() == asset->joints.size() && palette[0] == mm::identity(), "palette: entry 0 identity, rigid entries = node globals");
  // A mapping that resolves the same clips is a no-op; a different one restarts the mixer (engine-web refreshClips).
  AnimationClips mapping;
  mapping[static_cast<std::size_t>(AnimationName::Walk)] = "walk";
  animator.setMapping(mapping);
  ctx.check(animator.current().has_value(), "same clips: refreshClips keeps the mixer");
  mapping[static_cast<std::size_t>(AnimationName::Idle)] = "walk";
  animator.setMapping(mapping);
  ctx.check(!animator.current().has_value() && animator.clips()[0] == std::optional<std::string>("walk"), "new clips: mixer restarted");
}

MAPRAMA_TEST(m3b_skinning_palette_matches_three) {
  const Value fx = loadFixture(ctx, "characters.json");
  const Value& skinned = *fx.find("skinned");
  const auto asset = loadUri(ctx, skinned.find("uri")->asString(), "generated skinned bar");
  if (!asset) return;
  ctx.check(asset->skins == 1 && asset->joints.size() == 3 && asset->mesh->vertices.size() == 20 && asset->clips.size() == 1 &&
                asset->clips[0].channels.size() == 3,
            "skinned bar: one skin (identity + 2 joints), 20 vertices, one clip with 3 channels");
  bool interpolations = asset->clips.size() == 1;
  if (interpolations) {
    std::vector<maprama::ChannelInterpolation> kinds;
    for (const auto& ch : asset->clips[0].channels) kinds.push_back(ch.interpolation);
    interpolations = kinds == std::vector<maprama::ChannelInterpolation>{maprama::ChannelInterpolation::Linear, maprama::ChannelInterpolation::Step,
                                                                         maprama::ChannelInterpolation::CubicSpline};
  }
  ctx.check(interpolations, "LINEAR, STEP and CUBICSPLINE channels");
  // Weights are quantized to unorm8 summing to 255.
  bool sums = true;
  for (const auto& v : asset->mesh->vertices) sums = sums && v.weights[0] + v.weights[1] + v.weights[2] + v.weights[3] == 255;
  ctx.check(sums, "vertex weights sum to 255");
  double worstPalette = 0, worstPosition = 0;
  for (const Value& s : skinned.find("samples")->items()) {
    const std::vector<Mat4> palette = maprama::jointPalette(asset->joints, clipGlobals(*asset, asset->clips[0], num(*s.find("time"))));
    const auto& bones = s.find("bones")->items();
    for (std::size_t j = 0; j < 2; ++j) {
      for (std::size_t k = 0; k < 16; ++k) worstPalette = std::max(worstPalette, std::fabs(palette[1 + j][k] - bones[j * 16 + k].asNumber()));
    }
    const auto& positions = s.find("positions")->items();
    for (std::size_t i = 0; i < positions.size() && i < asset->mesh->vertices.size(); ++i) {
      const maprama::Vec3d p = maprama::skinPosition(asset->mesh->vertices[i], palette);
      for (std::size_t k = 0; k < 3; ++k) worstPosition = std::max(worstPosition, std::fabs(p[k] - positions[i].items()[k].asNumber()));
    }
  }
  ctx.check(worstPalette < 1e-5, "joint palette = three.js skeleton.boneMatrices (max |diff| " + std::to_string(worstPalette) + ")");
  // Differences come from the unorm8 weight quantization (≤ 0.5/255 per weight).
  ctx.check(worstPosition < 5e-3, "skinned positions = three.js SkinnedMesh (max |diff| " + std::to_string(worstPosition) + ")");
  std::cout << "    skinned: palette max |diff| " << worstPalette << ", positions max |diff| " << worstPosition << "\n";
}

MAPRAMA_TEST(m3b_gltf_loader_failures_and_resources) {
  const Value fx = loadFixture(ctx, "characters.json");
  const std::string draco = *maprama::decodeDataUri(fx.find("draco")->find("uri")->asString());
  const maprama::GltfLoadResult d = maprama::loadGltf(draco, {}, nullptr, "draco");
  ctx.check(!d.asset && d.error.find("KHR_draco_mesh_compression") != std::string::npos, "Draco-required model rejected: " + d.error);
  const std::string meshopt = R"({"asset":{"version":"2.0"},"extensionsUsed":["EXT_meshopt_compression"],"extensionsRequired":["EXT_meshopt_compression"]})";
  ctx.check(maprama::loadGltf(meshopt, {}, nullptr, "m").error.find("meshopt") != std::string::npos, "meshopt-required model rejected");
  const std::string invalid = maprama::loadGltf("{not json", {}, nullptr, "x").error;
  ctx.check(!invalid.empty() && !maprama::loadGltf("{\"asset\": [1, 2 not json at all, {}}", {}, nullptr, "x").error.empty(), "invalid JSON: " + invalid);
  ctx.check(!maprama::loadGltf(std::string("glTF\x02\0\0\0", 8), {}, nullptr, "x").error.empty(), "truncated GLB");
  ctx.check(maprama::loadGltf(R"({"asset":{"version":"2.0"}})", {}, nullptr, "x").error == "the model has no triangles", "no triangles");
  const maprama::GltfLoadResult many = maprama::loadGltf(manyNodesGltf(70), {}, nullptr, "many");
  ctx.check(!many.asset && many.error.find("at most 63") != std::string::npos, "more than 64 palette entries rejected: " + many.error);
  const maprama::GltfLoadResult ok = maprama::loadGltf(manyNodesGltf(63), {}, nullptr, "63");
  ctx.check(ok.asset && ok.asset->joints.size() == 64, "63 animated nodes fit (64 palette entries)");

  // External buffers are reported, then resolved from the resources.
  const Value robot = maprama::json::parse(*maprama::decodeDataUri(fx.find("robot")->find("uri")->asString())).value;
  Value external = robot;
  Value buffers = *external.find("buffers");
  const std::string bin = *maprama::decodeDataUri(buffers.items()[0].find("uri")->asString());
  Value buffer = buffers.items()[0];
  buffer.set("uri", "robot%20data.bin");
  external.set("buffers", Value::array({buffer}));
  const std::string text = maprama::json::stringify(external);
  const maprama::GltfLoadResult first = maprama::loadGltf(text, {}, nullptr, "https://x.test/m/robot.gltf");
  ctx.check(!first.asset && first.error.empty() && first.missing == std::vector<std::string>{"robot%20data.bin"}, "external buffer reported missing");
  maprama::ModelResources resources{{"robot%20data.bin", std::make_shared<const std::string>(bin)}};
  const maprama::GltfLoadResult second = maprama::loadGltf(text, resources, nullptr, "https://x.test/m/robot.gltf");
  ctx.check(second.asset && second.asset->triangles == 84, "loaded with the fetched buffer");
  resources["robot%20data.bin"] = std::make_shared<const std::string>(bin.substr(0, 10));
  ctx.check(maprama::loadGltf(text, resources, nullptr, "x").error.find("shorter") != std::string::npos, "short buffer rejected");

  ctx.check(maprama::resolveUri("https://x.test/a/b/model.gltf?v=2", "tex/c.png") == "https://x.test/a/b/tex/c.png" &&
                maprama::resolveUri("https://x.test/a/model.gltf", "/root.bin") == "https://x.test/root.bin" &&
                maprama::resolveUri("https://x.test/a/model.gltf", "https://cdn.test/y.bin") == "https://cdn.test/y.bin" &&
                maprama::resolveUri("file:///models/m.glb", "m.bin") == "file:///models/m.bin",
            "resolveUri");
  ctx.check(maprama::decodeDataUri("data:text/plain,a%20b") == std::optional<std::string>("a b") &&
                maprama::decodeDataUri("data:;base64,aGk=") == std::optional<std::string>("hi") && !maprama::decodeDataUri("data:nocomma") &&
                !maprama::decodeDataUri("data:;base64,a*b"),
            "decodeDataUri");

  // Textures go through the platform decoder (a 1x1 image referenced by a data: URI).
  Value textured = maprama::json::parse(R"({"asset":{"version":"2.0"}})").value;
  textured = robot;
  Value materials = *textured.find("materials");
  Value m0 = materials.items()[0];
  Value pbr = *m0.find("pbrMetallicRoughness");
  pbr.set("baseColorTexture", Value::object({{"index", 0}}));
  m0.set("pbrMetallicRoughness", pbr);
  std::vector<Value> mats = materials.items();
  mats[0] = m0;
  Value matArray = Value::array();
  for (Value& m : mats) matArray.push(std::move(m));
  textured.set("materials", std::move(matArray));
  textured.set("textures", Value::array({Value::object({{"source", 0}})}));
  textured.set("images", Value::array({Value::object({{"uri", "data:image/png;base64,iVBORw0KGgo="}})}));
  int decoded = 0;
  const maprama::ImageDecoder decoder = [&](const std::uint8_t* data, std::size_t size, maprama::ModelTexture& out) {
    ++decoded;
    if (size < 4 || data[1] != 'P') return false;
    out.width = 1;
    out.height = 1;
    out.rgba = {10, 20, 30, 255};
    return true;
  };
  const maprama::GltfLoadResult tex = maprama::loadGltf(maprama::json::stringify(textured), {}, decoder, "tex");
  ctx.check(tex.asset && decoded == 1 && tex.asset->mesh->textures.size() == 1 && tex.asset->mesh->parts.size() == 2 &&
                tex.asset->mesh->parts[0].texture == 0,
            "base colour texture decoded once, its part references it");
  const maprama::GltfLoadResult noDecoder = maprama::loadGltf(maprama::json::stringify(textured), {}, nullptr, "tex");
  ctx.check(noDecoder.asset && noDecoder.asset->mesh->textures.empty() && !noDecoder.warnings.empty(), "no decoder: texture skipped with a warning");
}

MAPRAMA_TEST(m3b_model_library_fetch_flow) {
  const Value fx = loadFixture(ctx, "characters.json");
  const Value robot = maprama::json::parse(*maprama::decodeDataUri(fx.find("robot")->find("uri")->asString())).value;
  Value external = robot;
  Value buffer = external.find("buffers")->items()[0];
  const std::string bin = *maprama::decodeDataUri(buffer.find("uri")->asString());
  buffer.set("uri", "robot.bin");
  external.set("buffers", Value::array({buffer}));

  RecordingListener listener;
  FakeAdapter adapter;
  maprama::ModelLibrary library(listener);
  library.request("https://x.test/m/robot.gltf");
  ctx.check(library.state("https://x.test/m/robot.gltf") == maprama::ModelLibrary::State::Loading && adapter.binaryFetches.empty(),
            "no adapter yet: the fetch waits");
  library.attachAdapter(&adapter);
  ctx.check(adapter.binaryFetches.size() == 1 && adapter.binaryFetches[0].second == "https://x.test/m/robot.gltf", "fetch starts on attach");
  library.request("https://x.test/m/robot.gltf");
  ctx.check(adapter.binaryFetches.size() == 1, "a loading URI is not fetched twice");
  library.onBinaryFetched(adapter.binaryFetches[0].first, true, maprama::json::stringify(external));
  ctx.check(adapter.binaryFetches.size() == 2 && adapter.binaryFetches[1].second == "https://x.test/m/robot.bin", "external buffer fetched");
  library.onBinaryFetched(adapter.binaryFetches[1].first, true, bin);
  ctx.check(listener.ready.size() == 1 && listener.ready[0].second && listener.ready[0].second->triangles == 84 &&
                library.state("https://x.test/m/robot.gltf") == maprama::ModelLibrary::State::Ready,
            "ready after the buffer arrived");
  library.request("https://x.test/m/robot.gltf");
  ctx.check(adapter.binaryFetches.size() == 2, "a loaded URI is cached");

  library.request("https://x.test/missing.glb");
  library.onBinaryFetched(adapter.binaryFetches.back().first, false, "HTTP 404 while loading https://x.test/missing.glb");
  ctx.check(listener.failed.size() == 1 && listener.failed[0].second == "HTTP 404 while loading https://x.test/missing.glb" &&
                library.state("https://x.test/missing.glb") == maprama::ModelLibrary::State::Failed,
            "fetch failure reported with the platform message");
  library.request("https://x.test/missing.glb");
  ctx.check(adapter.binaryFetches.size() == 4, "a failed URI is loaded again on the next request (engine-web gltfCache)");
  library.onBinaryFetched(adapter.binaryFetches.back().first, true, "not a model");
  ctx.check(listener.failed.size() == 2 && !listener.failed[1].second.empty(), "parse failure reported: " + (listener.failed.size() == 2 ? listener.failed[1].second : std::string()));
  library.onBinaryFetched(999, true, "stale");
  ctx.check(listener.failed.size() == 2 && listener.ready.size() == 1, "unknown tokens are ignored");

  // A data: URI model referencing an external file cannot resolve it.
  library.request("data:model/gltf+json;base64," + base64(maprama::json::stringify(external)));
  ctx.check(listener.failed.size() == 3 && listener.failed[2].second.find("robot.bin") != std::string::npos, "data: URI with an external buffer fails");
}

MAPRAMA_TEST(m3b_procedural_meshes_rig_and_vehicles) {
  namespace pr = maprama::procedural_rig;
  const auto body = maprama::proceduralCharacterMesh(0x3F63D6, true);
  const auto npc = maprama::proceduralCharacterMesh(0x4E9C84, false);
  ctx.check(body == maprama::proceduralCharacterMesh(0x3F63D6, true) && body != npc, "procedural bodies cached per colour and player");
  ctx.check(body->joints == pr::kJoints && body->vertices.size() > 1000 && body->parts.size() == 1, "body: 9 rig joints, one opaque part");
  double lo = 1e9, hi = -1e9;
  for (const auto& v : npc->vertices) {
    // Rest palette: rig joints at their rest offsets.
    lo = std::min(lo, static_cast<double>(v.position[1]));
    hi = std::max(hi, static_cast<double>(v.position[1]));
  }
  maprama::ProceduralRigState rig;
  const std::vector<Mat4> rest = maprama::proceduralRigPalette(rig);
  double top = -1e9, bottom = 1e9;
  for (const auto& v : npc->vertices) {
    const maprama::Vec3d p = maprama::skinPosition(v, rest);
    top = std::max(top, p[1]);
    bottom = std::min(bottom, p[1]);
  }
  ctx.check(top > 1.88 && top < 1.97 && bottom > -0.05 && bottom < 0.02, "procedural body ≈ CHARACTER_HEIGHT tall, feet at 0 (top " + std::to_string(top) + ")");
  ctx.near(rest[pr::kHipL][12], -0.1, 1e-12, "left hip at x -0.1");
  ctx.near(rest[pr::kKneeL][13], 0.46, 1e-12, "knee 0.44 below the hip (0.9)");
  int eyes = 0;
  for (const auto& v : npc->vertices) eyes += v.normal[3] == 127 ? 1 : 0;
  ctx.check(eyes > 0, "eyes are unlit (MeshBasicMaterial)");

  // Walking: the phase advances by dt · k · WALK_CADENCE_SPEED · (2.3 − run · 0.5) (engine-web animate).
  maprama::animateProceduralRig(rig, 0.1, 1.0, TravelMode::Walk, 3.2, 1.0, false);
  ctx.near(rig.phase, 0.1 * 1.0 * 3.2 * 2.3, 1e-12, "walk phase");
  ctx.near(rig.hip[0], std::sin(rig.phase) * 0.5, 1e-12, "hip swing sin(phase) · 0.5");
  maprama::animateProceduralRig(rig, 0.1, 1.0, TravelMode::Walk, 0.0, 1.0, false);
  ctx.near(rig.rigScaleY, 1 + std::sin(1.0 * 2.4 + rig.phase) * 0.01, 1e-12, "idle breathing");
  maprama::animateProceduralRig(rig, 0.1, 1.0, TravelMode::Bike, 2.0, 1.0, true);
  ctx.near(rig.rigRotX, 0.32, 1e-12, "on the bike: leaning rig");
  ctx.near(rig.crank, rig.phase, 1e-12, "crank follows the pedalling phase");

  const std::array<std::pair<TravelMode, std::uint32_t>, 4> vehicles{
      {{TravelMode::Bike, 4}, {TravelMode::Car, 6}, {TravelMode::Plane, 2}, {TravelMode::Subway, 1}}};
  for (const auto& [mode, joints] : vehicles) {
    const auto mesh = maprama::vehicleMesh(mode);
    ctx.check(mesh && mesh->joints == joints && !mesh->indices.empty(), std::string("vehicle mesh ") + std::string(maprama::enumName(mode)));
  }
  ctx.check(!maprama::vehicleMesh(TravelMode::Walk), "no vehicle for walking");
  ctx.check(maprama::vehicleMesh(TravelMode::Subway)->parts[0].translucent(), "ghost train is translucent");

  // Character model: the car pops in over 0.35 s and hides the body past p = 0.55 (engine-web hideBody).
  maprama::CharacterModel model;
  maprama::FollowerBody b;
  b.mode = TravelMode::Car;
  b.speed = 2;
  model.step(0.1, 0, b, 1);
  ctx.check(model.vehicles().built && model.vehicles().vehicles[1].visible && !model.bodyHidden(), "car switched in, body still visible");
  for (int i = 0; i < 3; ++i) model.step(0.1, 0.1 * i, b, 1);
  ctx.check(model.bodyHidden() && model.vehicles().vehicles[1].p == 1.0, "car fully in: body hidden");
  ctx.near(maprama::vehicleScale(model.vehicles(), TravelMode::Car), 1.25, 1e-12, "car base scale 1.25");
  b.mode = TravelMode::Walk;
  b.speed = 0;
  for (int i = 0; i < 4; ++i) model.step(0.1, 0.1 * i, b, 1);
  ctx.check(!model.vehicles().vehicles[1].visible && !model.bodyHidden(), "back to walking: the car pops out");

  const auto coin = maprama::dropMesh(maprama::DropType::Coin, maprama::Rarity::Common, false);
  ctx.check(coin == maprama::dropMesh(maprama::DropType::Coin, maprama::Rarity::Rare, false), "coins are one mesh (gold)");
  ctx.check(maprama::dropMesh(maprama::DropType::Coin, maprama::Rarity::Common, true) != coin, "gem for value ≥ 50");
  for (const auto type : {maprama::DropType::Cd, maprama::DropType::Vinyl, maprama::DropType::Note}) {
    ctx.check(maprama::dropMesh(type, maprama::Rarity::Rare, false) != maprama::dropMesh(type, maprama::Rarity::Legendary, false),
              std::string("per-rarity ") + std::string(maprama::enumName(type)) + " mesh");
  }
  ctx.check(maprama::dropBeamMesh()->parts[0].additive && maprama::dropRingMesh()->parts[0].additive, "beam and ring are additive");
  ctx.check(maprama::offsetHslHex(0x3F63D6, 0, 0, -0.1) != 0x3F63D6 && maprama::mixHex(0x000000, 0xFFFFFF, 0.5) == 0x808080, "colour helpers");
}

MAPRAMA_TEST(m3b_drop_item_transforms_and_frames) {
  const maprama::Projection proj = *maprama::Projection::create({LngLat{127.05, 37.54}, 8.0}).value;
  maprama::ModelFrameBuilder b(proj, LngLat{127.05, 37.54}, 8.0);
  const Mat4 origin = b.placement(0, 0, 0);
  ctx.check(std::fabs(origin[12]) < 1e-9 && std::fabs(origin[13]) < 1e-9 && origin[14] == 0, "the world origin is the local origin");
  ctx.near(b.horizontalScale(), 8.0, 0.01, "≈ 8 local units (meters) per world unit east");
  const Mat4 p = b.placement(10, 2, -5);
  const LngLat ll = proj.toLngLat(maprama::WorldPoint{10, -5});
  const auto m = maprama::lngLatToMercator(ll), o = maprama::lngLatToMercator(LngLat{127.05, 37.54});
  const double upm = 2 * mm::kPi * 6378137.0 * std::cos(37.54 * mm::kPi / 180);
  ctx.near(p[12], (m[0] - o[0]) * upm, 1e-6, "placement x = mercator local units (as the building layer)");
  ctx.near(p[13], (m[1] - o[1]) * upm, 1e-6, "placement y (south)");
  ctx.near(p[14], 16.0, 1e-12, "placement z = y · unitMeters (meters)");
  // Axis swap: world +y (up) → local +z, world +z (south) → local +y.
  ctx.check(p[6] == 8.0 && p[9] == b.horizontalScale() && p[5] == 0, "world up -> local z, world south -> local y");

  maprama::BuildingLayerData data;
  data.originX = 0.8;
  data.originY = 0.3;
  data.unitsPerMercator = 31000000;
  std::array<double, 16> projection{};
  for (std::size_t i = 0; i < 16; ++i) projection[i] = 0.1 * static_cast<double>(i) - 0.7;
  ctx.check(maprama::modelLayerMatrix(projection, 16.3, 0.8, 0.3, 31000000) == maprama::buildingLayerMatrix(projection, 16.3, data),
            "model layer MVP = building layer MVP");

  // engine-web DropVisuals.step: appear (easeOutBack 0.35 s), bob, spin 2.2 rad/s (coins), pop (0.45 s).
  maprama::DropVisual coin;
  coin.dropId = "c";
  coin.type = maprama::DropType::Coin;
  coin.addedMs = 0;
  coin.phase = 0.5;
  const double ground = 0.09;
  const Mat4 appear = maprama::dropItemTransform(b, coin, {0, 0}, ground, 100);
  // item = placement · Ry(spin) · S(scale): column 0 = (h s cos, -h s sin, 0).
  const auto scaleOf = [&](const Mat4& m) { return std::hypot(m[0], m[1]) / b.horizontalScale(); };
  const auto spinOf = [](const Mat4& m) { return std::atan2(-m[1], m[0]); };
  const double s = scaleOf(appear);
  ctx.near(s, maprama::easeOutBack(0.1 / 0.35), 1e-9, "appear scale easeOutBack(t / 0.35)");
  const Mat4 idle = maprama::dropItemTransform(b, coin, {0, 0}, ground, 1000);
  ctx.near(scaleOf(idle), 1.0, 1e-9, "scale 1 once appeared");
  ctx.near(idle[14], (ground + 0.9 + std::sin(1.0 * 3 + 0.5) * 0.12) * 8, 1e-9, "bob y = ground + 0.9 + sin(3t + phase) · 0.12");
  ctx.near(spinOf(idle), 2.2, 1e-9, "spin 2.2 rad after 1 s");
  maprama::DropVisual note = coin;
  note.type = maprama::DropType::Note;
  const Mat4 noteIdle = maprama::dropItemTransform(b, note, {0, 0}, ground, 1000);
  ctx.near(noteIdle[14], (ground + 0.95 + std::sin(1.0 * 2.4 + 0.5) * 0.1) * 8, 1e-9, "music items float higher and bob slower");
  coin.popMs = 2000;
  const Mat4 pop = maprama::dropItemTransform(b, coin, {0, 0}, ground, 2100);
  const double k = 0.1 / 0.45;
  ctx.near(scaleOf(pop), 1 + k * 1.5, 1e-9, "pop grows 1 + 1.5 k first");
  ctx.near(spinOf(pop), std::remainder(2 * 2.2 + 14 * 0.1, 2 * mm::kPi), 1e-9, "pop spins 14 rad/s");
  ctx.near(pop[14], (ground + 0.9 + std::sin(2.0 * 3 + 0.5) * 0.12 + 0.5) * 8, 1e-9, "pop rises 5 units/s from where it was");
  ctx.near(maprama::dropPopProgress(coin, 2225), 0.5, 1e-12, "pop progress");
  ctx.near(scaleOf(maprama::dropItemTransform(b, coin, {0, 0}, ground, 2400)), std::max(0.001, 1.6 * (1 - 0.4 / 0.45) / 0.6), 1e-9,
           "then shrinks 1.6 (1 - k) / 0.6");

  // Batching: three common coins share one instanced draw (identity palette); a rare coin adds its beam and ring.
  maprama::ModelFrameBuilder fb(proj, LngLat{127.05, 37.54}, 8.0);
  for (int i = 0; i < 3; ++i) maprama::drawDrop(fb, coin, {static_cast<double>(i), 0}, ground, 500);
  maprama::DropVisual rare = coin;
  rare.popMs.reset();
  rare.rarity = maprama::Rarity::Rare;
  maprama::drawDrop(fb, rare, {5, 5}, ground, 500);
  maprama::DropVisual loading = rare;
  loading.type = maprama::DropType::Model;
  loading.modelUri = "https://x.test/gem.glb";
  maprama::drawDrop(fb, loading, {6, 6}, ground, 500);
  maprama::DropVisual failed = loading;
  failed.modelFailed = true;
  failed.value = 80;
  maprama::drawDrop(fb, failed, {7, 7}, ground, 500);
  const auto frame = fb.finish(maprama::BuildingLayerLight{}, maprama::RgbTint{0.5, 0.6, 0.7}, 42);
  std::map<std::string, std::uint32_t> counts;
  for (const auto& d : frame->draws) counts[d.mesh->name] += d.instanceCount;
  ctx.check(counts["drop:coin"] == 4 && counts["drop:gem"] == 1 && counts["drop:beam"] == 3 && counts["drop:ring"] == 3 && frame->draws.size() == 4,
            "instanced draws: 4 coins, the failed model's gem, 3 beams + rings; nothing for the loading model");
  bool palettes = true;
  for (const auto& d : frame->draws) palettes = palettes && d.palette == 0;
  ctx.check(palettes && frame->palettes.size() == 16 && frame->version == 42 && frame->tint[1] == 0.6f,
            "instanced draws use the identity palette; version and tint");
  // Palettes of skinned draws start at multiples of 4 matrices (256-byte offsets).
  maprama::ModelFrameBuilder pb(proj, LngLat{127.05, 37.54}, 8.0);
  const std::uint32_t a = pb.addPalette(std::vector<Mat4>(9, mm::identity()));
  const std::uint32_t c = pb.addPalette(std::vector<Mat4>(2, mm::identity()));
  ctx.check(a == 4 && c == 16, "palette offsets aligned to 4 matrices");
}

MAPRAMA_TEST(m3b_game_session_models_and_model_load_failed) {
  Harness h;
  h.send(initMsg(dataWorld(ctx)));
  const Value fx = loadFixture(ctx, "characters.json");
  const std::string robotUri = fx.find("robot")->find("uri")->asString();
  const std::string dracoUri = fx.find("draco")->find("uri")->asString();
  const Value robotModel = Value::object({{"uri", robotUri}});
  h.send(Value::object({{"type", "upsertCharacters"},
                        {"characters", Value::array({Value::object({{"id", "robot"}, {"model", robotModel}, {"scale", 1.5}}),
                                                     Value::object({{"id", "npc"}, {"color", "#C25B70"}}),
                                                     Value::object({{"id", "me"}, {"isPlayer", true}})})}}));
  ctx.check(h.jobs.size() == 1, "one parse job for the data: URI model");
  h.run(64);
  Value robot = lastVisual(h, maprama::ModelVisual::Kind::Character, "robot");
  ctx.check(robot.isObject() && robot.find("gltf")->asBool() && str(robot.find("animation")) == "idle", "robot glTF shown, idle clip");
  ctx.check(!lastVisual(h, maprama::ModelVisual::Kind::Character, "npc").find("gltf")->asBool(), "model-less NPC: procedural body");
  const auto& frame = *h.adapter->modelFrames.back();
  std::size_t skinned = 0, procedural = 0;
  for (const auto& d : frame.draws) {
    if (d.mesh->joints == 8) ++skinned;
    if (d.mesh->joints == maprama::procedural_rig::kJoints) ++procedural;
    ctx.check(d.palette % maprama::kPaletteAlignment == 0 && (d.palette + d.mesh->joints) * 16 <= frame.palettes.size(), "palette range inside the frame");
  }
  ctx.check(skinned == 1 && procedural == 2 && frame.characters == 3, "one robot draw (8 joints) + two procedural bodies");
  ctx.check(h.sink->loggedContaining("model loaded (84 triangles, 8 palette joints, 2 clips", maprama::LogLevel::Info), "load logged");

  // The robot walks: the walk clip plays at the character's cadence.
  const LngLat at = pointOf(characterLayerFeature(h, "robot"));
  h.send(Value::object({{"type", "travel"}, {"requestId", "t"}, {"characterId", "robot"}, {"to", lngLat(at.lng + 0.0004, at.lat)},
                        {"modes", Value::array({"walk"})}, {"timeScale", 20}}));
  h.run(200);
  robot = lastVisual(h, maprama::ModelVisual::Kind::Character, "robot");
  ctx.check(str(robot.find("animation")) == "walk" || str(robot.find("animation")) == "run", "moving robot: walk (or run) clip");
  h.send(Value::object({{"type", "cancelTravel"}, {"characterId", "robot"}}));

  // Failures: a Draco model and an http 404 -> model_load_failed, the procedural body stays.
  h.send(Value::object({{"type", "upsertCharacters"},
                        {"characters", Value::array({Value::object({{"id", "draco"}, {"model", Value::object({{"uri", dracoUri}})}}),
                                                     Value::object({{"id", "remote"}, {"model", Value::object({{"uri", "https://x.test/robot.glb"}})}}),
                                                     Value::object({{"id", "gone"}, {"model", Value::object({{"uri", "https://x.test/404.glb"}})}})})}}));
  h.run(32);
  ctx.check(countErrors(h, "model_load_failed") == 1, "Draco model -> one model_load_failed");
  bool dracoMessage = false;
  for (const Value& e : h.sink->eventsOfType("error")) {
    const std::string msg = str(e.find("message"));
    dracoMessage = dracoMessage || (msg.rfind("character draco: failed to load " + dracoUri + ": Draco-compressed geometry", 0) == 0 && !e.find("fatal")->asBool());
  }
  ctx.check(dracoMessage, "engine-web message: character <id>: failed to load <uri>: <reason>");
  ctx.check(!lastVisual(h, maprama::ModelVisual::Kind::Character, "draco").find("gltf")->asBool(), "failed model: procedural body");
  ctx.check(h.adapter->binaryFetches.size() == 2, "http models fetched through the adapter");
  const std::string glb = *maprama::decodeDataUri("data:;base64," + fx.find("robot")->find("glb")->asString());
  for (const auto& [token, url] : h.adapter->binaryFetches) {
    if (url == "https://x.test/robot.glb") h.engine->onBinaryFetched(token, true, glb);
    if (url == "https://x.test/404.glb") h.engine->onBinaryFetched(token, false, "HTTP 404 while loading https://x.test/404.glb");
  }
  h.run(48);
  ctx.check(lastVisual(h, maprama::ModelVisual::Kind::Character, "remote").find("gltf")->asBool(), "fetched GLB shown");
  bool notFound = false;
  for (const Value& e : h.sink->eventsOfType("error")) {
    notFound = notFound || str(e.find("message")) == "character gone: failed to load https://x.test/404.glb: HTTP 404 while loading https://x.test/404.glb";
  }
  ctx.check(notFound && countErrors(h, "model_load_failed") == 2, "http failure -> model_load_failed with the platform message");

  // `model: null` restores the procedural body; the same failed URI again loads again (and fails again).
  h.send(Value::object({{"type", "upsertCharacters"}, {"characters", Value::array({Value::object({{"id", "robot"}, {"model", nullptr}})})}}));
  h.run(32);
  ctx.check(!lastVisual(h, maprama::ModelVisual::Kind::Character, "robot").find("gltf")->asBool(), "model: null -> procedural body");
  h.send(Value::object({{"type", "upsertCharacters"}, {"characters", Value::array({Value::object({{"id", "draco"}, {"model", Value::object({{"uri", dracoUri}})}})})}}));
  h.run(32);
  ctx.check(countErrors(h, "model_load_failed") == 3, "a failed URI is retried on the next upsert");

  // Model drops: loaded -> glTF item; failed -> coin + drop model_load_failed.
  h.send(Value::object({{"type", "setDropLayer"},
                        {"layerId", "gems"},
                        {"collectRadiusMeters", 1},
                        {"collectorIds", Value::array()},
                        {"drops", Value::array({Value::object({{"id", "g1"}, {"type", "model"}, {"model", robotModel}, {"coordinate", lngLat(at.lng + 0.001, at.lat)}}),
                                                Value::object({{"id", "g2"}, {"type", "model"}, {"model", Value::object({{"uri", dracoUri}})},
                                                               {"coordinate", lngLat(at.lng + 0.0012, at.lat)}}),
                                                Value::object({{"id", "c1"}, {"type", "cd"}, {"rarity", "legendary"}, {"coordinate", lngLat(at.lng + 0.0014, at.lat)}})})}}));
  h.run(48);
  ctx.check(lastVisual(h, maprama::ModelVisual::Kind::Drop, "g1").find("gltf")->asBool(), "model drop: cached robot shown");
  bool dropMessage = false;
  for (const Value& e : h.sink->eventsOfType("error")) dropMessage = dropMessage || str(e.find("message")).rfind("drop gems/g2: failed to load " + dracoUri, 0) == 0;
  ctx.check(dropMessage && countErrors(h, "model_load_failed") == 4, "failed model drop -> drop <layer>/<id> model_load_failed");
  std::size_t coins = 0, beams = 0;
  for (const auto& d : h.adapter->modelFrames.back()->draws) {
    if (d.mesh->name == "drop:coin") coins += d.instanceCount;
    if (d.mesh->name == "drop:beam") beams += d.instanceCount;
  }
  ctx.check(coins == 1 && beams == 3, "failed model drop shows a coin; music drops have beams");
  ctx.check(h.sink->errors() == 0, "no invalid outgoing events");
  appendEmitted(ctx, *h.sink);
}
