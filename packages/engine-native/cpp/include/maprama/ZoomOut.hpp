// Maprama native core — M4 zoom-out game view (`theme.zoomOut`, DESIGN.md §6.7): a port of engine-web's
// `render/zoom-out.ts` (`zoomOutTarget` + `ZoomOutController.update`), fixture-tested against it, plus the
// native level-of-detail switches derived from it.
//
// engine-web: the zoom-out factor `t` eases (6/s) towards `smooth01((distance − 55) / 55)` (0 below D1 = 55 world
// units, 1 from D2 = 110) and is re-applied when it moved by more than 0.003:
//   - `none`: t = 0 (nothing changes);
//   - `keepGameView`: buildings keep their height and colours; fog and shadow ranges grow with t, small street
//     clutter hides from t = 0.5, the haze overlay fades;
//   - `mapColors`: in addition a flat map-colour overlay (ground, water, parks, roads) fades in to 92 % and the
//     buildings shrink to 40 % height (`scaleY = 1 − 0.6 t`).
// Native: the extrusions and the custom layer take `heightScale`, the overlay is a set of MapLibre style layers
// (`WorldStyle.hpp`), and while `t ≥ 0.5` (engine-web's clutter threshold) the custom layer draws its low-detail
// index range (no facade details / roof furniture). Beyond D2 (with hysteresis) characters and drops are drawn as
// flat icon discs instead of skinned models (the draw-call budget of §8; engine-web keeps the 3D models).
#pragma once

#include "maprama/types.hpp"

namespace maprama {

/// engine-web's zoom-out band (world units): the factor starts at D1 and is 1 from D2.
inline constexpr double kZoomOutNearUnits = 55.0;
inline constexpr double kZoomOutFarUnits = 110.0;
/// Characters and drops switch back from icon discs below this fraction of D2 (hysteresis).
inline constexpr double kZoomOutSpriteHysteresis = 0.95;
/// engine-web re-applies the look when the factor moved by more than this.
inline constexpr double kZoomOutApplyEpsilon = 0.003;

/// engine-web `zoomOutTarget`: 0 for `none`, else `smooth01(clamp((distance − 55) / 55, 0, 1))`.
double zoomOutTarget(ZoomOutBehavior behavior, double distanceUnits);

/// What engine-web's `ZoomOutController` applies for its current factor (the last applied values).
struct ZoomOutLook {
  ZoomOutBehavior behavior = ZoomOutBehavior::None;
  /// The applied factor (engine-web `applied`).
  double t = 0.0;
  /// The `mapColors` factor (`t` for `mapColors`, else 0).
  double mapColors = 0.0;
  /// engine-web `scaleY`: building height multiplier.
  double heightScale = 1.0;
  /// Opacity of the flat map-colour overlay (`mt · 0.92`), visible above 0.01.
  double mapOpacity = 0.0;
  bool mapVisible = false;
  /// Fog near / far offsets and the shadow camera extent / far plane (engine-web values; the native engine has
  /// no fog or shadow pass yet, they are kept for parity tests and later milestones).
  double fogNear = 0.0;
  double fogFar = 0.0;
  double shadowExtent = 48.0;
  double shadowFar = 160.0;
  /// engine-web hides small street clutter while `t ≥ 0.5`; the native custom layer draws its low-detail range then.
  bool clutterVisible = true;

  bool lowDetail() const { return !clutterVisible; }
};

class ZoomOutController {
 public:
  /// One frame of engine-web `ZoomOutController.update` (`dt` seconds, `distanceUnits` the camera distance in world
  /// units, `fogNear` / `fogFar` the theme's fog). Returns true when the look was re-applied.
  bool update(double dt, double distanceUnits, ZoomOutBehavior behavior, double fogNear = 0.0, double fogFar = 0.0,
              bool reduceMotion = false);
  /// Forces a re-application on the next update (engine-web: after a theme change).
  void invalidate() { applied_ = -1.0; }
  /// The smoothed factor (engine-web `t`).
  double t() const { return t_; }
  const ZoomOutLook& look() const { return look_; }
  /// Whether the factor still eases towards its target (the session keeps requesting frames): the target is more
  /// than `kZoomOutApplyEpsilon` away from the factor or from the applied value.
  bool settling(double distanceUnits, ZoomOutBehavior behavior) const;
  /// Characters and drops as icon discs: behaviour ≠ `none` and the camera beyond D2 (hysteresis below it).
  bool sprites() const { return sprites_; }
  /// Updates `sprites()` for the camera distance; returns true when it changed.
  bool updateSprites(double distanceUnits, ZoomOutBehavior behavior);

 private:
  double t_ = 0.0;
  double applied_ = -1.0;
  bool haveMode_ = false;
  ZoomOutBehavior mode_ = ZoomOutBehavior::None;
  bool sprites_ = false;
  ZoomOutLook look_;
};

}  // namespace maprama
