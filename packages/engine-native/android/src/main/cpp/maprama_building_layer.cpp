#include "maprama_building_layer.hpp"

#include <android/log.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <iterator>
#include <string>

namespace maprama::android {

namespace {

constexpr const char* kTag = "MapramaBuildingLayer";
constexpr int kStatsFrames = 240;

double nowMs() {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// Same math as the Metal shaders of the iOS layer (ios/MapramaBuildingLayer.mm): MapLibre's extrusion lighting
// (`fill_extrusion.vertex.glsl`) per fragment, engine-web's facade window layouts, lit windows at night,
// screen-space outline quads.
constexpr const char* kMeshVertex = R"GLSL(#version 300 es
precision highp float;
layout (location = 0) in vec3 a_position;
layout (location = 1) in vec4 a_normal;
layout (location = 2) in vec4 a_color;
layout (location = 3) in vec2 a_facade;
layout (location = 4) in float a_shade;
layout (location = 5) in vec2 a_cell;
layout (location = 6) in vec4 a_window;
layout (location = 7) in vec4 a_glass;
uniform mat4 u_mvp;
uniform float u_heightScale;
out vec3 v_color;
out vec3 v_normal;
out vec2 v_facade;
out float v_shade;
flat out vec2 v_cell;
flat out vec4 v_window;
flat out vec4 v_glass;
flat out int v_pattern;
void main() {
  gl_Position = u_mvp * vec4(a_position.xy, a_position.z * u_heightScale, 1.0);
  v_color = a_color.rgb;
  v_normal = a_normal.xyz;
  v_facade = a_facade;
  v_shade = a_shade;
  v_cell = a_cell;
  v_window = a_window;
  v_glass = a_glass;
  v_pattern = int(floor(a_normal.w * 127.0 + 0.5));
}
)GLSL";

constexpr const char* kMeshFragment = R"GLSL(#version 300 es
precision highp float;
uniform vec4 u_lightpos;
uniform vec4 u_lightcolor;
in vec3 v_color;
in vec3 v_normal;
in vec2 v_facade;
in float v_shade;
flat in vec2 v_cell;
flat in vec4 v_window;
flat in vec4 v_glass;
flat in int v_pattern;
out vec4 fragColor;

vec3 extrusionLight(vec3 color, vec3 n, float shade) {
  float colorvalue = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color += 0.03;
  float intensity = u_lightpos.w;
  float directional = clamp(dot(n, u_lightpos.xyz), 0.0, 1.0);
  directional = mix(1.0 - intensity, max(1.0 - colorvalue + intensity, 1.0), directional);
  directional *= shade;
  vec3 lc = u_lightcolor.rgb;
  return clamp(color * directional * lc, mix(vec3(0.0), vec3(0.3), 1.0 - lc), vec3(1.0));
}

float span(float lo, float hi, float x, float w) {
  return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 n = normalize(v_normal);
  vec3 wall = extrusionLight(v_color, n, v_shade);
  if (v_pattern < 0 || v_cell.x <= 0.0 || v_cell.y <= 0.0) {
    fragColor = vec4(wall, 1.0);
    return;
  }
  vec2 c = v_facade / v_cell;
  vec2 f = fract(c);
  vec2 w = max(fwidth(c), vec2(1e-4));
  vec4 r = v_window;
  float win;
  float coverage;
  if (v_pattern == 1) {
    win = span(r.z, r.w, f.y, w.y) * span(r.x * 0.5, 1.0 - r.x * 0.5, f.x, w.x);
    coverage = (r.w - r.z) * (1.0 - r.x);
  } else if (v_pattern == 2) {
    win = span(r.x, 1.0 + w.x, f.x, w.x) * span(r.z, 1.0 + w.y, f.y, w.y);
    coverage = (1.0 - r.x) * (1.0 - r.z);
  } else {
    win = span(r.x, r.y, f.x, w.x) * span(r.z, r.w, f.y, w.y);
    coverage = (r.y - r.x) * (r.w - r.z);
  }
  float fade = smoothstep(0.35, 0.8, max(w.x, w.y));
  win = mix(win, coverage, fade);
  vec3 glass = extrusionLight(v_glass.rgb, n, v_shade);
  float probability = v_pattern == 3 ? 0.8 : 0.4;
  float lit = step(hash21(floor(c) + v_glass.a * 37.0), probability);
  lit = mix(lit, probability, fade) * u_lightcolor.w;
  glass = mix(glass, vec3(1.0, 0.82, 0.54), clamp(lit * 0.9, 0.0, 1.0));
  fragColor = vec4(mix(wall, glass, win), 1.0);
}
)GLSL";

constexpr const char* kLineVertex = R"GLSL(#version 300 es
precision highp float;
layout (location = 0) in vec3 a_position;
layout (location = 1) in vec3 a_other;
layout (location = 2) in float a_side;
layout (location = 3) in vec4 a_color;
uniform mat4 u_mvp;
uniform vec4 u_viewport;
uniform float u_heightScale;
out vec4 v_color;
void main() {
  vec4 a = u_mvp * vec4(a_position.xy, a_position.z * u_heightScale, 1.0);
  vec4 b = u_mvp * vec4(a_other.xy, a_other.z * u_heightScale, 1.0);
  vec2 halfSize = u_viewport.xy * 0.5;
  vec2 sa = a.xy / a.w * halfSize;
  vec2 sb = b.xy / b.w * halfSize;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 offset = (vec2(-dir.y, dir.x) * a_side - dir) * u_viewport.z;
  a.xy += offset / halfSize * a.w;
  gl_Position = a;
  v_color = a_color;
}
)GLSL";

