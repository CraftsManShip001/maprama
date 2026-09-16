// Maprama native core — M3b model layer: the per-tick render snapshot of the 3D characters, vehicles and drops
// (`ModelLayerFrame`) that the platform custom layers draw with GPU skinning in the same pass as the M2c
// building meshes (depth-tested against the fill-extrusion walls), and the core-side state that produces it:
// `CharacterModel` (engine-web `Character`'s visual half: glTF clips or the procedural body, vehicles) and the
// drop item animation (engine-web `DropVisuals.step`: appear, idle bob + spin, collect pop, beam and ring).
//
// Frame layout (immutable once handed to the platform, read on the render thread):
//   - `palettes`: column-major matrices (16 floats each); every palette starts at a multiple of 4 matrices
//     (256 bytes, the Metal / GL buffer offset alignment); palette 0 is the identity (instanced drops);
//   - `instances`: per-instance model matrix (model space → frame local units: x east, y south in mercator ×
//     `unitsPerMercator` relative to the origin, z meters up — the building layer's space) + colour multiplier
//     and opacity;
//   - `draws`: a mesh, its palette and an instance range. The platform draws the opaque parts of every draw
//     first, then the translucent ones (blended, no depth writes).
#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "maprama/BuildingMesh.hpp"
#include "maprama/CharacterAnimation.hpp"
#include "maprama/MapLook.hpp"
#include "maprama/ModelMesh.hpp"
#include "maprama/ProceduralMeshes.hpp"
#include "maprama/Projection.hpp"
#include "maprama/TravelLogic.hpp"
#include "maprama/json.hpp"
#include "maprama/types.hpp"

namespace maprama {

/// engine-web drop item timings: appear (easeOutBack), collect pop.
inline constexpr double kDropAppearSeconds = 0.35;
inline constexpr double kDropPopSeconds = 0.45;
/// Palettes start at multiples of this many matrices (256-byte buffer offsets).
inline constexpr std::uint32_t kPaletteAlignment = 4;

struct ModelInstance {
  float matrix[16];
  /// rgb multiplier, a = opacity.
  float color[4];
};
static_assert(sizeof(ModelInstance) == 80, "ModelInstance layout is shared with the shaders");

struct ModelDraw {
  std::shared_ptr<const ModelMesh> mesh;
  /// First palette matrix (a multiple of `kPaletteAlignment`).
  std::uint32_t palette = 0;
  std::uint32_t firstInstance = 0;
  std::uint32_t instanceCount = 0;
};

/// What the frame shows, per character / drop (diagnostics and tests; not read by the renderers).
struct ModelVisual {
  enum class Kind : std::uint8_t { Character, Drop };
  Kind kind = Kind::Character;
  std::string id;
  /// Drops: the layer id.
  std::string layerId;
  LngLat position;
  /// World units above the ground plane.
  double altitude = 0;
  /// Characters: the time-of-day tinted body colour; drops: the rarity colour.
  std::uint32_t color = 0;
  double scale = 1;
  bool isPlayer = false;
  TravelMode mode = TravelMode::Walk;
  /// A loaded glTF is shown (else the procedural body / item shape).
  bool gltf = false;
  std::optional<AnimationName> animation;
  double headingDeg = 0;
  DropType type = DropType::Coin;
  Rarity rarity = Rarity::Common;
  /// Collect pop progress (0 = not popping, (0, 1) = popping).
  double pop = 0;
};

struct ModelLayerFrame {
  std::uint64_t version = 0;
  /// Web-mercator origin (0..1) of the local units and local units per mercator unit (as `BuildingLayerData`).
  double originX = 0.0;
  double originY = 0.0;
  double unitsPerMercator = 1.0;
  BuildingLayerLight light;
  /// Time-of-day tint multiplied into every model colour (MapLook::tint).
  float tint[3] = {1.f, 1.f, 1.f};
  std::vector<float> palettes;
  std::vector<ModelInstance> instances;
  std::vector<ModelDraw> draws;
  std::vector<ModelVisual> visuals;
  std::size_t characters = 0;
  std::size_t drops = 0;
  /// M4 zoom-out beyond D2: characters and drops are drawn as icon discs (one instanced draw).
  bool sprites = false;
};

/// Model-view-projection of the model layer (same math as `buildingLayerMatrix`).
std::array<float, 16> modelLayerMatrix(const std::array<double, 16>& projection, double zoom, double originX, double originY,
                                       double unitsPerMercator);

/// Collects the draws of one frame.
class ModelFrameBuilder {
 public:
  /// `origin` = the world origin (the building layer's local-unit origin).
  ModelFrameBuilder(const Projection& projection, const LngLat& origin, double unitMeters);

  /// World units (x east, y up, z south) → frame local units, with the world → local axis swap and scales.
  Mat4 placement(double x, double y, double z) const;
  /// Local units per world unit horizontally, meters per world unit vertically.
  double horizontalScale() const { return horizontal_; }
  double verticalScale() const { return unitMeters_; }

