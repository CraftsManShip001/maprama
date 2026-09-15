// Maprama native core — local tangent-plane projection.
//
// Port of `createProjection` / `haversineMeters` (packages/protocol/src/geo.ts)
// with identical math and operation order:
//   x = ((lng - lng0) * 111320 * max(cos(lat0), 1e-12)) / unitMeters
//   z = (-(lat - lat0) * 110540) / unitMeters
// +x = east, -z = north, 1 world unit = `unitMeters` meters (8 by default).
// Verified against cpp/tests/fixtures/projection.json within 1e-6.
#pragma once

#include <optional>

#include "maprama/types.hpp"

namespace maprama {

/// `DEFAULT_UNIT_METERS`.
inline constexpr double kDefaultUnitMeters = 8.0;
/// `METERS_PER_DEGREE_LNG` (at the equator).
inline constexpr double kMetersPerDegreeLng = 111320.0;
/// `METERS_PER_DEGREE_LAT`.
inline constexpr double kMetersPerDegreeLat = 110540.0;
/// `EARTH_RADIUS_METERS`.
inline constexpr double kEarthRadiusMeters = 6371008.8;

struct ProjectionOptions {
  /// Geographic coordinate that maps to world `{x: 0, z: 0}`.
  LngLat origin;
  /// Meters per world unit; `kDefaultUnitMeters` when absent. Must be a positive finite number.
  std::optional<double> unitMeters;
};

/// Converts between geographic coordinates, world units and meters. Immutable and thread-safe.
class Projection {
 public:
  /// Fails (instead of throwing RangeError) with the exact TS message, e.g.
  /// `createProjection: unitMeters must be a positive finite number, got 0`.
  static Result<Projection> create(const ProjectionOptions& options);

  const LngLat& origin() const { return origin_; }
  double unitMeters() const { return unitMeters_; }

  WorldPoint toWorld(const LngLat& lngLat) const;
  LngLat toLngLat(const WorldPoint& point) const;
  double metersToUnits(double meters) const { return meters / unitMeters_; }
  double unitsToMeters(double units) const { return units * unitMeters_; }

 private:
  Projection(LngLat origin, double unitMeters, double metersPerDegLng)
      : origin_(origin), unitMeters_(unitMeters), metersPerDegLng_(metersPerDegLng) {}

  LngLat origin_;
  double unitMeters_;
  double metersPerDegLng_;
};

/// Great-circle distance in meters (haversine, `kEarthRadiusMeters`).
double haversineMeters(const LngLat& a, const LngLat& b);

}  // namespace maprama
