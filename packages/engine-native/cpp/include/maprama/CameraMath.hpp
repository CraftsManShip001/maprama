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

}  // namespace maprama::camera_math
