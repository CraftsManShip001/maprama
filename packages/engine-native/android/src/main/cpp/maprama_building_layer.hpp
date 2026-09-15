// M2c custom building layer on the official MapLibre Android SDK (`android-sdk-opengl`, GL ES 3):
// a `mln::style::CustomLayerHost` (vendored interface, vendor/maplibre) that draws the core's
// `BuildingLayerData` inside MapLibre's render pass, registered from Kotlin as
// `org.maplibre.android.style.layers.CustomLayer(id, hostPointer)` directly below the `buildings`
// fill-extrusion layer (DESIGN.md §6.1). Since M3b it also draws the core's `ModelLayerFrame` (glTF / procedural
// characters, vehicles, drop items) with GPU skinning in the same pass and depth range.
#pragma once

#include <GLES3/gl3.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

#include "maprama/BuildingMesh.hpp"
#include "maprama/ModelLayer.hpp"
#include "mln/style/layers/custom_layer_host.hpp"

namespace maprama::android {

/// Shared by the JNI map adapter (main thread) and the layer hosts (MapLibre's render thread). A style reload
/// creates a new host; the state (latest data) survives it.
class BuildingLayerState {
 public:
  void setData(std::shared_ptr<const BuildingLayerData> data) {
    std::lock_guard<std::mutex> lock(mutex_);
    data_ = std::move(data);
  }
  std::shared_ptr<const BuildingLayerData> data() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return data_;
  }
  /// M3b: the latest model frame (one per game tick).
  void setModelFrame(std::shared_ptr<const ModelLayerFrame> frame) {
    std::lock_guard<std::mutex> lock(mutex_);
    models_ = std::move(frame);
  }
  std::shared_ptr<const ModelLayerFrame> modelFrame() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return models_;
  }
  /// Style layers drawn above the custom layer (the GL depth-range probe needs it).
  void setLayersAbove(int n) { layersAbove_.store(n); }
  int layersAbove() const { return layersAbove_.load(); }

 private:
  mutable std::mutex mutex_;
  std::shared_ptr<const BuildingLayerData> data_;
  std::shared_ptr<const ModelLayerFrame> models_;
  std::atomic<int> layersAbove_{1};
};

class BuildingLayerHost final : public mln::style::CustomLayerHost {
 public:
  explicit BuildingLayerHost(std::shared_ptr<BuildingLayerState> state) : state_(std::move(state)) {}
  ~BuildingLayerHost() override = default;

  void initialize(const mln::style::CustomLayerInitParameters&) override;
  void render(const mln::style::CustomLayerRenderParameters& parameters) override;
  void contextLost() override;
  void deinitialize() override;

 private:
  /// GPU copy of one `ModelMesh` (kept while frames use it).
  struct GpuModelMesh {
    GLuint vao = 0, vbo = 0, ibo = 0;
    std::vector<GLuint> textures;
    std::uint64_t lastUsed = 0;
  };

  bool ensurePrograms();
  bool ensureModelProgram();
  void upload(const BuildingLayerData& data);
  GpuModelMesh* gpuMesh(const ModelMesh& mesh);
  void renderModels(const ModelLayerFrame& frame, const mln::style::CustomLayerRenderParameters& parameters);
  void releaseGl();
  void recordFrame(double startMs);

  std::shared_ptr<BuildingLayerState> state_;
  GLuint meshProgram_ = 0;
  GLuint lineProgram_ = 0;
  bool programFailed_ = false;
  GLint meshMvp_ = -1, meshLightPos_ = -1, meshLightColor_ = -1;
  GLint lineMvp_ = -1, lineViewport_ = -1;
  GLuint meshVao_ = 0, meshVbo_ = 0, meshIbo_ = 0;
  GLuint lineVao_ = 0, lineVbo_ = 0, lineIbo_ = 0;
  GLsizei meshIndexCount_ = 0, lineIndexCount_ = 0;
  std::uint64_t uploadedVersion_ = 0;
  // M3b model pass.
  GLuint modelProgram_ = 0;
  bool modelProgramFailed_ = false;
  GLint modelMvp_ = -1, modelLightPos_ = -1, modelLightColor_ = -1, modelTint_ = -1, modelPart_ = -1, modelTexture_ = -1;
  GLuint paletteUbo_ = 0, instanceVbo_ = 0, whiteTexture_ = 0;
  std::unordered_map<std::uint64_t, GpuModelMesh> meshes_;
  std::uint64_t modelFrames_ = 0;
  std::vector<double> modelRenderMs_;
  std::size_t lastModelDraws_ = 0;
  std::size_t lastModels_ = 0;
  bool depthWarned_ = false;
  /// Last extrusion depth range recovered from MapLibre's sublayer depth (reused when a frame has none).
  double lastFar_ = 1.0;
  bool haveFar_ = false;
  int probeMisses_ = 0;

  // Frame timing (render thread only).
  std::vector<double> intervals_;
  std::vector<double> renderMs_;
  double lastRenderMs_ = 0;
};

}  // namespace maprama::android
