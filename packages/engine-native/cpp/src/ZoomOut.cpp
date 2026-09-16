#include "maprama/ZoomOut.hpp"

#include <algorithm>
#include <cmath>

// Same operation order as engine-web (no fused multiply-adds), like the procedural generators.
#pragma clang fp contract(off)

namespace maprama {

namespace {

double clamp01(double x) { return std::min(1.0, std::max(0.0, x)); }

/// engine-web `smooth01`.
double smooth01(double x) { return x * x * (3 - 2 * x); }

}  // namespace

double zoomOutTarget(ZoomOutBehavior behavior, double distanceUnits) {
  if (behavior == ZoomOutBehavior::None) return 0.0;
  return smooth01(clamp01((distanceUnits - kZoomOutNearUnits) / kZoomOutNearUnits));
}

double zoomOutRangeScale(double distanceUnits) {
  return std::max(1.0, distanceUnits / kZoomOutRangeRefUnits);
}

bool ZoomOutController::update(double dt, double distanceUnits, ZoomOutBehavior behavior, double fogNear, double fogFar,
                               bool reduceMotion) {
  const double target = zoomOutTarget(behavior, distanceUnits);
  t_ += (target - t_) * (reduceMotion ? 1.0 : std::min(1.0, dt * 6));
  const double t = t_;
  const double mt = behavior == ZoomOutBehavior::MapColors ? t : 0.0;
  const double k = zoomOutRangeScale(distanceUnits);
  if (!(std::fabs(t - applied_) > kZoomOutApplyEpsilon || std::fabs(k - appliedScale_) > kZoomOutScaleEpsilon ||
        applied_ < 0 || !haveMode_ || mode_ != behavior)) {
    return false;
  }
  applied_ = t;
  appliedScale_ = k;
  mode_ = behavior;
  haveMode_ = true;
  look_.behavior = behavior;
  look_.t = t;
  look_.mapColors = mt;
  look_.mapOpacity = mt * 0.92;
  look_.mapVisible = mt > 0.01;
  look_.heightScale = 1 - mt * 0.6;
  look_.rangeScale = k;
  look_.fogNear = (fogNear + t * 110) * k;
  look_.fogFar = (fogFar + t * 260) * k;
  look_.shadowExtent = (48 + t * 95) * k;
  look_.shadowFar = (160 + t * 200) * k;
  look_.clutterVisible = t < 0.5;
  return true;
}

bool ZoomOutController::settling(double distanceUnits, ZoomOutBehavior behavior) const {
  const double target = zoomOutTarget(behavior, distanceUnits);
  if (haveMode_ && mode_ != behavior) return true;
  if (std::fabs(zoomOutRangeScale(distanceUnits) - appliedScale_) > kZoomOutScaleEpsilon) return true;
  return std::fabs(target - t_) > kZoomOutApplyEpsilon || std::fabs(target - applied_) > kZoomOutApplyEpsilon;
}

bool ZoomOutController::updateSprites(double distanceUnits, ZoomOutBehavior behavior) {
  bool next = sprites_;
  if (behavior == ZoomOutBehavior::None) {
    next = false;
  } else if (distanceUnits >= kZoomOutFarUnits) {
    next = true;
  } else if (distanceUnits < kZoomOutFarUnits * kZoomOutSpriteHysteresis) {
    next = false;
  }
  if (next == sprites_) return false;
  sprites_ = next;
  return true;
}

}  // namespace maprama
