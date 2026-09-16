// Maprama native core — value types mirroring `@maprama/protocol`
// (geo.ts, entities.ts, labels.ts, messages.ts). Field names and units match
// the TypeScript contract; `std::optional` marks optional TS fields.
//
// Enum string tables below are checked against the exported protocol lists by
// the conformance tests (cpp/tests/meta_tests.cpp).
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "maprama/json.hpp"

namespace maprama {

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/// A value or an error message (the core avoids throwing across the JSI boundary).
template <class T>
struct Result {
  std::optional<T> value;
  std::string error;

  bool ok() const { return value.has_value(); }
  static Result success(T v) { return Result{std::move(v), {}}; }
  static Result failure(std::string message) { return Result{std::nullopt, std::move(message)}; }
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// WGS84 degrees.
struct LngLat {
  double lng = 0.0;
  double lat = 0.0;
};

/// World units on the local tangent plane: +x east, -z north.
struct WorldPoint {
  double x = 0.0;
  double z = 0.0;
};

/// `[x, z]` in world units.
using Vec2 = std::array<double, 2>;

/// A point in the map view in density-independent pixels, origin top-left.
struct ScreenPoint {
  double x = 0.0;
  double y = 0.0;
  bool visible = false;
};

// ---------------------------------------------------------------------------
// Enums with protocol string tables
// ---------------------------------------------------------------------------

enum class EngineKind : std::uint8_t { Web, Native };
enum class TravelMode : std::uint8_t { Walk, Bike, Car, Plane, Subway };
enum class LocationSourceKind : std::uint8_t { Device, External, Simulated };
enum class DropType : std::uint8_t { Coin, Cd, Vinyl, Note, Model };
enum class Rarity : std::uint8_t { Common, Rare, Legendary };
enum class RoofShape : std::uint8_t { Flat, Gable, Dome };
enum class BuildingDecoration : std::uint8_t { Sign, Antenna, Trees };
enum class AnimationName : std::uint8_t { Idle, Walk, Run, Ride, Wave };
enum class RoadClass : std::uint8_t { Arterial, Local, Alley };
enum class BuildingKind : std::uint8_t { Glass, Office, Apartment, Brick };
enum class PoiCategory : std::uint8_t { Subway, Cafe, Store, Music, School, Book, Plaza, Park };
enum class ProceduralLayout : std::uint8_t { Grid, Town };
enum class PresetName : std::uint8_t { Realistic, Toy, Minimal, Modern, Urban, Soft };
enum class TimeOfDay : std::uint8_t { Day, Golden, Dusk, Night };
enum class ShadingModel : std::uint8_t { Standard, Toon };
enum class FacadeSet : std::uint8_t { Real, Toy, None, Modern, Urban, Soft };
enum class LandmarkGlass : std::uint8_t { Real, Modern, Urban };
enum class Massing : std::uint8_t { Box, Varied };
enum class ZoomOutBehavior : std::uint8_t { None, MapColors, KeepGameView };
enum class LabelStyle : std::uint8_t { App, Minimal, Clean, Sticker, Ground, Sign, Holo };
enum class HoloIconTile : std::uint8_t { Auto, White, Black, Color };
enum class LabelContentMode : std::uint8_t { NameAndType, NameOnly, TextOnly, Custom };
enum class LabelKind : std::uint8_t { Road, District, Poi };
enum class LabelIcon : std::uint8_t { Subway, Cafe, Store, Music, School, Book, Plaza, Park, Avenue, Street, District, Water };
enum class SubscriptionTopic : std::uint8_t { CharacterPosition, CameraChange, TravelProgress, CameraIdle };
enum class CameraIdleReason : std::uint8_t { Gesture, Api, Follow };
enum class RequestMethod : std::uint8_t { Project, Unproject, SnapToRoad, Route, FitBounds, FocusOn };
enum class InfoCardAnchor : std::uint8_t { Ground, Roof, Auto };
enum class InfoBadgeTone : std::uint8_t { Neutral, Good, Warn, Bad };
enum class InfoRowIcon : std::uint8_t { Hours, Location, Phone, Link, Info, Price };

/// Specialised per enum: `values` lists protocol strings in enum order.
template <class E>
struct EnumNames;

// clang-format off
template <> struct EnumNames<EngineKind> { static constexpr std::array<std::string_view, 2> values{"web", "native"}; };
template <> struct EnumNames<TravelMode> { static constexpr std::array<std::string_view, 5> values{"walk", "bike", "car", "plane", "subway"}; };
template <> struct EnumNames<LocationSourceKind> { static constexpr std::array<std::string_view, 3> values{"device", "external", "simulated"}; };
template <> struct EnumNames<DropType> { static constexpr std::array<std::string_view, 5> values{"coin", "cd", "vinyl", "note", "model"}; };
template <> struct EnumNames<Rarity> { static constexpr std::array<std::string_view, 3> values{"common", "rare", "legendary"}; };
template <> struct EnumNames<RoofShape> { static constexpr std::array<std::string_view, 3> values{"flat", "gable", "dome"}; };
template <> struct EnumNames<BuildingDecoration> { static constexpr std::array<std::string_view, 3> values{"sign", "antenna", "trees"}; };
template <> struct EnumNames<AnimationName> { static constexpr std::array<std::string_view, 5> values{"idle", "walk", "run", "ride", "wave"}; };
template <> struct EnumNames<RoadClass> { static constexpr std::array<std::string_view, 3> values{"arterial", "local", "alley"}; };
template <> struct EnumNames<BuildingKind> { static constexpr std::array<std::string_view, 4> values{"glass", "office", "apartment", "brick"}; };
template <> struct EnumNames<PoiCategory> { static constexpr std::array<std::string_view, 8> values{"subway", "cafe", "store", "music", "school", "book", "plaza", "park"}; };
template <> struct EnumNames<ProceduralLayout> { static constexpr std::array<std::string_view, 2> values{"grid", "town"}; };
template <> struct EnumNames<PresetName> { static constexpr std::array<std::string_view, 6> values{"realistic", "toy", "minimal", "modern", "urban", "soft"}; };
template <> struct EnumNames<TimeOfDay> { static constexpr std::array<std::string_view, 4> values{"day", "golden", "dusk", "night"}; };
template <> struct EnumNames<ShadingModel> { static constexpr std::array<std::string_view, 2> values{"standard", "toon"}; };
template <> struct EnumNames<FacadeSet> { static constexpr std::array<std::string_view, 6> values{"real", "toy", "none", "modern", "urban", "soft"}; };
template <> struct EnumNames<LandmarkGlass> { static constexpr std::array<std::string_view, 3> values{"real", "modern", "urban"}; };
template <> struct EnumNames<Massing> { static constexpr std::array<std::string_view, 2> values{"box", "varied"}; };
template <> struct EnumNames<ZoomOutBehavior> { static constexpr std::array<std::string_view, 3> values{"none", "mapColors", "keepGameView"}; };
template <> struct EnumNames<LabelStyle> { static constexpr std::array<std::string_view, 7> values{"app", "minimal", "clean", "sticker", "ground", "sign", "holo"}; };
template <> struct EnumNames<HoloIconTile> { static constexpr std::array<std::string_view, 4> values{"auto", "white", "black", "color"}; };
template <> struct EnumNames<LabelContentMode> { static constexpr std::array<std::string_view, 4> values{"nameAndType", "nameOnly", "textOnly", "custom"}; };
template <> struct EnumNames<LabelKind> { static constexpr std::array<std::string_view, 3> values{"road", "district", "poi"}; };
template <> struct EnumNames<LabelIcon> { static constexpr std::array<std::string_view, 12> values{"subway", "cafe", "store", "music", "school", "book", "plaza", "park", "avenue", "street", "district", "water"}; };
template <> struct EnumNames<SubscriptionTopic> { static constexpr std::array<std::string_view, 4> values{"character:position", "camera:change", "travel:progress", "camera:idle"}; };
template <> struct EnumNames<CameraIdleReason> { static constexpr std::array<std::string_view, 3> values{"gesture", "api", "follow"}; };
template <> struct EnumNames<RequestMethod> { static constexpr std::array<std::string_view, 6> values{"project", "unproject", "snapToRoad", "route", "fitBounds", "focusOn"}; };
template <> struct EnumNames<InfoCardAnchor> { static constexpr std::array<std::string_view, 3> values{"ground", "roof", "auto"}; };
template <> struct EnumNames<InfoBadgeTone> { static constexpr std::array<std::string_view, 4> values{"neutral", "good", "warn", "bad"}; };
template <> struct EnumNames<InfoRowIcon> { static constexpr std::array<std::string_view, 6> values{"hours", "location", "phone", "link", "info", "price"}; };
// clang-format on

template <class E>
constexpr std::string_view enumName(E value) {
  return EnumNames<E>::values[static_cast<std::size_t>(value)];
}

template <class E>
constexpr std::optional<E> parseEnum(std::string_view name) {
  const auto& values = EnumNames<E>::values;
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (values[i] == name) return static_cast<E>(i);
  }
  return std::nullopt;
}

// ---------------------------------------------------------------------------
// Entities (entities.ts)
// ---------------------------------------------------------------------------

struct ModelSource {
  std::string uri;
};

/// Upserts merge into the existing character. For every nullable field the outer optional means
/// "field present" (absent keeps the current value) and the inner optional is the value, or
/// `null` to restore the default. `id` and `position` are not nullable.
struct CharacterSpec {
  std::string id;
  /// Model, or `null` to show the default avatar again.
  std::optional<std::optional<ModelSource>> model;
  /// Name, or `null` to clear it (the name tag then shows the id).
  std::optional<std::optional<std::string>> name;
  /// CSS hex `#RGB` / `#RRGGBB` / `#RRGGBBAA`, or `null` for the default player / NPC color.
  std::optional<std::optional<std::string>> color;
  /// Initial or teleport position.
  std::optional<LngLat> position;
  /// `"location"` or `"none"`, or `null` for the default (not driven by the location source).
  std::optional<std::optional<std::string>> follow;
  /// Or `null` for the default (`false`).
  std::optional<std::optional<bool>> isPlayer;
  /// Or `null` for the default (1).
  std::optional<std::optional<double>> scale;
  /// Clip mapping, or `null` to return to automatic clip matching.
  std::optional<std::optional<std::map<AnimationName, std::string>>> animations;
  /// Or `null` for the default (`false`).
  std::optional<std::optional<bool>> showNameTag;
};

struct DropSpec {
  std::string id;
  DropType type = DropType::Coin;
  std::optional<ModelSource> model;
  LngLat coordinate;
  std::optional<Rarity> rarity;
  std::optional<double> value;
  /// Echoed back to the host; `null` value when absent.
  std::optional<json::Value> payload;
};

struct GeofenceSpec {
  std::string id;
  LngLat center;
  double radiusMeters = 0.0;
};

struct BuildingStyle {
  std::optional<std::string> color;
  std::optional<RoofShape> roof;
  std::optional<bool> facade;
  std::optional<std::vector<BuildingDecoration>> decorations;
  std::optional<Massing> massing;
  std::optional<ModelSource> replaceModel;
  std::optional<std::string> state;
};

struct LocationFix {
  double lng = 0.0;
  double lat = 0.0;
  std::optional<double> accuracyMeters;
  std::optional<double> headingDeg;
  std::optional<double> speedMps;
  /// Milliseconds since the Unix epoch.
  double timestamp = 0.0;
};

struct CameraAnimation {
  /// Engine default duration when absent.
  std::optional<double> durationMs;
};

struct CameraSpec {
  std::optional<LngLat> center;
  /// Meters; takes precedence over `zoom`.
  std::optional<double> distance;
  std::optional<double> zoom;
  /// Degrees, 0 = straight down.
  std::optional<double> pitch;
  /// Degrees clockwise from north.
  std::optional<double> bearing;
  /// Outer optional: field present. Inner optional: character id, or `null` to stop following.
  std::optional<std::optional<std::string>> follow;
  /// Present when the transition animates (`true` or `{durationMs}`); absent or `false` = jump.
  std::optional<CameraAnimation> animate;
};

/// Concrete camera state (`CameraState` in messages.ts).
struct CameraState {
  LngLat center;
  double distance = 0.0;
  double pitch = 0.0;
  double bearing = 0.0;
};

/// `ui.contentInset`: space app chrome covers along the view edges, in density-independent pixels.
/// The map still draws across the whole view; the inset moves the *visible area* the camera, the
/// ornaments, the labels and `camera:idle` are measured against.
struct ContentInset {
  double top = 0.0;
  double right = 0.0;
  double bottom = 0.0;
  double left = 0.0;

