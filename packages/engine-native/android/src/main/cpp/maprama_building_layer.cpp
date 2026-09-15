#include "maprama_building_layer.hpp"

#include <android/log.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
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
out vec3 v_color;
out vec3 v_normal;
out vec2 v_facade;
out float v_shade;
flat out vec2 v_cell;
flat out vec4 v_window;
flat out vec4 v_glass;
flat out int v_pattern;
void main() {
  gl_Position = u_mvp * vec4(a_position, 1.0);
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
out vec4 v_color;
void main() {
  vec4 a = u_mvp * vec4(a_position, 1.0);
  vec4 b = u_mvp * vec4(a_other, 1.0);
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
  __android_log_print(ANDROID_LOG_INFO, kTag, "programs ready (%s)", reinterpret_cast<const char*>(glGetString(GL_RENDERER)));
  return true;
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
  glBufferData(GL_ELEMENT_ARRAY_BUFFER, static_cast<GLsizeiptr>(data.indices.size() * sizeof(std::uint32_t)), data.indices.data(),
               GL_STATIC_DRAW);
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
  uploadedVersion_ = data.version;
  __android_log_print(ANDROID_LOG_INFO, kTag, "uploaded v%llu: %zu vertices, %zu triangles, %zu outline vertices",
                      static_cast<unsigned long long>(data.version), data.vertices.size(), data.indices.size() / 3,
                      data.lineVertices.size());
}

void BuildingLayerHost::render(const mln::style::CustomLayerRenderParameters& parameters) {
  const double start = nowMs();
  const std::shared_ptr<const BuildingLayerData> data = state_->data();
  if (!data || data->indices.empty()) return;
  if (!ensurePrograms()) return;
  if (data->version != uploadedVersion_) upload(*data);

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
  const std::array<float, 16> mvp = buildingLayerMatrix(parameters.nearClippedProjectionMatrix, parameters.zoom, *data);

  glDepthRangef(0.f, static_cast<GLfloat>(far));
  glEnable(GL_DEPTH_TEST);
  glDepthFunc(GL_LEQUAL);
  glDepthMask(GL_TRUE);
  glDisable(GL_STENCIL_TEST);
  glDisable(GL_BLEND);
  glDisable(GL_CULL_FACE);
  glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  glEnable(GL_POLYGON_OFFSET_FILL);
  glPolygonOffset(-1.f, -2.f);

  glUseProgram(meshProgram_);
  glUniformMatrix4fv(meshMvp_, 1, GL_FALSE, mvp.data());
  glUniform4f(meshLightPos_, data->light.position[0], data->light.position[1], data->light.position[2], data->light.intensity);
  glUniform4f(meshLightColor_, data->light.color[0], data->light.color[1], data->light.color[2], data->windowLights);
  glBindVertexArray(meshVao_);
  glDrawElements(GL_TRIANGLES, meshIndexCount_, GL_UNSIGNED_INT, nullptr);

  if (lineIndexCount_ > 0 && data->lineWidth > 0) {
    glDepthMask(GL_FALSE);
    glPolygonOffset(-2.f, -8.f);
    glUseProgram(lineProgram_);
    glUniformMatrix4fv(lineMvp_, 1, GL_FALSE, mvp.data());
    glUniform4f(lineViewport_, static_cast<GLfloat>(viewport[2]), static_cast<GLfloat>(viewport[3]),
                static_cast<GLfloat>(data->lineWidth * pixelRatio * 0.5), 0.f);
    glBindVertexArray(lineVao_);
    glDrawElements(GL_TRIANGLES, lineIndexCount_, GL_UNSIGNED_INT, nullptr);
    glDepthMask(GL_TRUE);
  }

  // MapLibre marks its GL state dirty after a custom layer, but does not track the polygon offset.
  glBindVertexArray(0);
  glUseProgram(0);
  glPolygonOffset(0.f, 0.f);
  glDisable(GL_POLYGON_OFFSET_FILL);
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
  double intervalAvg, intervalP95, renderAvg, renderP95;
  stats(busy, &intervalAvg, &intervalP95);
  stats(renderMs_, &renderAvg, &renderP95);
  __android_log_print(ANDROID_LOG_INFO, kTag,
                      "maprama-frame-stats frames=%d interval_avg=%.2fms interval_p95=%.2fms layer_render_avg=%.3fms "
                      "layer_render_p95=%.3fms extrusion_depth_far=%.6f layers_above=%d probe_misses=%d",
                      static_cast<int>(renderMs_.size()), intervalAvg, intervalP95, renderAvg, renderP95, lastFar_,
                      state_->layersAbove(), probeMisses_);
  probeMisses_ = 0;
  renderMs_.clear();
  intervals_.clear();
}

void BuildingLayerHost::contextLost() {
  // The GL objects died with the context; `initialize` / the next render recreate them.
  meshProgram_ = lineProgram_ = 0;
  meshVao_ = meshVbo_ = meshIbo_ = 0;
  lineVao_ = lineVbo_ = lineIbo_ = 0;
  uploadedVersion_ = 0;
  programFailed_ = false;
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
  contextLost();
}

void BuildingLayerHost::deinitialize() {
  releaseGl();
  __android_log_print(ANDROID_LOG_INFO, kTag, "building layer deinitialized");
}

}  // namespace maprama::android
