#include "maprama/ModelLayer.hpp"

#include <algorithm>
#include <cmath>
#include <utility>

namespace maprama {

namespace {

namespace mm = model_math;

constexpr double kPi = mm::kPi;
/// MapLibre `util::tileSize_D` and the web-mercator sphere (as BuildingMesh.cpp).
constexpr double kTileSize = 512.0;
constexpr double kMercatorEarthRadius = 6378137.0;
/// engine-web `RARITY_COLORS`.
constexpr std::array<std::uint32_t, 3> kRarityColors{0x6FB7FF, 0xB07CFF, 0xFFC24A};

const std::array<float, 4> kWhite{1.f, 1.f, 1.f, 1.f};

std::array<float, 4> rgba(std::uint32_t rgb, double alpha) {
  return {static_cast<float>(((rgb >> 16) & 0xFF) / 255.0), static_cast<float>(((rgb >> 8) & 0xFF) / 255.0),
          static_cast<float>((rgb & 0xFF) / 255.0), static_cast<float>(alpha)};
}

constexpr std::array<TravelMode, 4> kVehicleModes{TravelMode::Bike, TravelMode::Car, TravelMode::Plane, TravelMode::Subway};

/// engine-web `DropVisuals` item pose at `nowMs`.
struct DropPose {
  double y = 0;
  double spin = 0;
  double scale = 1;
  double beam = 1;
  double ring = 1;
};

DropPose dropPose(const DropVisual& d, double groundY, double nowMs) {
  const bool music = d.type != DropType::Coin;
  const double freq = music ? 2.4 : 3, amp = music ? 0.1 : 0.12, rate = music ? 1.6 : 2.2;
  const double base = groundY + (music ? 0.95 : 0.9);
  // The idle animation runs until the collection; the pop starts from where it was.
  const double idleEnd = d.popMs ? *d.popMs : nowMs;
  const double age = std::max(0.0, (idleEnd - d.addedMs) / 1000.0);
  const double t = idleEnd / 1000.0;
  DropPose p;
  const double appear = std::clamp(age / kDropAppearSeconds, 0.0, 1.0);
  p.scale = appear >= 1 ? 1.0 : std::max(0.001, easeOutBack(appear));
  p.y = base + std::sin(t * freq + d.phase) * amp;
  p.spin = age * rate;
  p.beam = std::max(0.001, std::min(1.0, age / 0.5) * (d.rarity == Rarity::Legendary ? 1.5 : 1.0));
  p.ring = 0.8 + std::sin(t * 3 + d.phase) * 0.12;
  if (d.popMs) {
    const double popAge = std::max(0.0, (nowMs - *d.popMs) / 1000.0);
    const double k = popAge / kDropPopSeconds;
    p.y += 5 * popAge;
    p.spin += 14 * popAge;
    p.scale = k < 0.4 ? 1 + k * 1.5 : std::max(0.001, (1.6 * (1 - k)) / 0.6);
    p.beam = std::max(0.001, 1 - k);
  }
  return p;
}

}  // namespace

std::array<float, 16> modelLayerMatrix(const std::array<double, 16>& projection, double zoom, double originX, double originY,
                                       double unitsPerMercator) {
  const double worldSize = kTileSize * std::pow(2.0, zoom);
  const double k = worldSize / unitsPerMercator;
  const std::array<double, 16> model{k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1, 0, originX * worldSize, originY * worldSize, 0, 1};
  std::array<float, 16> out{};
  for (int col = 0; col < 4; ++col) {
    for (int row = 0; row < 4; ++row) {
      double sum = 0;
      for (int i = 0; i < 4; ++i) sum += projection[static_cast<std::size_t>(i * 4 + row)] * model[static_cast<std::size_t>(col * 4 + i)];
      out[static_cast<std::size_t>(col * 4 + row)] = static_cast<float>(sum);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// ModelFrameBuilder
// ---------------------------------------------------------------------------------------------------

ModelFrameBuilder::ModelFrameBuilder(const Projection& projection, const LngLat& origin, double unitMeters)
    : projection_(projection), unitMeters_(unitMeters), frame_(std::make_shared<ModelLayerFrame>()) {
  const std::array<double, 2> o = lngLatToMercator(origin);
  frame_->originX = o[0];
  frame_->originY = o[1];
  frame_->unitsPerMercator = 2 * kPi * kMercatorEarthRadius * std::cos(origin.lat * kPi / 180.0);
  const std::array<double, 2> a = lngLatToMercator(projection.toLngLat(WorldPoint{0, 0}));
  const std::array<double, 2> b = lngLatToMercator(projection.toLngLat(WorldPoint{1, 0}));
  horizontal_ = std::hypot(b[0] - a[0], b[1] - a[1]) * frame_->unitsPerMercator;
  addPalette({mm::identity()});
}

Mat4 ModelFrameBuilder::placement(double x, double y, double z) const {
  const std::array<double, 2> m = lngLatToMercator(projection_.toLngLat(WorldPoint{x, z}));
  const double lx = (m[0] - frame_->originX) * frame_->unitsPerMercator;
  const double ly = (m[1] - frame_->originY) * frame_->unitsPerMercator;
  const double h = horizontal_, v = unitMeters_;
  // Columns: world x (east) → local x, world y (up) → local z (meters), world z (south) → local y.
  return Mat4{h, 0, 0, 0, 0, 0, v, 0, 0, h, 0, 0, lx, ly, y * v, 1};
}

std::uint32_t ModelFrameBuilder::addPalette(const std::vector<Mat4>& palette) {
  std::vector<float>& p = frame_->palettes;
  std::size_t count = p.size() / 16;
  const Mat4 id = mm::identity();
  while (count % kPaletteAlignment != 0) {
    for (const double v : id) p.push_back(static_cast<float>(v));
    ++count;
  }
  for (const Mat4& m : palette) {
    for (const double v : m) p.push_back(static_cast<float>(v));
  }
  return static_cast<std::uint32_t>(count);
}

void ModelFrameBuilder::draw(const std::shared_ptr<const ModelMesh>& mesh, std::uint32_t palette, const Mat4& instance,
                             const std::array<float, 4>& color) {
  if (!mesh) return;
  ModelInstance inst{};
  for (std::size_t i = 0; i < 16; ++i) inst.matrix[i] = static_cast<float>(instance[i]);
  for (std::size_t i = 0; i < 4; ++i) inst.color[i] = color[i];
  frame_->draws.push_back(ModelDraw{mesh, palette, static_cast<std::uint32_t>(frame_->instances.size()), 1});
  frame_->instances.push_back(inst);
}

void ModelFrameBuilder::instance(const std::shared_ptr<const ModelMesh>& mesh, const Mat4& instance, const std::array<float, 4>& color) {
  if (!mesh) return;
  ModelInstance inst{};
  for (std::size_t i = 0; i < 16; ++i) inst.matrix[i] = static_cast<float>(instance[i]);
  for (std::size_t i = 0; i < 4; ++i) inst.color[i] = color[i];
  const auto it = batchIndex_.find(mesh->id);
  if (it == batchIndex_.end()) {
    batchIndex_[mesh->id] = batches_.size();
    batches_.emplace_back(mesh, std::vector<ModelInstance>{inst});
  } else {
    batches_[it->second].second.push_back(inst);
  }
}

void ModelFrameBuilder::visual(ModelVisual v) {
  if (v.kind == ModelVisual::Kind::Character) {
    ++frame_->characters;
  } else {
    ++frame_->drops;
  }
  frame_->visuals.push_back(std::move(v));
}

std::shared_ptr<ModelLayerFrame> ModelFrameBuilder::finish(const BuildingLayerLight& light, const RgbTint& tint, std::uint64_t version) {
  for (auto& [mesh, list] : batches_) {
    frame_->draws.push_back(ModelDraw{mesh, 0, static_cast<std::uint32_t>(frame_->instances.size()), static_cast<std::uint32_t>(list.size())});
    frame_->instances.insert(frame_->instances.end(), list.begin(), list.end());
  }
  batches_.clear();
  batchIndex_.clear();
  frame_->light = light;
  frame_->tint[0] = static_cast<float>(tint.r);
  frame_->tint[1] = static_cast<float>(tint.g);
  frame_->tint[2] = static_cast<float>(tint.b);
  frame_->version = version;
  return std::move(frame_);
}

// ---------------------------------------------------------------------------------------------------
// CharacterModel
// ---------------------------------------------------------------------------------------------------

void CharacterModel::setAsset(std::shared_ptr<const ModelAsset> asset, const AnimationClips& mapping) {
  if (!asset) {
    animator_ = ModelAnimator();
    normalize_ = mm::identity();
    return;
  }
  normalize_ = normalizeTransform(asset->boundsMin, asset->boundsMax, kCharacterHeight, false);
  animator_ = ModelAnimator(std::move(asset), mapping);
}

void CharacterModel::setMapping(const AnimationClips& mapping) {
  if (hasModel()) animator_.setMapping(mapping);
}

bool CharacterModel::bodyHidden() const {
  const int k = vehicleIndex(mode_);
  if (!vehicles_.built || k < 0 || mode_ == TravelMode::Bike) return false;
  const VehicleState& v = vehicles_.vehicles[static_cast<std::size_t>(k)];
  return v.visible && v.p > 0.55;
}

bool CharacterModel::onBike() const { return mode_ == TravelMode::Bike && vehicles_.built && vehicles_.vehicles[0].p > 0.4; }

void CharacterModel::step(double dt, double t, const FollowerBody& body, double scale) {
  // engine-web `Character.setMode`: vehicles are built on the first non-walking mode.
  if (body.mode != mode_) {
    mode_ = body.mode;
    if (mode_ != TravelMode::Walk) vehicles_.built = true;
    if (vehicles_.built) switchVehicle(vehicles_, mode_);
  }
  if (vehicles_.built) stepVehicles(vehicles_, mode_, body.speed, dt, t, body.planePitch);
  const bool bike = onBike();
  if (hasModel()) {
    animator_.update(dt, bike || mode_ == TravelMode::Car ? mode_ : TravelMode::Walk, body.speed, scale);
  } else {
    animateProceduralRig(rig_, dt, t, mode_, body.speed, scale, bike);
  }
}

void CharacterModel::draw(ModelFrameBuilder& builder, const FollowerBody& body, double yaw, double scale, std::uint32_t color,
                          bool isPlayer) const {
  const Mat4 root = mm::multiply(builder.placement(body.x, body.y, body.z), mm::multiply(mm::rotationY(yaw), mm::scaling(scale, scale, scale)));
  if (!bodyHidden()) {
    if (hasModel()) {
      const Mat4 wrap = onBike() ? mm::translation(0, 0.32, -0.17) : mm::identity();
      builder.draw(asset()->mesh, builder.addPalette(animator_.palette()), mm::multiply(root, mm::multiply(wrap, normalize_)), kWhite);
    } else {
      builder.draw(proceduralCharacterMesh(color, isPlayer), builder.addPalette(proceduralRigPalette(rig_)), root, kWhite);
    }
  }
  if (!vehicles_.built) return;
  for (std::size_t k = 0; k < kVehicleModes.size(); ++k) {
    if (!vehicles_.vehicles[k].visible) continue;
    const TravelMode mode = kVehicleModes[k];
    builder.draw(vehicleMesh(mode), builder.addPalette(vehiclePalette(vehicles_, mode, rig_.crank)), root, kWhite);
  }
}

// ---------------------------------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------------------------------

double dropPopProgress(const DropVisual& drop, double nowMs) {
  if (!drop.popMs) return 0.0;
  return std::clamp((nowMs - *drop.popMs) / 1000.0 / kDropPopSeconds, 0.0, 1.0);
}

Mat4 dropItemTransform(const ModelFrameBuilder& builder, const DropVisual& drop, const WorldPoint& at, double groundY, double nowMs) {
  const DropPose p = dropPose(drop, groundY, nowMs);
  return mm::multiply(builder.placement(at.x, p.y, at.z), mm::multiply(mm::rotationY(p.spin), mm::scaling(p.scale, p.scale, p.scale)));
}

void drawDrop(ModelFrameBuilder& builder, const DropVisual& drop, const WorldPoint& at, double groundY, double nowMs) {
  const DropPose p = dropPose(drop, groundY, nowMs);
  const Mat4 item = mm::multiply(builder.placement(at.x, p.y, at.z), mm::multiply(mm::rotationY(p.spin), mm::scaling(p.scale, p.scale, p.scale)));
  if (drop.type == DropType::Model && !drop.modelFailed && !drop.modelUri.empty()) {
    // engine-web: the item stays empty until the model has loaded; normalized to 1.1 by its largest extent.
    if (drop.model) {
      const Mat4 inner = mm::multiply(mm::translation(0, -0.45, 0), normalizeTransform(drop.model->boundsMin, drop.model->boundsMax, 1.1, true));
      builder.draw(drop.model->mesh, builder.addPalette(restPalette(*drop.model)), mm::multiply(item, inner), kWhite);
    }
  } else {
    // A failed (or URI-less) model drop shows a coin, like engine-web's `addCoin` fallback.
    const DropType shape = drop.type == DropType::Model ? DropType::Coin : drop.type;
    const bool gem = shape == DropType::Coin && drop.value.value_or(10) >= 50;
    builder.instance(dropMesh(shape, drop.rarity, gem), item, kWhite);
  }
  const bool music = drop.type != DropType::Coin;
  if (music || drop.rarity != Rarity::Common) {
    const std::uint32_t color = kRarityColors[static_cast<std::size_t>(drop.rarity)];
    const Mat4 fx = builder.placement(at.x, groundY + 0.07, at.z);
    builder.instance(dropBeamMesh(), mm::multiply(fx, mm::scaling(1, p.beam, 1)), rgba(color, 0.8));
    builder.instance(dropRingMesh(), mm::multiply(fx, mm::scaling(p.ring, p.ring, p.ring)), rgba(color, 0.7));
  }
}

void drawCharacterIcon(ModelFrameBuilder& builder, const FollowerBody& body, std::uint32_t color, bool isPlayer, double scale) {
  const double r = (isPlayer ? kPlayerIconRadius : kCharacterIconRadius) * std::clamp(scale, 0.5, 2.0);
  const Mat4 m = mm::multiply(builder.placement(body.x, body.y + 0.06, body.z), mm::scaling(r, 1, r));
  builder.instance(iconDiscMesh(), m, rgba(color, 1.0));
}

void drawDropIcon(ModelFrameBuilder& builder, const DropVisual& drop, const WorldPoint& at, double groundY, double nowMs) {
  const double k = dropPopProgress(drop, nowMs);
  if (k >= 1) return;
  const double age = std::max(0.0, (nowMs - drop.addedMs) / 1000.0);
  const double appear = std::clamp(age / kDropAppearSeconds, 0.0, 1.0);
  const double r = kDropIconRadius * (1 - k) * (appear >= 1 ? 1.0 : std::max(0.001, easeOutBack(appear)));
  const Mat4 m = mm::multiply(builder.placement(at.x, groundY + 0.05, at.z), mm::scaling(r, 1, r));
  builder.instance(iconDiscMesh(), m, rgba(kRarityColors[static_cast<std::size_t>(drop.rarity)], 1.0));
}

AnimationClips animationMapping(const json::Value* animations) {
  AnimationClips out;
  if (animations == nullptr || !animations->isObject()) return out;
  for (std::size_t i = 0; i < out.size(); ++i) {
    const json::Value* v = animations->find(EnumNames<AnimationName>::values[i]);
    if (v != nullptr && v->isString()) out[i] = v->asString();
  }
  return out;
}

}  // namespace maprama
