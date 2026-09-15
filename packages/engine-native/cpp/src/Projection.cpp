#include "maprama/Projection.hpp"

#include <algorithm>
#include <cmath>
#include <string>

#include "maprama/json.hpp"

namespace maprama {

namespace {

constexpr double kPi = 3.141592653589793;  // Math.PI

/// `range(min, max)` from validate.ts applied to a typed double with path `origin.<field>`.
std::optional<std::string> checkRange(double v, double min, double max, const char* path) {
  if (std::isfinite(v) && v >= min && v <= max) return std::nullopt;
  return std::string(path) + ": expected number in [" + json::numberToString(min) + ", " +
         json::numberToString(max) + "], got " + (std::isfinite(v) ? std::string("number") : json::numberToString(v));
}

}  // namespace

Result<Projection> Projection::create(const ProjectionOptions& options) {
  const LngLat origin = options.origin;
  const double unitMeters = options.unitMeters.value_or(kDefaultUnitMeters);
  if (auto err = checkRange(origin.lng, -180, 180, "origin.lng")) {
    return Result<Projection>::failure("createProjection: " + *err);
  }
  if (auto err = checkRange(origin.lat, -90, 90, "origin.lat")) {
    return Result<Projection>::failure("createProjection: " + *err);
  }
  if (!(std::isfinite(unitMeters) && unitMeters > 0)) {
    return Result<Projection>::failure("createProjection: unitMeters must be a positive finite number, got " +
                                       json::numberToString(unitMeters));
  }
  const double cosLat0 = std::cos((origin.lat * kPi) / 180);
  // Guard the poles so the inverse never divides by zero.
  const double metersPerDegLng = kMetersPerDegreeLng * std::max(cosLat0, 1e-12);
  return Result<Projection>::success(Projection(origin, unitMeters, metersPerDegLng));
}

WorldPoint Projection::toWorld(const LngLat& lngLat) const {
  return WorldPoint{((lngLat.lng - origin_.lng) * metersPerDegLng_) / unitMeters_,
                    (-(lngLat.lat - origin_.lat) * kMetersPerDegreeLat) / unitMeters_};
}

LngLat Projection::toLngLat(const WorldPoint& point) const {
  return LngLat{origin_.lng + (point.x * unitMeters_) / metersPerDegLng_,
                origin_.lat - (point.z * unitMeters_) / kMetersPerDegreeLat};
}

double haversineMeters(const LngLat& a, const LngLat& b) {
  const double toRad = kPi / 180;
  const double dLat = (b.lat - a.lat) * toRad;
  const double dLng = (b.lng - a.lng) * toRad;
  const double sinLat = std::sin(dLat / 2);
  const double sinLng = std::sin(dLng / 2);
  const double s = sinLat * sinLat + std::cos(a.lat * toRad) * std::cos(b.lat * toRad) * sinLng * sinLng;
  return 2 * kEarthRadiusMeters * std::asin(std::min(1.0, std::sqrt(s)));
}

}  // namespace maprama