  std::uint32_t addPalette(const std::vector<Mat4>& palette);
  /// One draw with its own palette and a single instance.
  void draw(const std::shared_ptr<const ModelMesh>& mesh, std::uint32_t palette, const Mat4& instance, const std::array<float, 4>& color);
  /// Instanced draws of rigid meshes (identity palette), batched per mesh.
  void instance(const std::shared_ptr<const ModelMesh>& mesh, const Mat4& instance, const std::array<float, 4>& color);
  void visual(ModelVisual v);

  std::shared_ptr<ModelLayerFrame> finish(const BuildingLayerLight& light, const RgbTint& tint, std::uint64_t version);

 private:
  const Projection& projection_;
  double unitMeters_;
  double horizontal_ = 1.0;
  std::shared_ptr<ModelLayerFrame> frame_;
  std::vector<std::pair<std::shared_ptr<const ModelMesh>, std::vector<ModelInstance>>> batches_;
  std::map<std::uint64_t, std::size_t> batchIndex_;
};

/// engine-web `Character`'s visual state: a glTF (clips through `ModelAnimator`) or the procedural body, and the
/// vehicles of its travel modes.
class CharacterModel {
 public:
  /// Shows a loaded model (nullptr: back to the procedural body). The model is normalized like engine-web's
  /// `normalizeModel(…, CHARACTER_HEIGHT)`.
  void setAsset(std::shared_ptr<const ModelAsset> asset, const AnimationClips& mapping);
  /// `CharacterSpec.animations` changed (engine-web `refreshClips`).
  void setMapping(const AnimationClips& mapping);
  bool hasModel() const { return animator_.asset() != nullptr; }
  const std::shared_ptr<const ModelAsset>& asset() const { return animator_.asset(); }

  /// engine-web `Character.setMode` + `Character.animate` for one frame (`t` = seconds, the shared clock).
  void step(double dt, double t, const FollowerBody& body, double unitMeters, double scale);
  /// Appends the body (glTF or procedural) and the visible vehicles.
  void draw(ModelFrameBuilder& builder, const FollowerBody& body, double yaw, double scale, std::uint32_t color, bool isPlayer) const;

  std::optional<AnimationName> animation() const { return animator_.current(); }
  const ModelAnimator& animator() const { return animator_; }
  const VehicleSetState& vehicles() const { return vehicles_; }
  const ProceduralRigState& rig() const { return rig_; }
  /// engine-web `hideBody` (a car / plane / subway has popped in) and `onBike`.
  bool bodyHidden() const;
  bool onBike() const;

 private:
  ModelAnimator animator_;
  Mat4 normalize_ = model_math::identity();
  ProceduralRigState rig_;
  VehicleSetState vehicles_;
  TravelMode mode_ = TravelMode::Walk;
};

/// One drop item on the map (engine-web `DropVisuals` item): its look, timings and (for `model` drops) glTF.
struct DropVisual {
  std::string layerId;
  std::string dropId;
  LngLat position;
  DropType type = DropType::Coin;
  Rarity rarity = Rarity::Common;
  std::optional<double> value;
  /// `model` drops: the glTF URI, the loaded asset and whether the load failed (then a coin is shown).
  std::string modelUri;
  std::shared_ptr<const ModelAsset> model;
  bool modelFailed = false;
  /// Clock of `setDropLayer` (appear) and of the collection (pop), milliseconds.
  double addedMs = 0.0;
  std::optional<double> popMs;
  /// engine-web `(hash(id) % 628) / 100`.
  double phase = 0.0;
};

/// Collect pop progress in [0, 1] (0 before a collection).
double dropPopProgress(const DropVisual& drop, double nowMs);
/// The item transform of a drop at `nowMs` (engine-web `DropVisuals.step`): placement · spin · scale (tests).
Mat4 dropItemTransform(const ModelFrameBuilder& builder, const DropVisual& drop, const WorldPoint& at, double groundY, double nowMs);
/// Appends a drop's item, beam and ring (music drops and non-common rarities; the note sprites are not drawn).
void drawDrop(ModelFrameBuilder& builder, const DropVisual& drop, const WorldPoint& at, double groundY, double nowMs);

/// M4 zoom-out beyond D2 (`ZoomOutController::sprites`): icon disc radii in world units (≈ 8–11 dp at D2–150 units).
inline constexpr double kCharacterIconRadius = 1.1;
inline constexpr double kPlayerIconRadius = 1.35;
inline constexpr double kDropIconRadius = 0.6;
/// A character as a flat icon disc on the ground (body colour, dark rim), instanced with every other icon.
void drawCharacterIcon(ModelFrameBuilder& builder, const FollowerBody& body, std::uint32_t color, bool isPlayer, double scale);
/// A drop as a small icon disc in its rarity colour (shrinks away during the collect pop).
void drawDropIcon(ModelFrameBuilder& builder, const DropVisual& drop, const WorldPoint& at, double groundY, double nowMs);

/// `AnimationClips` mapping from `CharacterSpec.animations` (a JSON object of clip names).
AnimationClips animationMapping(const json::Value* animations);

}  // namespace maprama
