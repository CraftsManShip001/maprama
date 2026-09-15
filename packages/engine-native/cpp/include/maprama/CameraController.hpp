// Maprama native core — camera, gestures, screen <-> world mapping, overlay anchors.
//
// Commands: setCamera, setOverlayAnchors, request{project}, request{unproject}.
// Events:   camera:change (subscription topic), overlay:positions, map:press, building:press.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "maprama/MessageSink.hpp"
#include "maprama/types.hpp"

namespace maprama {

class CharacterSystem;
class Projection;

struct Viewport {
  /// Density-independent pixels.
  double width = 0.0;
  double height = 0.0;
  double pixelRatio = 1.0;
};

class CameraController {
 public:
  virtual ~CameraController() = default;

  virtual void setViewport(const Viewport& viewport) = 0;
  virtual void setProjection(const Projection& projection) = 0;

  /// Unset fields keep their value. `distance` wins over `zoom`; `follow` locks the target to a character.
  virtual void setCamera(const CameraSpec& camera) = 0;
  virtual CameraState state() const = 0;

  /// Mirrors the MapLibre `mbgl::CameraOptions` of the embedded map (the maprama layer shares its matrices).
  virtual double mapLibreZoom() const = 0;

  /// `request{project}`: `visible` false when off-screen or behind the camera.
  virtual ScreenPoint project(const LngLat& coordinate) const = 0;
  /// `request{unproject}`: ray-ground intersection; nullopt when the ray misses the ground.
  virtual std::optional<LngLat> unproject(double x, double y) const = 0;

  /// Replaces overlay anchors; `overlay:positions` is emitted while anchors exist and the view changed.
  virtual void setOverlayAnchors(std::vector<OverlayAnchor> anchors) = 0;

  // Gestures (platform recognisers forward normalised deltas on the main thread -> core queue).
  virtual void pan(double dx, double dy) = 0;
  virtual void pinch(double scale, double focusX, double focusY) = 0;
  virtual void rotate(double degrees) = 0;
  virtual void tilt(double degrees) = 0;

  /// Tap: hit-tests buildings (maprama layer picking) and emits `building:press` or `map:press`.
  virtual void tap(double x, double y, EventEmitter& events) = 0;

  /// Advances animations / follow; emits `overlay:positions` when needed.
  virtual void update(double dtSeconds, const CharacterSystem& characters, EventEmitter& events) = 0;
};

}  // namespace maprama
