#include "maprama/CharacterAnimation.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>

namespace maprama {

namespace {

namespace mm = model_math;

constexpr std::array<AnimationName, 5> kNames{AnimationName::Idle, AnimationName::Walk, AnimationName::Run, AnimationName::Ride,
                                               AnimationName::Wave};

std::size_t idx(AnimationName n) { return static_cast<std::size_t>(n); }

std::string lower(const std::string& s) {
  std::string out = s;
  for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

/// `c.toLowerCase().split(/[|:/.\s_-]+/)`.
std::vector<std::string> segments(const std::string& name) {
  std::vector<std::string> out{std::string()};
  for (const char c : lower(name)) {
    const bool sep = c == '|' || c == ':' || c == '/' || c == '.' || c == '_' || c == '-' || std::isspace(static_cast<unsigned char>(c));
    if (sep) {
      if (!out.back().empty()) out.emplace_back();
    } else {
      out.back().push_back(c);
    }
  }
  return out;
}

Vec3d lerp3(const Vec3d& a, const Vec3d& b, double t) {
  return Vec3d{a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t};
}

}  // namespace

AnimationClips resolveClips(const std::vector<std::string>& clipNames, const AnimationClips& mapping) {
  AnimationClips out;
  const auto has = [&](const std::string& n) { return std::find(clipNames.begin(), clipNames.end(), n) != clipNames.end(); };
  for (const AnimationName name : kNames) {
    const std::optional<std::string>& mapped = mapping[idx(name)];
    if (mapped && has(*mapped)) {
      out[idx(name)] = *mapped;
      continue;
    }
    const std::string want(enumName(name));
    auto found = std::find(clipNames.begin(), clipNames.end(), want);
    if (found == clipNames.end()) {
      found = std::find_if(clipNames.begin(), clipNames.end(), [&](const std::string& c) { return lower(c) == want; });
    }
    if (found == clipNames.end()) {
      found = std::find_if(clipNames.begin(), clipNames.end(), [&](const std::string& c) {
        const std::vector<std::string> parts = segments(c);
        return std::find(parts.begin(), parts.end(), want) != parts.end();
      });
    }
    if (found != clipNames.end()) out[idx(name)] = *found;
  }
  return out;
}

double walkCadence(double speedUnits, double scale) { return speedUnits / (kWalkCadenceSpeed * (scale > 0 ? scale : 1)); }

double clipTimeScale(AnimationName clip, double cadence) {
  return std::clamp(clip == AnimationName::Run ? cadence / 2 : cadence, kMinCadence, kMaxCadence);
}

std::optional<AnimationName> chooseAnimation(TravelMode mode, double speed, const AnimationClips& available, double scale) {
  AnimationName want;
  if (mode == TravelMode::Bike || mode == TravelMode::Car) {
    want = AnimationName::Ride;
  } else if (mode == TravelMode::Plane || mode == TravelMode::Subway) {
    want = AnimationName::Idle;
  } else if (speed < kIdleSpeed) {
    want = AnimationName::Idle;
  } else {
    want = walkCadence(speed, scale) > kRunCadence ? AnimationName::Run : AnimationName::Walk;
  }
  std::vector<AnimationName> chain;
  switch (want) {
    case AnimationName::Ride:
      chain = {AnimationName::Ride, AnimationName::Idle};
      break;
    case AnimationName::Run:
      chain = {AnimationName::Run, AnimationName::Walk, AnimationName::Idle};
      break;
    case AnimationName::Walk:
      chain = {AnimationName::Walk, AnimationName::Run, AnimationName::Idle};
      break;
    case AnimationName::Wave:
      chain = {AnimationName::Wave, AnimationName::Idle};
      break;
    case AnimationName::Idle:
      chain = {AnimationName::Idle};
      break;
  }
  for (const AnimationName n : chain) {
    if (available[idx(n)]) return n;
  }
  return std::nullopt;
}

double headingFromYaw(double yaw) {
  const double d = (std::atan2(std::sin(yaw), -std::cos(yaw)) * 180.0) / mm::kPi;
  return std::fmod(std::fmod(d, 360.0) + 360.0, 360.0);
}

NodePose restPose(const ModelAsset& asset) {
  NodePose p;
  p.translation.reserve(asset.nodes.size());
  p.rotation.reserve(asset.nodes.size());
  p.scale.reserve(asset.nodes.size());
  for (const ModelNode& n : asset.nodes) {
    p.translation.push_back(n.translation);
    p.rotation.push_back(n.rotation);
    p.scale.push_back(n.scale);
  }
  return p;
}

void sampleChannel(const ModelChannel& ch, double t, double out[4]) {
  const std::size_t comps = ch.path == ChannelPath::Rotation ? 4 : 3;
  const bool cubic = ch.interpolation == ChannelInterpolation::CubicSpline;
  const std::size_t stride = comps * (cubic ? 3 : 1);
  const std::size_t valueOffset = cubic ? comps : 0;
  const std::size_t n = ch.times.size();
  const auto copyKey = [&](std::size_t k) {
    for (std::size_t c = 0; c < comps; ++c) out[c] = ch.values[k * stride + valueOffset + c];
  };
  if (n == 0) return;
  if (n == 1 || t <= ch.times[0]) {
    copyKey(0);
    return;
  }
  if (t >= ch.times[n - 1]) {
    copyKey(n - 1);
    return;
  }
  // First key after t (compared in double: a float cast could round t up onto the last key).
  std::size_t i1 = static_cast<std::size_t>(
      std::upper_bound(ch.times.begin(), ch.times.end(), t, [](double value, float key) { return value < static_cast<double>(key); }) -
      ch.times.begin());
  i1 = std::clamp<std::size_t>(i1, 1, n - 1);
  const std::size_t i0 = i1 - 1;
  const double t0 = ch.times[i0], t1 = ch.times[i1];
  const double td = t1 - t0;
  const double p = td > 0 ? (t - t0) / td : 0;
  if (ch.interpolation == ChannelInterpolation::Step) {
    copyKey(i0);
    return;
  }
  if (cubic) {
    // three.js GLTFCubicSplineInterpolant (Hermite spline with glTF tangents).
    const double pp = p * p, ppp = pp * p;
    const double s2 = -2 * ppp + 3 * pp, s3 = ppp - pp, s0 = 1 - s2, s1 = s3 - pp + p;
    const std::size_t o0 = i0 * stride, o1 = i1 * stride;
    for (std::size_t c = 0; c < comps; ++c) {
      const double p0 = ch.values[o0 + comps + c];
      const double m0 = ch.values[o0 + 2 * comps + c] * td;
      const double p1 = ch.values[o1 + comps + c];
      const double m1 = ch.values[o1 + c] * td;
      out[c] = s0 * p0 + s1 * m0 + s2 * p1 + s3 * m1;
    }
    if (comps == 4) {
      const Quat q = mm::normalizeQuat(Quat{out[0], out[1], out[2], out[3]});
      for (std::size_t c = 0; c < 4; ++c) out[c] = q[c];
    }
    return;
  }
  if (comps == 4) {
    const Quat a{ch.values[i0 * 4], ch.values[i0 * 4 + 1], ch.values[i0 * 4 + 2], ch.values[i0 * 4 + 3]};
    const Quat b{ch.values[i1 * 4], ch.values[i1 * 4 + 1], ch.values[i1 * 4 + 2], ch.values[i1 * 4 + 3]};
    const Quat q = mm::slerp(a, b, p);
    for (std::size_t c = 0; c < 4; ++c) out[c] = q[c];
    return;
  }
  for (std::size_t c = 0; c < 3; ++c) {
    const double a = ch.values[i0 * 3 + c], b = ch.values[i1 * 3 + c];
    out[c] = a + (b - a) * p;
  }
}

std::vector<Mat4> poseLocals(const ModelAsset& asset, const NodePose& pose) {
  std::vector<Mat4> locals(asset.nodes.size());
  for (std::size_t i = 0; i < asset.nodes.size(); ++i) {
    const ModelNode& n = asset.nodes[i];
    locals[i] = n.hasMatrix ? n.matrix : mm::compose(pose.translation[i], pose.rotation[i], pose.scale[i]);
  }
  return locals;
}

// ---------------------------------------------------------------------------------------------------
// ModelAnimator
// ---------------------------------------------------------------------------------------------------

ModelAnimator::ModelAnimator(std::shared_ptr<const ModelAsset> asset, const AnimationClips& mapping) : asset_(std::move(asset)), mapping_(mapping) {
  std::vector<std::string> names;
  if (asset_) {
    for (const ModelClip& c : asset_->clips) names.push_back(c.name);
  }
  clips_ = resolveClips(names, mapping_);
}

void ModelAnimator::setMapping(const AnimationClips& mapping) {
  mapping_ = mapping;
  std::vector<std::string> names;
  if (asset_) {
    for (const ModelClip& c : asset_->clips) names.push_back(c.name);
  }
  const AnimationClips next = resolveClips(names, mapping_);
  if (next == clips_) return;
  // engine-web: `mixer.stopAllAction()`, new actions, `current = null`.
  clips_ = next;
  actions_.clear();
  current_.reset();
}

int ModelAnimator::clipIndex(const std::optional<std::string>& name) const {
  if (!asset_ || !name) return -1;
  for (std::size_t i = 0; i < asset_->clips.size(); ++i) {
    if (asset_->clips[i].name == *name) return static_cast<int>(i);
  }
  return -1;
}

ModelAnimator::Action* ModelAnimator::action(int clip) {
  for (Action& a : actions_) {
    if (a.clip == clip) return &a;
  }
  return nullptr;
}

const ModelAnimator::Action* ModelAnimator::action(int clip) const {
  for (const Action& a : actions_) {
    if (a.clip == clip) return &a;
  }
  return nullptr;
}

void ModelAnimator::play(int clip, double crossFade) {
  const int prev = current_ ? clipIndex(clips_[idx(*current_)]) : -1;
  if (clip < 0) {
    if (prev >= 0) {
      Action* p = action(prev);
      if (p != nullptr) {
        p->fading = true;
        p->fadeStart = mixerTime_;
        p->fadeEnd = mixerTime_ + crossFade;
        p->fadeFrom = 1;
        p->fadeTo = 0;
      }
    }
    return;
  }
  Action* next = action(clip);
  if (next == nullptr) {
    actions_.push_back(Action{});
    next = &actions_.back();
    next->clip = clip;
  }
  // reset(): enabled, time 0, fading stopped.
  next->enabled = true;
  next->time = 0;
  next->fading = false;
  const auto schedule = [&](int which, double from, double to) {
    Action* a = action(which);
    if (a == nullptr) return;
    a->fading = true;
    a->fadeStart = mixerTime_;
    a->fadeEnd = mixerTime_ + crossFade;
    a->fadeFrom = from;
    a->fadeTo = to;
  };
  if (prev >= 0) schedule(prev, 1, 0);  // prev.crossFadeTo(next) = prev.fadeOut + next.fadeIn
  schedule(clip, 0, 1);
}

void ModelAnimator::fadeOutAll(double duration) {
  for (Action& a : actions_) {
    if (!a.enabled) continue;
    a.fading = true;
    a.fadeStart = mixerTime_;
    a.fadeEnd = mixerTime_ + duration;
    a.fadeFrom = 1;
    a.fadeTo = 0;
  }
}

void ModelAnimator::setTimeScale(int clip, double timeScale) {
  if (Action* a = action(clip)) a->timeScale = timeScale;
}

double ModelAnimator::evaluateWeight(Action& a, double time) {
  if (!a.enabled) {
    a.effective = 0;
    return 0;
  }
  double w = 1;
  if (a.fading) {
    double v;
    if (time <= a.fadeStart) {
      v = a.fadeFrom;
    } else if (time >= a.fadeEnd) {
      v = a.fadeTo;
    } else {
      v = a.fadeFrom + (a.fadeTo - a.fadeFrom) * (time - a.fadeStart) / (a.fadeEnd - a.fadeStart);
    }
    w *= v;
    if (time > a.fadeEnd) {
      a.fading = false;
      if (v == 0) a.enabled = false;
    }
  }
  a.effective = w;
  return w;
}

void ModelAnimator::advance(double dt) {
  if (!asset_) return;
  mixerTime_ += dt;
  for (Action& a : actions_) {
    if (!a.enabled) {
      evaluateWeight(a, mixerTime_);
      continue;
    }
    a.time += dt * a.timeScale;
    const double duration = asset_->clips[static_cast<std::size_t>(a.clip)].duration;
    if (duration > 0 && (a.time >= duration || a.time < 0)) a.time -= duration * std::floor(a.time / duration);
    evaluateWeight(a, mixerTime_);
  }
}

void ModelAnimator::update(double dt, TravelMode mode, double speed, double scale, double crossFade) {
  if (!asset_) return;
  const std::optional<AnimationName> want = chooseAnimation(mode, speed, clips_, scale);
  if (want != current_) {
    const int next = want ? clipIndex(clips_[idx(*want)]) : -1;
    play(next, crossFade);
    current_ = want;
  }
  if (current_ == AnimationName::Walk || current_ == AnimationName::Run) {
    const int c = clipIndex(clips_[idx(*current_)]);
    if (c >= 0) setTimeScale(c, clipTimeScale(*current_, walkCadence(speed, scale)));
  }
  advance(dt);
}

NodePose ModelAnimator::pose() const {
  NodePose rest = restPose(*asset_);
  if (actions_.empty()) return rest;
  const std::size_t n = asset_->nodes.size();
  NodePose acc = rest;
  std::vector<double> wt(n, 0), wr(n, 0), ws(n, 0);
  double v[4];
  for (const Action& a : actions_) {
    if (!(a.effective > 0)) continue;
    const ModelClip& clip = asset_->clips[static_cast<std::size_t>(a.clip)];
    for (const ModelChannel& ch : clip.channels) {
      if (ch.node < 0 || static_cast<std::size_t>(ch.node) >= n) continue;
      const std::size_t node = static_cast<std::size_t>(ch.node);
      sampleChannel(ch, a.time, v);
      if (ch.path == ChannelPath::Rotation) {
        const Quat q{v[0], v[1], v[2], v[3]};
        if (wr[node] == 0) {
          acc.rotation[node] = q;
          wr[node] = a.effective;
        } else {
          wr[node] += a.effective;
          acc.rotation[node] = mm::slerp(acc.rotation[node], q, a.effective / wr[node]);
        }
      } else {
        const Vec3d x{v[0], v[1], v[2]};
        std::vector<double>& w = ch.path == ChannelPath::Translation ? wt : ws;
        Vec3d& target = ch.path == ChannelPath::Translation ? acc.translation[node] : acc.scale[node];
        if (w[node] == 0) {
          target = x;
          w[node] = a.effective;
        } else {
          w[node] += a.effective;
          target = lerp3(target, x, a.effective / w[node]);
        }
      }
    }
  }
  // PropertyMixer.apply: the rest pose fills the missing weight.
  for (std::size_t i = 0; i < n; ++i) {
    if (wt[i] > 0 && wt[i] < 1) acc.translation[i] = lerp3(acc.translation[i], rest.translation[i], 1 - wt[i]);
    if (ws[i] > 0 && ws[i] < 1) acc.scale[i] = lerp3(acc.scale[i], rest.scale[i], 1 - ws[i]);
    if (wr[i] > 0 && wr[i] < 1) acc.rotation[i] = mm::slerp(acc.rotation[i], rest.rotation[i], 1 - wr[i]);
  }
  return acc;
}

std::vector<Mat4> ModelAnimator::palette() const {
  if (!asset_) return {mm::identity()};
  return jointPalette(asset_->joints, globalTransforms(asset_->nodes, poseLocals(*asset_, pose())));
}

double ModelAnimator::weight(int clip) const {
  const Action* a = action(clip);
  return a != nullptr ? a->effective : 0.0;
}

double ModelAnimator::actionTime(int clip) const {
  const Action* a = action(clip);
  return a != nullptr ? a->time : 0.0;
}

}  // namespace maprama