constexpr const char* kLineFragment = R"GLSL(#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }
)GLSL";

// M3b models: GPU linear-blend skinning (4 influences, palette in a std140 uniform block), per-instance model
// matrices and colours (divisor-1 attributes), the building layer's extrusion lighting in the frame's local space,
// alpha cutoff / blended / additive parts with premultiplied output. Same math as the iOS Metal shaders
// (ios/MapramaBuildingLayer.mm, kModelShaderSource).
constexpr const char* kModelVertex = R"GLSL(#version 300 es
precision highp float;
layout (location = 0) in vec3 a_position;
layout (location = 1) in vec4 a_normal;
layout (location = 2) in vec2 a_uv;
layout (location = 3) in vec4 a_color;
layout (location = 4) in uvec4 a_joints;
layout (location = 5) in vec4 a_weights;
layout (location = 6) in vec4 a_inst0;
layout (location = 7) in vec4 a_inst1;
layout (location = 8) in vec4 a_inst2;
layout (location = 9) in vec4 a_inst3;
layout (location = 10) in vec4 a_instColor;
layout (std140) uniform Palette { mat4 u_joints[64]; };
uniform mat4 u_mvp;
out vec4 v_color;
out vec3 v_normal;
out vec2 v_uv;
out float v_unlit;
void main() {
  mat4 skin = u_joints[a_joints.x] * a_weights.x + u_joints[a_joints.y] * a_weights.y +
              u_joints[a_joints.z] * a_weights.z + u_joints[a_joints.w] * a_weights.w;
  mat4 inst = mat4(a_inst0, a_inst1, a_inst2, a_inst3);
  gl_Position = u_mvp * (inst * (skin * vec4(a_position, 1.0)));
  v_normal = mat3(inst) * mat3(skin) * a_normal.xyz;
  v_color = a_color * a_instColor;
  v_uv = a_uv;
  v_unlit = a_normal.w > 0.5 ? 1.0 : 0.0;
}
)GLSL";

constexpr const char* kModelFragment = R"GLSL(#version 300 es
precision highp float;
uniform vec4 u_lightpos;
uniform vec4 u_lightcolor;
uniform vec4 u_tint;
uniform vec4 u_part;
uniform sampler2D u_texture;
in vec4 v_color;
in vec3 v_normal;
in vec2 v_uv;
in float v_unlit;
out vec4 fragColor;

vec3 extrusionLight(vec3 color, vec3 n) {
  float colorvalue = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color += 0.03;
  float intensity = u_lightpos.w;
  float directional = clamp(dot(n, u_lightpos.xyz), 0.0, 1.0);
  directional = mix(1.0 - intensity, max(1.0 - colorvalue + intensity, 1.0), directional);
  vec3 lc = u_lightcolor.rgb;
  return clamp(color * directional * lc, mix(vec3(0.0), vec3(0.3), 1.0 - lc), vec3(1.0));
}

// u_part: x = alpha cutoff (< 0: none), y = additive, z = blended.
void main() {
  vec4 base = v_color * texture(u_texture, v_uv);
  if (base.a < u_part.x) discard;
  vec3 color = base.rgb * u_tint.rgb;
  vec3 lit = v_unlit > 0.5 ? color : extrusionLight(color, normalize(v_normal));
  if (u_part.y > 0.5) {
    fragColor = vec4(lit * base.a, 0.0);
  } else if (u_part.z > 0.5) {
    fragColor = vec4(lit * base.a, base.a);
  } else {
    fragColor = vec4(lit, 1.0);
  }
}
)GLSL";

/// Meshes unused for this many drawn frames are released.
constexpr std::uint64_t kMeshKeepFrames = 600;

