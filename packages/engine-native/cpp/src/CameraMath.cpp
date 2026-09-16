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

namespace {

/// The camera frame three's `lookAt` builds for an orbit (engine-web `basisFor`).
struct Basis {
  double cx, cy, cz;
  double rx, ry, rz;  // right
  double ux, uy, uz;  // up
  double bx, by, bz;  // backward (z axis = eye - target)
};

Basis basisFor(double x, double z, double distance, double pitchDeg, double bearingDeg) {
  const double p = pitchDeg * kDeg, b = bearingDeg * kDeg, h = distance * std::sin(p);
  const double cx = x - std::sin(b) * h, cy = distance * std::cos(p), cz = z + std::cos(b) * h;
  const double upx = std::sin(b), upy = 0.0, upz = -std::cos(b);
  double zx = cx - x, zy = cy, zz = cz - z;
  double zl = std::sqrt(zx * zx + zy * zy + zz * zz);
  if (zl == 0.0) zl = 1.0;
  zx /= zl; zy /= zl; zz /= zl;
  double xx = upy * zz - upz * zy, xy = upz * zx - upx * zz, xz = upx * zy - upy * zx;
  double xl = std::sqrt(xx * xx + xy * xy + xz * xz);
  if (xl == 0.0) xl = 1.0;
  xx /= xl; xy /= xl; xz /= xl;
  const double yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return {cx, cy, cz, xx, xy, xz, yx, yy, yz, zx, zy, zz};
}

struct Projected {
  double x = 0.0;
  double y = 0.0;
  bool ahead = false;
};

Projected project(const Basis& b, double px, double py, double pz, double width, double height, double tanHalf) {
  const double vx = px - b.cx, vy = py - b.cy, vz = pz - b.cz;
  const double cxv = vx * b.rx + vy * b.ry + vz * b.rz;
  const double cyv = vx * b.ux + vy * b.uy + vz * b.uz;
  const double czv = vx * b.bx + vy * b.by + vz * b.bz;
  const double depth = -czv;
  if (!(depth > 1e-9)) return {};
  const double aspect = width / height;
  const double ndcX = cxv / (aspect * tanHalf * depth), ndcY = cyv / (tanHalf * depth);
  return {(ndcX * 0.5 + 0.5) * width, (-ndcY * 0.5 + 0.5) * height, true};
}

bool groundAt(const Basis& b, double px, double py, double width, double height, double tanHalf, FitPoint* out) {
  const double aspect = width / height;
  const double ndcX = (px / width) * 2 - 1, ndcY = -(py / height) * 2 + 1;
  const double dcx = ndcX * aspect * tanHalf, dcy = ndcY * tanHalf, dcz = -1.0;
  const double dx = b.rx * dcx + b.ux * dcy + b.bx * dcz;
  const double dy = b.ry * dcx + b.uy * dcy + b.by * dcz;
  const double dz = b.rz * dcx + b.uz * dcy + b.bz * dcz;
  if (std::fabs(dy) < 1e-9) return false;
  const double t = -b.cy / dy;
  if (!(t > 0)) return false;
  out->x = b.cx + dx * t;
  out->z = b.cz + dz * t;
  return true;
}

/// engine-web `enclosed`.
bool enclosed(const std::vector<FitPoint>& corners, double cx, double cz, double d, const FitBoundsInput& in,
              double tanHalf, double x0, double y0, double rw, double rh) {
  const Basis basis = basisFor(cx, cz, d, in.pitch, in.bearing);
  constexpr double eps = 0.5;
  for (const FitPoint& c : corners) {
    const Projected s = project(basis, c.x, 0.0, c.z, in.width, in.height, tanHalf);
    if (!s.ahead) return false;
    if (s.x < x0 - eps || s.x > x0 + rw + eps || s.y < y0 - eps || s.y > y0 + rh + eps) return false;
  }
  return true;
}

}  // namespace

FitBoundsOutput fitBoundsOrbit(const FitBoundsInput& input) {
  const double tanHalf = std::tan((input.fovDeg * kDeg) / 2.0);
  const double x0 = input.padding.left, y0 = input.padding.top;
  const double rw = std::max(1.0, input.width - input.padding.left - input.padding.right);
  const double rh = std::max(1.0, input.height - input.padding.top - input.padding.bottom);
  const double rectCx = x0 + rw / 2, rectCy = y0 + rh / 2;

  double cx = 0.0, cz = 0.0;
  for (const FitPoint& c : input.corners) {
    cx += c.x;
    cz += c.z;
  }
  const double n = static_cast<double>(std::max<std::size_t>(1, input.corners.size()));
  cx /= n;
  cz /= n;

  double d = clampValue(input.startDistance, input.minDistance, input.maxDistance);
  double raw = d;
  for (int i = 0; i < kFitIterations; i++) {
    const Basis basis = basisFor(cx, cz, d, input.pitch, input.bearing);
    double minX = 1e300, minY = 1e300, maxX = -1e300, maxY = -1e300;
    bool behind = false;
    for (const FitPoint& c : input.corners) {
      const Projected s = project(basis, c.x, 0.0, c.z, input.width, input.height, tanHalf);
      if (!s.ahead) {
        behind = true;
        break;
      }
      minX = std::min(minX, s.x);
      maxX = std::max(maxX, s.x);
      minY = std::min(minY, s.y);
      maxY = std::max(maxY, s.y);
    }
    if (behind) {
      raw = d * 2;
      d = clampValue(raw, input.minDistance, input.maxDistance);
      if (d == input.maxDistance && raw > input.maxDistance) break;
      continue;
    }
    const double scale = std::min(rw / std::max(1e-6, maxX - minX), rh / std::max(1e-6, maxY - minY));
    raw = d / scale;
    d = clampValue(raw, input.minDistance, input.maxDistance);
    const Basis moved = basisFor(cx, cz, d, input.pitch, input.bearing);
    FitPoint at, want;
    if (groundAt(moved, (minX + maxX) / 2, (minY + maxY) / 2, input.width, input.height, tanHalf, &at) &&
        groundAt(moved, rectCx, rectCy, input.width, input.height, tanHalf, &want)) {
      cx += at.x - want.x;
      cz += at.z - want.z;
    }
  }

  FitBoundsOutput out;
  out.x = cx;
  out.z = cz;
  out.distance = d;
  out.pitch = input.pitch;
  out.bearing = input.bearing;
  out.fitted = enclosed(input.corners, cx, cz, d, input, tanHalf, x0, y0, rw, rh);
  out.distanceLimited = raw < input.minDistance - 1e-9 || raw > input.maxDistance + 1e-9;
  return out;
}