  bool empty() const { return top == 0.0 && right == 0.0 && bottom == 0.0 && left == 0.0; }
  bool operator==(const ContentInset& o) const {
    return top == o.top && right == o.right && bottom == o.bottom && left == o.left;
  }
};

struct MapUiSpec {
  std::optional<bool> locationPuck;
  std::optional<bool> scaleBar;
  std::optional<bool> zoomButtons;
  std::optional<bool> attribution;
  ContentInset contentInset;
};

// ---------------------------------------------------------------------------
// Labels (labels.ts)
// ---------------------------------------------------------------------------

struct LabelsSpec {
  std::optional<bool> enabled;
  std::optional<LabelStyle> style;
  std::optional<HoloIconTile> icons;
  std::optional<LabelContentMode> content;
};

struct LabelInfo {
  std::string id;
  LabelKind kind = LabelKind::Poi;
  std::string name;
  std::optional<PoiCategory> category;
  std::optional<std::string> subtitle;
  LngLat lngLat;
};

struct LabelContent {
  std::string title;
  std::optional<std::string> subtitle;
  std::optional<LabelIcon> icon;
};

// ---------------------------------------------------------------------------
// Messages (messages.ts)
// ---------------------------------------------------------------------------

struct EngineInfo {
  std::string name;
  std::string version;
  EngineKind kind = EngineKind::Native;
};

struct OverlayAnchor {
  std::string id;
  LngLat coordinate;
};

struct OverlayPosition {
  std::string id;
  ScreenPoint point;
};

struct TravelLeg {
  TravelMode mode = TravelMode::Walk;
  double meters = 0.0;
};

struct RouteLeg {
  TravelMode mode = TravelMode::Walk;
  double meters = 0.0;
  std::vector<LngLat> path;
};

struct RouteResult {
  std::vector<RouteLeg> legs;
  double meters = 0.0;
  double etaSeconds = 0.0;
};

struct SnapToRoadResult {
  LngLat coordinate;
  std::string roadId;
  double distanceMeters = 0.0;
};

/// `ProtocolError` (`code` is a well-known `EngineErrorCode` or engine-specific).
struct ProtocolError {
  std::string code;
  std::string message;
};

/// Well-known `EngineErrorCode` values.
namespace error_codes {
inline constexpr std::string_view kInvalidMessage = "invalid_message";
inline constexpr std::string_view kUnsupported = "unsupported";
inline constexpr std::string_view kWorldLoadFailed = "world_load_failed";
inline constexpr std::string_view kModelLoadFailed = "model_load_failed";
inline constexpr std::string_view kInternal = "internal";
}  // namespace error_codes

}  // namespace maprama