GLuint compile(GLenum type, const char* source) {
  GLuint shader = glCreateShader(type);
  glShaderSource(shader, 1, &source, nullptr);
  glCompileShader(shader);
  GLint ok = GL_FALSE;
  glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (ok != GL_TRUE) {
    char log[1024] = {0};
    glGetShaderInfoLog(shader, sizeof log, nullptr, log);
    __android_log_print(ANDROID_LOG_ERROR, kTag, "shader compile failed: %s", log);
    glDeleteShader(shader);
    return 0;
  }
  return shader;
}

GLuint link(const char* vs, const char* fs) {
  const GLuint v = compile(GL_VERTEX_SHADER, vs);
  const GLuint f = compile(GL_FRAGMENT_SHADER, fs);
  if (v == 0 || f == 0) {
    if (v != 0) glDeleteShader(v);
    if (f != 0) glDeleteShader(f);
    return 0;
  }
  GLuint program = glCreateProgram();
  glAttachShader(program, v);
  glAttachShader(program, f);
  glLinkProgram(program);
  glDeleteShader(v);
  glDeleteShader(f);
  GLint ok = GL_FALSE;
  glGetProgramiv(program, GL_LINK_STATUS, &ok);
  if (ok != GL_TRUE) {
    char log[1024] = {0};
    glGetProgramInfoLog(program, sizeof log, nullptr, log);
    __android_log_print(ANDROID_LOG_ERROR, kTag, "program link failed: %s", log);
    glDeleteProgram(program);
    return 0;
  }
  return program;
}

void attrib(GLuint index, GLint size, GLenum type, GLboolean normalized, GLsizei stride, std::size_t offset) {
  glEnableVertexAttribArray(index);
  glVertexAttribPointer(index, size, type, normalized, stride, reinterpret_cast<const void*>(offset));
}

void stats(std::vector<double> v, double* avg, double* p95) {
  if (v.empty()) {
    *avg = 0;
    *p95 = 0;
    return;
  }
  double sum = 0;
  for (double x : v) sum += x;
  *avg = sum / static_cast<double>(v.size());
  std::sort(v.begin(), v.end());
  *p95 = v[std::min(v.size() - 1, static_cast<std::size_t>(static_cast<double>(v.size()) * 0.95))];
}

}  // namespace

void BuildingLayerHost::initialize(const mln::style::CustomLayerInitParameters&) {
  __android_log_print(ANDROID_LOG_INFO, kTag, "building layer initialized");
}

bool BuildingLayerHost::ensurePrograms() {
  if (meshProgram_ != 0 && lineProgram_ != 0) return true;
  if (programFailed_) return false;
  meshProgram_ = link(kMeshVertex, kMeshFragment);
  lineProgram_ = link(kLineVertex, kLineFragment);
  if (meshProgram_ == 0 || lineProgram_ == 0) {
    programFailed_ = true;
    return false;
  }
  meshMvp_ = glGetUniformLocation(meshProgram_, "u_mvp");
  meshLightPos_ = glGetUniformLocation(meshProgram_, "u_lightpos");
  meshLightColor_ = glGetUniformLocation(meshProgram_, "u_lightcolor");
  lineMvp_ = glGetUniformLocation(lineProgram_, "u_mvp");
  lineViewport_ = glGetUniformLocation(lineProgram_, "u_viewport");
  meshHeightScale_ = glGetUniformLocation(meshProgram_, "u_heightScale");
  lineHeightScale_ = glGetUniformLocation(lineProgram_, "u_heightScale");
  __android_log_print(ANDROID_LOG_INFO, kTag, "programs ready (%s)", reinterpret_cast<const char*>(glGetString(GL_RENDERER)));
  return true;
}

bool BuildingLayerHost::ensureModelProgram() {
  if (modelProgram_ != 0) return true;
  if (modelProgramFailed_) return false;
  modelProgram_ = link(kModelVertex, kModelFragment);
  if (modelProgram_ == 0) {
    modelProgramFailed_ = true;
    return false;
  }
  modelMvp_ = glGetUniformLocation(modelProgram_, "u_mvp");
  modelLightPos_ = glGetUniformLocation(modelProgram_, "u_lightpos");
  modelLightColor_ = glGetUniformLocation(modelProgram_, "u_lightcolor");
  modelTint_ = glGetUniformLocation(modelProgram_, "u_tint");
  modelPart_ = glGetUniformLocation(modelProgram_, "u_part");
  modelTexture_ = glGetUniformLocation(modelProgram_, "u_texture");
  const GLuint block = glGetUniformBlockIndex(modelProgram_, "Palette");
  if (block != GL_INVALID_INDEX) glUniformBlockBinding(modelProgram_, block, 0);
  glGenBuffers(1, &paletteUbo_);
  glBindBuffer(GL_UNIFORM_BUFFER, paletteUbo_);
  glBufferData(GL_UNIFORM_BUFFER, static_cast<GLsizeiptr>(kMaxJoints * 16 * sizeof(float)), nullptr, GL_DYNAMIC_DRAW);
  glBindBuffer(GL_UNIFORM_BUFFER, 0);
  glGenBuffers(1, &instanceVbo_);
  glGenTextures(1, &whiteTexture_);
  glBindTexture(GL_TEXTURE_2D, whiteTexture_);
  const std::uint8_t white[4] = {255, 255, 255, 255};
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, white);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glBindTexture(GL_TEXTURE_2D, 0);
  __android_log_print(ANDROID_LOG_INFO, kTag, "model program ready");
  return true;
}