FitBoundsOutput fitBounds(const FitBoundsInput& input, FitOrientation orientation) {
  if (orientation == FitOrientation::Reset) {
    FitBoundsInput reset = input;
    reset.pitch = 0.0;
    reset.bearing = 0.0;
    return fitBoundsOrbit(reset);
  }
  const FitBoundsOutput kept = fitBoundsOrbit(input);
  if (orientation == FitOrientation::Keep || kept.fitted) return kept;
  FitBoundsInput reset = input;
  reset.pitch = 0.0;
  reset.bearing = 0.0;
  const FitBoundsOutput out = fitBoundsOrbit(reset);
  return out.fitted ? out : kept;
}

namespace {

/// engine-web `visibleAxis`: one axis of the viewport split into "before the visible area" and its length.
void splitAxis(double size, double before, double after, double* start, double* length) {
  const double a = std::max(0.0, before), b = std::max(0.0, after);
  const double total = a + b;
  if (total <= 0.0 || size <= 1.0) {
    *start = 0.0;
    *length = std::max(1.0, size);
    return;
  }
  const double k = total > size - 1.0 ? (size - 1.0) / total : 1.0;
  *start = a * k;
  *length = std::max(1.0, size - total * k);
}

/// engine-web `CameraController.groundOrClamped`, with the camera target at the origin.
FitPoint groundOrClamped(const Basis& basis, double px, double py, double width, double height, double tanHalf,
                         double maxDistance) {
  const double limit = std::max(1e-6, maxDistance);
  FitPoint hit;
  if (groundAt(basis, px, py, width, height, tanHalf, &hit)) {
    const double d = std::sqrt(hit.x * hit.x + hit.z * hit.z);
    if (d <= limit) return hit;
    return FitPoint{hit.x / d * limit, hit.z / d * limit};
  }
  // Above the horizon: `limit` along the ray's ground direction.
  const double aspect = width / height;
  const double ndcX = (px / width) * 2 - 1, ndcY = -(py / height) * 2 + 1;
  const double dcx = ndcX * aspect * tanHalf, dcy = ndcY * tanHalf, dcz = -1.0;
  const double dx = basis.rx * dcx + basis.ux * dcy + basis.bx * dcz;
  const double dz = basis.rz * dcx + basis.uz * dcy + basis.bz * dcz;
  double hl = std::sqrt(dx * dx + dz * dz);
  if (hl == 0.0) hl = 1.0;
  return FitPoint{dx / hl * limit, dz / hl * limit};
}

}  // namespace

VisibleRect visibleRect(double width, double height, const FitPadding& inset) {
  VisibleRect r;
  splitAxis(std::max(1.0, width), inset.left, inset.right, &r.x, &r.width);
  splitAxis(std::max(1.0, height), inset.top, inset.bottom, &r.y, &r.height);
  return r;
}

std::vector<FitPoint> visibleGroundCorners(double width, double height, const FitPadding& inset, double distance,
                                           double pitch, double bearing, double maxDistance, double fovDeg) {
  const double w = std::max(1.0, width), h = std::max(1.0, height);
  const double tanHalf = std::tan((fovDeg * kDeg) / 2.0);
  const Basis basis = basisFor(0.0, 0.0, distance, pitch, bearing);
  const VisibleRect r = visibleRect(w, h, inset);
  const double x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
  return {
      groundOrClamped(basis, x0, y0, w, h, tanHalf, maxDistance),
      groundOrClamped(basis, x1, y0, w, h, tanHalf, maxDistance),
      groundOrClamped(basis, x1, y1, w, h, tanHalf, maxDistance),
      groundOrClamped(basis, x0, y1, w, h, tanHalf, maxDistance),
  };
}

double normalizeBearing(double degrees) {
  if (!std::isfinite(degrees)) return 0.0;
  double b = std::fmod(degrees, 360.0);
  if (b < 0) b += 360.0;
  if (b >= 360.0) b -= 360.0;
  return b;
}

}  // namespace maprama::camera_math
