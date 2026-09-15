#include "maprama/CameraMath.hpp"

#include <algorithm>
#include <cmath>

namespace maprama::camera_math {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180.0;
/// MapLibre clamps latitudes to the Web Mercator range.
constexpr double kMaxLatitude = 85.051128779806604;

double tanHalfReferenceFov() { return std::tan(kReferenceFovDeg * kDeg / 2.0); }

double cosLat(double lat) { return std::cos(clampValue(lat, -kMaxLatitude, kMaxLatitude) * kDeg); }

}  // namespace

double clampValue(double value, double lo, double hi) { return std::min(std::max(value, lo), hi); }

double mapLibreMetersPerPixel(double zoom, double lat) {
  return cosLat(lat) * 2.0 * kPi * kMapLibreEarthRadiusM / (kMapLibreTileSize * std::pow(2.0, zoom));
}

double distanceToMapLibreZoom(double distanceMeters, double lat, double viewportHeight) {
  const double height = std::max(viewportHeight, 1.0);
  const double spanMeters = 2.0 * distanceMeters * tanHalfReferenceFov();
  const double metersPerPixel = spanMeters / height;
  return std::log2(cosLat(lat) * 2.0 * kPi * kMapLibreEarthRadiusM / (kMapLibreTileSize * metersPerPixel));
}

double mapLibreZoomToDistance(double zoom, double lat, double viewportHeight) {
  const double height = std::max(viewportHeight, 1.0);
  const double spanMeters = mapLibreMetersPerPixel(zoom, lat) * height;
  return spanMeters / 2.0 / tanHalfReferenceFov();
}

double webZoomToDistance(double webZoom, double lat, double viewportHeight) {
  // engine-web: mpp = 156543.03392 * cos(lat) / 2^zoom; span = mpp * height; distance = span / 2 / tan(fov / 2).
  const double metersPerPixel = (156543.03392 * std::cos(lat * kDeg)) / std::pow(2.0, webZoom);
  return metersPerPixel * std::max(viewportHeight, 1.0) / 2.0 / tanHalfReferenceFov();
}

double normalizeBearing(double degrees) {
  if (!std::isfinite(degrees)) return 0.0;
  double b = std::fmod(degrees, 360.0);
  if (b < 0) b += 360.0;
  if (b >= 360.0) b -= 360.0;
  return b;
}

}  // namespace maprama::camera_math