BuildingLayerHost::GpuModelMesh* BuildingLayerHost::gpuMesh(const ModelMesh& mesh) {
  auto it = meshes_.find(mesh.id);
  if (it == meshes_.end()) {
    if (mesh.vertices.empty() || mesh.indices.empty()) return nullptr;
    GpuModelMesh gpu;
    glGenVertexArrays(1, &gpu.vao);
    glGenBuffers(1, &gpu.vbo);
    glGenBuffers(1, &gpu.ibo);
    glBindVertexArray(gpu.vao);
    glBindBuffer(GL_ARRAY_BUFFER, gpu.vbo);
    glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(mesh.vertices.size() * sizeof(ModelVertex)), mesh.vertices.data(), GL_STATIC_DRAW);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, gpu.ibo);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, static_cast<GLsizeiptr>(mesh.indices.size() * sizeof(std::uint32_t)), mesh.indices.data(),
                 GL_STATIC_DRAW);
    constexpr GLsizei s = sizeof(ModelVertex);
    attrib(0, 3, GL_FLOAT, GL_FALSE, s, offsetof(ModelVertex, position));
    attrib(1, 4, GL_BYTE, GL_TRUE, s, offsetof(ModelVertex, normal));
    attrib(2, 2, GL_FLOAT, GL_FALSE, s, offsetof(ModelVertex, uv));
    attrib(3, 4, GL_UNSIGNED_BYTE, GL_TRUE, s, offsetof(ModelVertex, color));
    glEnableVertexAttribArray(4);
    glVertexAttribIPointer(4, 4, GL_UNSIGNED_BYTE, s, reinterpret_cast<const void*>(offsetof(ModelVertex, joints)));
    attrib(5, 4, GL_UNSIGNED_BYTE, GL_TRUE, s, offsetof(ModelVertex, weights));
    for (GLuint a = 6; a <= 10; ++a) {
      glEnableVertexAttribArray(a);
      glVertexAttribDivisor(a, 1);
    }
    glBindVertexArray(0);
    glBindBuffer(GL_ARRAY_BUFFER, 0);
    for (const ModelTexture& t : mesh.textures) {
      GLuint texture = 0;
      glGenTextures(1, &texture);
      glBindTexture(GL_TEXTURE_2D, texture);
      glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
      glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, t.width, t.height, 0, GL_RGBA, GL_UNSIGNED_BYTE, t.rgba.data());
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
      gpu.textures.push_back(texture);
    }
    glBindTexture(GL_TEXTURE_2D, 0);
    gpu.bytes = mesh.vertices.size() * sizeof(ModelVertex) + mesh.indices.size() * sizeof(std::uint32_t);
    for (const ModelTexture& t : mesh.textures) gpu.bytes += static_cast<std::size_t>(t.width) * static_cast<std::size_t>(t.height) * 4;
    modelBytes_ += gpu.bytes;
    __android_log_print(ANDROID_LOG_INFO, kTag, "model mesh %llu uploaded: %zu vertices, %zu triangles, %zu textures (%s)",
                        static_cast<unsigned long long>(mesh.id), mesh.vertices.size(), mesh.indices.size() / 3, mesh.textures.size(),
                        mesh.name.c_str());
    it = meshes_.emplace(mesh.id, std::move(gpu)).first;
  }
  it->second.lastUsed = modelFrames_;
  return &it->second;
}

