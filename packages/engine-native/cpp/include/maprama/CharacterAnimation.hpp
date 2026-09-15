// Maprama native core — M3b character animation: pure ports of engine-web's clip matching and cadence rules
// (`game/characters.ts`: `resolveClips`, `chooseAnimation`, `walkCadence`, `clipTimeScale`, `headingFromYaw`,
// fixture-conformance tested), glTF clip sampling (TRS channels: linear with quaternion slerp, step, cubic
// spline; three.js interpolant semantics) and `ModelAnimator`, a port of the part of three.js' `AnimationMixer`
// engine-web uses: looping actions, `crossFadeTo` / `fadeIn` / `fadeOut`, per-action time scale, weighted
// accumulation with the rest pose filling the remaining weight. The animator produces the joint palette
// (≤ `kMaxJoints` matrices) the GPU skins with (DESIGN.md §6.4).
#pragma once

#include <array>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "maprama/ModelMesh.hpp"
#include "maprama/types.hpp"

namespace maprama {

/// engine-web `CHARACTER_HEIGHT`: glTF characters are scaled to it (world units) times `CharacterSpec.scale`.
inline constexpr double kCharacterHeight = 1.9;
/// engine-web `WALK_CADENCE_SPEED`, `MIN_CADENCE`, `MAX_CADENCE`, `RUN_CADENCE`, `IDLE_SPEED`.
inline constexpr double kWalkCadenceSpeed = 3.2;
inline constexpr double kMinCadence = 0.5;
inline constexpr double kMaxCadence = 2.2;
inline constexpr double kRunCadence = 1.6;
inline constexpr double kIdleSpeed = 1e-3;
/// Clip cross-fade (DESIGN.md §6.4: 150 ms; engine-web's `CROSSFADE` is 0.25 s).
inline constexpr double kCrossFadeSeconds = 0.15;

/// Clip names by conventional animation (`AnimationName` order: idle, walk, run, ride, wave).
using AnimationClips = std::array<std::optional<std::string>, 5>;

/// engine-web `resolveClips`: an explicit mapping wins when the clip exists; otherwise a clip named exactly like
/// the convention, then case-insensitively, then a case-insensitive name segment (`"Armature|Walk"`, `"run_fast"`).
AnimationClips resolveClips(const std::vector<std::string>& clipNames, const AnimationClips& mapping);

/// engine-web `chooseAnimation`: the animation for a mode and speed (world units / s), with fallbacks to the
/// available clips; nullopt when none fits.
std::optional<AnimationName> chooseAnimation(TravelMode mode, double speed, const AnimationClips& available, double scale = 1);

/// engine-web `walkCadence`: speed relative to the natural walking pace of a character of `scale`.
double walkCadence(double speedUnits, double scale = 1);

/// engine-web `clipTimeScale`: playback rate of the `walk` / `run` clip for a cadence, clamped to [0.5, 2.2].
double clipTimeScale(AnimationName clip, double cadence);

/// engine-web `headingFromYaw`: degrees clockwise from north for a yaw `atan2(dx, dz)` (+z south).
double headingFromYaw(double yaw);

/// TRS of every node of an asset.
struct NodePose {
  std::vector<Vec3d> translation;
  std::vector<Quat> rotation;
  std::vector<Vec3d> scale;
};

NodePose restPose(const ModelAsset& asset);

/// One channel at clip time `t` (three.js interpolants: clamped outside the keys). Writes 3 or 4 numbers.
void sampleChannel(const ModelChannel& channel, double t, double out[4]);

/// Local matrices of a pose (nodes given as a matrix keep it).
std::vector<Mat4> poseLocals(const ModelAsset& asset, const NodePose& pose);

/// The subset of three.js `AnimationMixer` / `AnimationAction` engine-web uses, over one asset's clips.
class ModelAnimator {
 public:
  ModelAnimator() = default;
  ModelAnimator(std::shared_ptr<const ModelAsset> asset, const AnimationClips& mapping);

  const std::shared_ptr<const ModelAsset>& asset() const { return asset_; }
  const AnimationClips& clips() const { return clips_; }
  std::optional<AnimationName> current() const { return current_; }

  /// engine-web `Character.refreshClips`: re-resolves the clips after `CharacterSpec.animations` changed (a
  /// no-op when they resolve the same; otherwise every action stops and the next update starts fresh).
  void setMapping(const AnimationClips& mapping);

  /// engine-web `Character.animate` (model branch): `chooseAnimation(mode, speed)`, a cross-fade when the choice
  /// changes, the walk / run cadence as time scale, then `mixer.update(dt)`.
  void update(double dt, TravelMode mode, double speed, double scale, double crossFade = kCrossFadeSeconds);

  /// Mixer primitives (three.js semantics), used by `update` and the tests.
  /// `reset()` + `play()` of the clip's action, then `prev.crossFadeTo(next, duration)` / `next.fadeIn(duration)`.
  void play(int clip, double crossFade);
  /// `fadeOut(duration)` of every enabled action.
  void fadeOutAll(double duration);
  void setTimeScale(int clip, double timeScale);
  /// `mixer.update(dt)`: advances the mixer and action times and the fades.
  void advance(double dt);

  /// Current pose (rest pose where no enabled action with weight > 0 animates a property).
  NodePose pose() const;
  /// Palette of the current pose (`asset()->joints.size()` matrices).
  std::vector<Mat4> palette() const;
  /// Effective weight of a clip's action (0 when it is not playing).
  double weight(int clip) const;
  double actionTime(int clip) const;

 private:
  struct Action {
    int clip = -1;
    double time = 0;
    double timeScale = 1;
    bool enabled = true;
    bool fading = false;
    double fadeStart = 0, fadeEnd = 0, fadeFrom = 1, fadeTo = 1;
    /// Effective weight after the last `advance`.
    double effective = 1;
  };
  Action* action(int clip);
  const Action* action(int clip) const;
  int clipIndex(const std::optional<std::string>& name) const;
  double evaluateWeight(Action& a, double time);

  std::shared_ptr<const ModelAsset> asset_;
  AnimationClips mapping_;
  AnimationClips clips_;
  std::optional<AnimationName> current_;
  /// Actions in activation order (three.js accumulates in that order).
  std::vector<Action> actions_;
  double mixerTime_ = 0;
};

}  // namespace maprama
