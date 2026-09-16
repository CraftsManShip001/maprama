// Maprama native core — conversions between the protocol camera (`CameraSpec` / `CameraState`, meters)
// and the MapLibre camera (512-px tile zoom levels).
//
// Framing parity with engine-web (DESIGN.md §2.1):
//   engine-web orbits a perspective camera with a 40° vertical field of view at `distance` meters from
//   the target; MapLibre uses a fixed 36.87° field of view and expresses scale as a zoom level. The core
//   maps one onto the other by matching the ground scale at the target: a protocol `distance` d shows the
//   same ground span at the target as engine-web does (2 · d · tan 20° over the viewport height), so both
//   engines frame the same area for the same `CameraState`. With that convention the protocol `zoom`
//   (web-map zoom on 256-px tiles, engine-web's `zoomToMeters`) is exactly MapLibre zoom + 1.
#pragma once

#include <cstdint>
#include <vector>

#include "maprama/MapAdapter.hpp"
#include "maprama/types.hpp"

namespace maprama::camera_math {

/// engine-web's `PerspectiveCamera` vertical field of view (degrees) — the reference frustum for `distance`.
inline constexpr double kReferenceFovDeg = 40.0;
/// MapLibre's WGS84 equatorial radius (`mbgl::util::EARTH_RADIUS_M`).
inline constexpr double kMapLibreEarthRadiusM = 6378137.0;
/// MapLibre tile size in density-independent pixels.
inline constexpr double kMapLibreTileSize = 512.0;
/// engine-web `DIST_MIN` / `DIST_MAX` in world units (multiplied by the world's `unitMeters`).
inline constexpr double kDistanceMinUnits = 14.0;
inline constexpr double kDistanceMaxUnits = 150.0;
/// engine-web `DIST_HARD_MIN` / `DIST_HARD_MAX`: the range an app's `minDistanceMeters` /
/// `maxDistanceMeters` are clamped into, in world units.
inline constexpr double kDistanceHardMinUnits = 2.0;
inline constexpr double kDistanceHardMaxUnits = 1000.0;
/// engine-web `PITCH_MIN` / `PITCH_MAX` (degrees).
inline constexpr double kPitchMin = 0.0;
inline constexpr double kPitchMax = 60.0;
/// engine-web `DEFAULT_ANIMATION_MS` (`animate: true`).
inline constexpr double kDefaultAnimationMs = 600.0;
/// engine-web `DEFAULT_ORBIT` applied on world load (distance in world units).
inline constexpr double kDefaultDistanceUnits = 36.0;
inline constexpr double kDefaultPitch = 50.0;
inline constexpr double kDefaultBearing = 28.0;

/// Meters per density-independent pixel at `lat` for a MapLibre zoom level.
double mapLibreMetersPerPixel(double zoom, double lat);

/// Protocol `distance` (meters) -> MapLibre zoom for a viewport `viewportHeight` dp tall.
double distanceToMapLibreZoom(double distanceMeters, double lat, double viewportHeight);
/// MapLibre zoom -> protocol `distance` (meters). Inverse of `distanceToMapLibreZoom`.
double mapLibreZoomToDistance(double zoom, double lat, double viewportHeight);

/// Protocol `zoom` (web-map zoom, 256-px tiles) -> `distance` meters: engine-web's `zoomToMeters`.
double webZoomToDistance(double webZoom, double lat, double viewportHeight);

/// Wraps degrees into [0, 360) (the `CameraState.bearing` range).
double normalizeBearing(double degrees);

double clampValue(double value, double lo, double hi);

// ---- fitBounds (port of engine-web `core/fit-bounds.ts`) -------------------------------------------
//
// Scale free: the whole input is one length unit, so the core runs it in meters (its `CameraState`
// distance) where engine-web runs it in world units. Fixture-compared step for step.

/// engine-web `FIT_ITERATIONS`.
inline constexpr int kFitIterations = 24;

/// engine-web `FitOrientation`.
enum class FitOrientation : std::uint8_t { Auto, Keep, Reset };

/// Padding kept free inside the viewport, in density-independent pixels.
struct FitPadding {
  double top = 0.0;
  double right = 0.0;
  double bottom = 0.0;
  double left = 0.0;
};

/// A ground point on the camera's plane, in the same length unit as the distances.
struct FitPoint {
  double x = 0.0;
  double z = 0.0;
};

struct FitBoundsInput {
  std::vector<FitPoint> corners;
  double width = 1.0;
  double height = 1.0;
  FitPadding padding;
  double fovDeg = kReferenceFovDeg;
  double pitch = 0.0;
  double bearing = 0.0;
  double minDistance = 0.0;
  double maxDistance = 0.0;
  double startDistance = 0.0;
};

struct FitBoundsOutput {
  double x = 0.0;
  double z = 0.0;
  double distance = 0.0;
  double pitch = 0.0;
  double bearing = 0.0;
  bool fitted = false;
  bool distanceLimited = false;
};

/// engine-web `fitBoundsOrbit`: frames `corners` inside the padded rectangle at the given orientation.
FitBoundsOutput fitBoundsOrbit(const FitBoundsInput& input);

/// engine-web `fitBounds`: `fitBoundsOrbit` plus the `orientation` rule.
FitBoundsOutput fitBounds(const FitBoundsInput& input, FitOrientation orientation);

// ---- camera:idle viewport (port of engine-web `CameraController.groundCorners`) --------------------

/// The visible area of a viewport once `inset` (`ui.contentInset`, dp) is taken off it. Insets that
/// would leave nothing are scaled down so at least one dp stays visible (engine-web `visibleAxis`).
struct VisibleRect {
  double x = 0.0;
  double y = 0.0;
  double width = 1.0;
  double height = 1.0;
};

VisibleRect visibleRect(double width, double height, const FitPadding& inset);

/// The four ground corners of the visible area, **relative to the camera centre** and in the same
/// length unit as `distance`, in `[top-left, top-right, bottom-right, bottom-left]` order.
///
/// A corner whose ray runs past the horizon — it misses the ground, or hits it farther than
/// `maxDistance` from the centre — is pulled back to `maxDistance` along the same ground direction
/// (protocol `CAMERA_IDLE_HORIZON_FACTOR`), so the quad is always usable.
std::vector<FitPoint> visibleGroundCorners(double width, double height, const FitPadding& inset, double distance,
                                           double pitch, double bearing, double maxDistance,
                                           double fovDeg = kReferenceFovDeg);

// ---- content inset (port of engine-web `CameraController.insetShift`) ------------------------------

/// Ground offset from the point under the centre of the **whole** viewport to the point under the centre of
/// the **visible area** (the viewport minus `inset`), in the same length unit as `distance`.
///
/// `ui.contentInset` means "the app's chrome covers these bands": the protocol camera centre must end up
/// under the centre of what is left. The camera pose is a pure translation in x / z, so looking at
/// `centre − shift` puts `centre` under the visible centre exactly, with no iteration — which is how
/// engine-web does it, and why the native engine moves the MapLibre camera instead of setting MapLibre's own
/// edge insets (the core's own projection then needs no off-axis frustum).
///
/// `{0, 0}` without an inset.
FitPoint insetShift(double width, double height, const FitPadding& inset, double distance, double pitch,
                    double bearing, double fovDeg = kReferenceFovDeg);

}  // namespace maprama::camera_math