void BuildingLayerHost::renderModels(const ModelLayerFrame& frame, const mln::style::CustomLayerRenderParameters& parameters) {
  if (frame.draws.empty() || frame.instances.empty() || !ensureModelProgram()) return;
  const double start = nowMs();
  ++modelFrames_;
  const std::array<float, 16> mvp =
      modelLayerMatrix(parameters.nearClippedProjectionMatrix, parameters.zoom, frame.originX, frame.originY, frame.unitsPerMercator);
  glUseProgram(modelProgram_);
  glUniformMatrix4fv(modelMvp_, 1, GL_FALSE, mvp.data());
  glUniform4f(modelLightPos_, frame.light.position[0], frame.light.position[1], frame.light.position[2], frame.light.intensity);
  glUniform4f(modelLightColor_, frame.light.color[0], frame.light.color[1], frame.light.color[2], 0.f);
  glUniform4f(modelTint_, frame.tint[0], frame.tint[1], frame.tint[2], 1.f);
  glUniform1i(modelTexture_, 0);
  glActiveTexture(GL_TEXTURE0);
  glBindBufferBase(GL_UNIFORM_BUFFER, 0, paletteUbo_);
  glBindBuffer(GL_ARRAY_BUFFER, instanceVbo_);
  glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(frame.instances.size() * sizeof(ModelInstance)), frame.instances.data(),
               GL_STREAM_DRAW);
  streamBytes_ = frame.instances.size() * sizeof(ModelInstance) + kMaxJoints * 16 * sizeof(float);
  glDisable(GL_POLYGON_OFFSET_FILL);
  glDisable(GL_CULL_FACE);
  std::size_t draws = 0;
  for (int pass = 0; pass < 2; ++pass) {
    const bool translucent = pass == 1;
    if (translucent) {
      glEnable(GL_BLEND);
      glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
      glDepthMask(GL_FALSE);
    } else {
      glDisable(GL_BLEND);
      glDepthMask(GL_TRUE);
    }
    for (const ModelDraw& d : frame.draws) {
      if (!d.mesh || d.instanceCount == 0) continue;
      const bool any = std::any_of(d.mesh->parts.begin(), d.mesh->parts.end(),
                                   [&](const ModelPart& p) { return p.translucent() == translucent; });
      if (!any) continue;
      GpuModelMesh* gpu = gpuMesh(*d.mesh);
      if (gpu == nullptr) continue;
      glBindVertexArray(gpu->vao);
      glBindBuffer(GL_ARRAY_BUFFER, instanceVbo_);
      const std::size_t base = static_cast<std::size_t>(d.firstInstance) * sizeof(ModelInstance);
      for (GLuint k = 0; k < 4; ++k) {
        glVertexAttribPointer(6 + k, 4, GL_FLOAT, GL_FALSE, sizeof(ModelInstance), reinterpret_cast<const void*>(base + k * 16));
      }
      glVertexAttribPointer(10, 4, GL_FLOAT, GL_FALSE, sizeof(ModelInstance), reinterpret_cast<const void*>(base + offsetof(ModelInstance, color)));
      const std::size_t joints = std::min<std::size_t>(d.mesh->joints, kMaxJoints);
      const std::size_t first = static_cast<std::size_t>(d.palette) * 16;
      if (first + joints * 16 > frame.palettes.size()) continue;
      glBindBuffer(GL_UNIFORM_BUFFER, paletteUbo_);
      glBufferSubData(GL_UNIFORM_BUFFER, 0, static_cast<GLsizeiptr>(joints * 16 * sizeof(float)), frame.palettes.data() + first);
      for (const ModelPart& part : d.mesh->parts) {
        if (part.translucent() != translucent || part.indexCount == 0) continue;
        const bool textured = part.texture >= 0 && static_cast<std::size_t>(part.texture) < gpu->textures.size();
        glBindTexture(GL_TEXTURE_2D, textured ? gpu->textures[static_cast<std::size_t>(part.texture)] : whiteTexture_);
        glUniform4f(modelPart_, part.alpha == ModelAlpha::Mask ? part.alphaCutoff : -1.f, part.additive ? 1.f : 0.f,
                    part.alpha == ModelAlpha::Blend ? 1.f : 0.f, 0.f);
        glDrawElementsInstanced(GL_TRIANGLES, static_cast<GLsizei>(part.indexCount), GL_UNSIGNED_INT,
                                reinterpret_cast<const void*>(static_cast<std::size_t>(part.firstIndex) * sizeof(std::uint32_t)),
                                static_cast<GLsizei>(d.instanceCount));
        ++draws;
      }
    }
  }
  glDisable(GL_BLEND);
  glDepthMask(GL_TRUE);
  glBindVertexArray(0);
  glBindBuffer(GL_ARRAY_BUFFER, 0);
  glBindBuffer(GL_UNIFORM_BUFFER, 0);
  glBindTexture(GL_TEXTURE_2D, 0);
  for (auto it = meshes_.begin(); it != meshes_.end();) {
    if (modelFrames_ - it->second.lastUsed > kMeshKeepFrames) {
      modelBytes_ -= std::min(modelBytes_, it->second.bytes);
      glDeleteVertexArrays(1, &it->second.vao);
      const GLuint buffers[] = {it->second.vbo, it->second.ibo};
      glDeleteBuffers(2, buffers);
      if (!it->second.textures.empty()) glDeleteTextures(static_cast<GLsizei>(it->second.textures.size()), it->second.textures.data());
      it = meshes_.erase(it);
    } else {
      ++it;
    }
  }
  lastModelDraws_ = draws;
  lastModels_ = frame.characters + frame.drops;
  modelRenderMs_.push_back(nowMs() - start);
}

void BuildingLayerHost::upload(const BuildingLayerData& data) {
  if (meshVao_ == 0) {
    glGenVertexArrays(1, &meshVao_);
    glGenBuffers(1, &meshVbo_);
    glGenBuffers(1, &meshIbo_);
    glBindVertexArray(meshVao_);
    glBindBuffer(GL_ARRAY_BUFFER, meshVbo_);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, meshIbo_);
    constexpr GLsizei s = sizeof(BuildingMeshVertex);
    attrib(0, 3, GL_FLOAT, GL_FALSE, s, offsetof(BuildingMeshVertex, position));
    attrib(1, 4, GL_BYTE, GL_TRUE, s, offsetof(BuildingMeshVertex, normal));
    attrib(2, 4, GL_UNSIGNED_BYTE, GL_TRUE, s, offsetof(BuildingMeshVertex, color));
    attrib(3, 2, GL_FLOAT, GL_FALSE, s, offsetof(BuildingMeshVertex, facade));
    attrib(4, 1, GL_FLOAT, GL_FALSE, s, offsetof(BuildingMeshVertex, shade));
    attrib(5, 2, GL_FLOAT, GL_FALSE, s, offsetof(BuildingMeshVertex, cell));
    attrib(6, 4, GL_UNSIGNED_BYTE, GL_TRUE, s, offsetof(BuildingMeshVertex, window));
    attrib(7, 4, GL_UNSIGNED_BYTE, GL_TRUE, s, offsetof(BuildingMeshVertex, glass));

    glGenVertexArrays(1, &lineVao_);
    glGenBuffers(1, &lineVbo_);
    glGenBuffers(1, &lineIbo_);
    glBindVertexArray(lineVao_);
    glBindBuffer(GL_ARRAY_BUFFER, lineVbo_);
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, lineIbo_);
    constexpr GLsizei ls = sizeof(BuildingLineVertex);
    attrib(0, 3, GL_FLOAT, GL_FALSE, ls, offsetof(BuildingLineVertex, position));
    attrib(1, 3, GL_FLOAT, GL_FALSE, ls, offsetof(BuildingLineVertex, other));
    attrib(2, 1, GL_FLOAT, GL_FALSE, ls, offsetof(BuildingLineVertex, side));
    attrib(3, 4, GL_UNSIGNED_BYTE, GL_TRUE, ls, offsetof(BuildingLineVertex, color));
    glBindVertexArray(0);
  }
  glBindVertexArray(meshVao_);
  glBindBuffer(GL_ARRAY_BUFFER, meshVbo_);
  glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(data.vertices.size() * sizeof(BuildingMeshVertex)), data.vertices.data(),
               GL_STATIC_DRAW);
  // M4: the low-detail indices follow the full ones in the same element buffer.
  const std::size_t fullBytes = data.indices.size() * sizeof(std::uint32_t);
  const std::size_t lowBytes = data.lowDetailIndices.size() * sizeof(std::uint32_t);
  glBufferData(GL_ELEMENT_ARRAY_BUFFER, static_cast<GLsizeiptr>(fullBytes + lowBytes), nullptr, GL_STATIC_DRAW);
  if (fullBytes > 0) glBufferSubData(GL_ELEMENT_ARRAY_BUFFER, 0, static_cast<GLsizeiptr>(fullBytes), data.indices.data());
  if (lowBytes > 0) {
    glBufferSubData(GL_ELEMENT_ARRAY_BUFFER, static_cast<GLintptr>(fullBytes), static_cast<GLsizeiptr>(lowBytes), data.lowDetailIndices.data());
  }
  glBindVertexArray(lineVao_);
  glBindBuffer(GL_ARRAY_BUFFER, lineVbo_);
  glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(data.lineVertices.size() * sizeof(BuildingLineVertex)),
               data.lineVertices.data(), GL_STATIC_DRAW);
  glBufferData(GL_ELEMENT_ARRAY_BUFFER, static_cast<GLsizeiptr>(data.lineIndices.size() * sizeof(std::uint32_t)),
               data.lineIndices.data(), GL_STATIC_DRAW);
  glBindVertexArray(0);
  glBindBuffer(GL_ARRAY_BUFFER, 0);
  meshIndexCount_ = static_cast<GLsizei>(data.indices.size());
  lineIndexCount_ = static_cast<GLsizei>(data.lineIndices.size());
  lowIndexCount_ = static_cast<GLsizei>(data.lowDetailIndices.size());
  meshBytes_ = data.vertices.size() * sizeof(BuildingMeshVertex) + fullBytes + lowBytes +
               data.lineVertices.size() * sizeof(BuildingLineVertex) + data.lineIndices.size() * sizeof(std::uint32_t);
  uploadedVersion_ = data.version;
  __android_log_print(ANDROID_LOG_INFO, kTag, "uploaded v%llu: %zu vertices, %zu triangles, %zu outline vertices",
                      static_cast<unsigned long long>(data.version), data.vertices.size(), data.indices.size() / 3,
                      data.lineVertices.size());
}

void BuildingLayerHost::render(const mln::style::CustomLayerRenderParameters& parameters) {
  const double start = nowMs();
  const std::shared_ptr<const BuildingLayerData> data = state_->data();
  const std::shared_ptr<const ModelLayerFrame> models = state_->modelFrame();
  const bool haveBuildings = data && !data->indices.empty();
  const bool haveModels = models && !models->draws.empty();
  if (!haveBuildings && !haveModels) return;
  if (!ensurePrograms()) return;
  if (haveBuildings && data->version != uploadedVersion_) upload(*data);

  // MapLibre GL draws fill-extrusions with the depth range [0, R] and set [d, d] for this layer's sublayer:
  // recover R so the roofs and facades share the extrusions' depth exactly (BuildingMesh.hpp).
  GLfloat range[2] = {0.f, 1.f};
  glGetFloatv(GL_DEPTH_RANGE, range);
  if (range[0] == range[1] && range[0] > 0.5f) {
    lastFar_ = glExtrusionDepthRange(range[0], state_->layersAbove());
    haveFar_ = true;
  } else {
    // A frame where MapLibre disabled the sublayer depth (e.g. while the style's layers are still being
    // prepared): keep the last recovered range.
    ++probeMisses_;
    if (!depthWarned_) {
      depthWarned_ = true;
      __android_log_print(ANDROID_LOG_WARN, kTag, "custom layer depth range [%f, %f] carries no sublayer depth; using %s",
                          range[0], range[1], haveFar_ ? "the last recovered range" : "[0, 1]");
    }
  }
  const double far = lastFar_;
  GLint viewport[4] = {0, 0, 1, 1};
  glGetIntegerv(GL_VIEWPORT, viewport);
  const double pixelRatio = parameters.width > 0 ? viewport[2] / parameters.width : 1.0;

  glDepthRangef(0.f, static_cast<GLfloat>(far));
  glEnable(GL_DEPTH_TEST);
  glDepthFunc(GL_LEQUAL);
  glDepthMask(GL_TRUE);
  glDisable(GL_STENCIL_TEST);
  glDisable(GL_BLEND);
  glDisable(GL_CULL_FACE);
  glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  if (!haveBuildings) {
    // M3b models without building meshes (a world without buildings): same depth range.
    renderModels(*models, parameters);
    glUseProgram(0);
    recordFrame(start);
    return;
  }
  const std::array<float, 16> mvp = buildingLayerMatrix(parameters.nearClippedProjectionMatrix, parameters.zoom, *data);
  // M4 zoom-out: building height scale (`mapColors`) and the low-detail index range (after the full one).
  const BuildingLayerZoom zoom = state_->zoom();
  glEnable(GL_POLYGON_OFFSET_FILL);
  glPolygonOffset(-1.f, -2.f);

  glUseProgram(meshProgram_);
  glUniformMatrix4fv(meshMvp_, 1, GL_FALSE, mvp.data());
  glUniform1f(meshHeightScale_, zoom.heightScale);
  glUniform4f(meshLightPos_, data->light.position[0], data->light.position[1], data->light.position[2], data->light.intensity);
  glUniform4f(meshLightColor_, data->light.color[0], data->light.color[1], data->light.color[2], data->windowLights);
  glBindVertexArray(meshVao_);
  if (zoom.lowDetail) {
    glDrawElements(GL_TRIANGLES, lowIndexCount_, GL_UNSIGNED_INT,
                   reinterpret_cast<const void*>(static_cast<std::size_t>(meshIndexCount_) * sizeof(std::uint32_t)));
  } else {
    glDrawElements(GL_TRIANGLES, meshIndexCount_, GL_UNSIGNED_INT, nullptr);
  }

  if (lineIndexCount_ > 0 && data->lineWidth > 0) {
    glDepthMask(GL_FALSE);
    glPolygonOffset(-2.f, -8.f);
    glUseProgram(lineProgram_);
    glUniformMatrix4fv(lineMvp_, 1, GL_FALSE, mvp.data());
    glUniform1f(lineHeightScale_, zoom.heightScale);
    glUniform4f(lineViewport_, static_cast<GLfloat>(viewport[2]), static_cast<GLfloat>(viewport[3]),
                static_cast<GLfloat>(data->lineWidth * pixelRatio * 0.5), 0.f);
    glBindVertexArray(lineVao_);
    glDrawElements(GL_TRIANGLES, lineIndexCount_, GL_UNSIGNED_INT, nullptr);
    glDepthMask(GL_TRUE);
  }

  // MapLibre marks its GL state dirty after a custom layer, but does not track the polygon offset.
  glBindVertexArray(0);
  glPolygonOffset(0.f, 0.f);
  glDisable(GL_POLYGON_OFFSET_FILL);
  // M3b: the models, in the same depth range (occluded by and occluding the walls / roofs).
  if (haveModels) renderModels(*models, parameters);
  glUseProgram(0);
  recordFrame(start);
}

void BuildingLayerHost::recordFrame(double startMs) {
  const double end = nowMs();
  renderMs_.push_back(end - startMs);
  if (lastRenderMs_ > 0) intervals_.push_back(startMs - lastRenderMs_);
  lastRenderMs_ = startMs;
  if (static_cast<int>(renderMs_.size()) < kStatsFrames) return;
  // Intervals longer than 100 ms are idle gaps (MapLibre renders on demand), not frames.
  std::vector<double> busy;
  for (double x : intervals_) {
    if (x < 100) busy.push_back(x);
  }
  double intervalAvg, intervalP95, renderAvg, renderP95, modelAvg, modelP95;
  stats(busy, &intervalAvg, &intervalP95);
  stats(renderMs_, &renderAvg, &renderP95);
  stats(modelRenderMs_, &modelAvg, &modelP95);
  const BuildingLayerZoom zoom = state_->zoom();
  __android_log_print(ANDROID_LOG_INFO, kTag,
                      "maprama-frame-stats frames=%d interval_avg=%.2fms interval_p95=%.2fms layer_render_avg=%.3fms "
                      "layer_render_p95=%.3fms extrusion_depth_far=%.6f layers_above=%d probe_misses=%d models=%zu model_draws=%zu "
                      "model_render_avg=%.3fms model_render_p95=%.3fms gl_mesh_mb=%.2f gl_model_mb=%.2f gl_stream_mb=%.2f "
                      "low_detail=%d height_scale=%.2f",
                      static_cast<int>(renderMs_.size()), intervalAvg, intervalP95, renderAvg, renderP95, lastFar_,
                      state_->layersAbove(), probeMisses_, lastModels_, lastModelDraws_, modelAvg, modelP95, meshBytes_ / 1048576.0,
                      modelBytes_ / 1048576.0, streamBytes_ / 1048576.0, zoom.lowDetail ? 1 : 0, zoom.heightScale);
  probeMisses_ = 0;
  renderMs_.clear();
  intervals_.clear();
  modelRenderMs_.clear();
}

void BuildingLayerHost::contextLost() {
  // The GL objects died with the context; `initialize` / the next render recreate them.
  meshProgram_ = lineProgram_ = 0;
  meshVao_ = meshVbo_ = meshIbo_ = 0;
  lineVao_ = lineVbo_ = lineIbo_ = 0;
  uploadedVersion_ = 0;
  lowIndexCount_ = 0;
  meshBytes_ = modelBytes_ = streamBytes_ = 0;
  programFailed_ = false;
  modelProgram_ = 0;
  modelProgramFailed_ = false;
  paletteUbo_ = instanceVbo_ = whiteTexture_ = 0;
  meshes_.clear();
}

void BuildingLayerHost::releaseGl() {
  if (meshVao_ != 0) glDeleteVertexArrays(1, &meshVao_);
  if (lineVao_ != 0) glDeleteVertexArrays(1, &lineVao_);
  const GLuint buffers[] = {meshVbo_, meshIbo_, lineVbo_, lineIbo_};
  for (GLuint b : buffers) {
    if (b != 0) glDeleteBuffers(1, &b);
  }
  if (meshProgram_ != 0) glDeleteProgram(meshProgram_);
  if (lineProgram_ != 0) glDeleteProgram(lineProgram_);
  for (auto& entry : meshes_) {
    glDeleteVertexArrays(1, &entry.second.vao);
    const GLuint mesh[] = {entry.second.vbo, entry.second.ibo};
    glDeleteBuffers(2, mesh);
    if (!entry.second.textures.empty()) glDeleteTextures(static_cast<GLsizei>(entry.second.textures.size()), entry.second.textures.data());
  }
  if (paletteUbo_ != 0) glDeleteBuffers(1, &paletteUbo_);
  if (instanceVbo_ != 0) glDeleteBuffers(1, &instanceVbo_);
  if (whiteTexture_ != 0) glDeleteTextures(1, &whiteTexture_);
  if (modelProgram_ != 0) glDeleteProgram(modelProgram_);
  contextLost();
}

void BuildingLayerHost::deinitialize() {
  releaseGl();
  __android_log_print(ANDROID_LOG_INFO, kTag, "building layer deinitialized");
}

}  // namespace maprama::android
