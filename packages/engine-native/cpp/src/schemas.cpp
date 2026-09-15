#include "schemas.hpp"

#include <cstddef>

namespace diorama::schemas {

namespace {

using namespace diorama::validate;  // NOLINT: mirrors the TS module's flat imports

constexpr double kMaxSafeInteger = 9007199254740991.0;

/// CSS hex color `#RGB`, `#RRGGBB` or `#RRGGBBAA` (entities.ts `cssHexColor`).
Error cssHexColor(const Value* v, const std::string& p) {
  if (v != nullptr && v->isString()) {
    const std::string& s = v->asString();
    const std::size_t n = s.size();
    if ((n == 4 || n == 7 || n == 9) && s[0] == '#') {
      bool hex = true;
      for (std::size_t i = 1; i < n && hex; ++i) {
        const char c = s[i];
        hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
      }
      if (hex) return std::nullopt;
    }
  }
  return p + ": expected CSS hex color string like \"#RRGGBB\"";
}

struct Schemas {
  Check lngLat;
  Check worldPoint;
  Check worldData;
  Check worldSource;
  Check themePreset;
  Check themeSpec;
  Check engineCommand;
  Check engineEvent;

  Schemas() {
    const Check nonNeg = nonNegativeNumber();
    const Check id = nonEmptyString;

    // geo.ts
    lngLat = object({{"lng", range(-180, 180)}, {"lat", range(-90, 90)}});
    worldPoint = object({{"x", number}, {"z", number}});

    // world.ts
    const Check vec2 = tuple({number, number});
    worldData = object(
        {
            {"version", literal(1)},
            {"name", str},
            {"origin", lngLat},
            {"unitMeters", positiveNumber},
            {"bounds", object({{"minX", number}, {"minZ", number}, {"maxX", number}, {"maxZ", number}})},
            {"roads", array(object({{"id", nonEmptyString}, {"cls", oneOfEnum<RoadClass>()}, {"pts", array(vec2, 2)}},
                                   {{"name", str}, {"bridge", boolean}}))},
            {"buildings",
             array(object({{"id", nonEmptyString}, {"footprint", array(vec2, 3)}, {"height", nonNeg}},
                          {{"levels", range(0, kMaxSafeInteger)}, {"kind", oneOfEnum<BuildingKind>()}, {"name", str}}))},
            {"water", array(array(vec2, 3))},
            {"parks", array(object({{"poly", array(vec2, 3)}}, {{"name", str}}))},
            {"pois", array(object({{"id", nonEmptyString},
                                   {"name", str},
                                   {"cat", oneOfEnum<PoiCategory>()},
                                   {"x", number},
                                   {"z", number}}))},
            {"stations", array(object({{"id", nonEmptyString}, {"name", str}, {"x", number}, {"z", number}}))},
            {"districts", array(object({{"name", str}, {"x", number}, {"z", number}}, {{"water", boolean}}))},
            {"attribution", array(str)},
        },
        {{"plaza", worldPoint}});

    worldSource = discriminated(
        "kind", {
                    {"data", object({{"world", worldData}})},
                    {"url", object({{"url", nonEmptyString}})},
                    {"procedural", object({{"layout", oneOfEnum<ProceduralLayout>()}}, {{"seed", integer}})},
                });

    // theme.ts
    themePreset = object(
        {
            {"shading", oneOfEnum<ShadingModel>()},
            {"textured", boolean},
            {"facade", oneOfEnum<FacadeSet>()},
            {"toneMapped", boolean},
            {"streetLife", boolean},
            {"edgeLines", boolean},
            {"flatRoofs", boolean},
            {"hazeOpacity", number},
            {"grade", number},
            {"palette", array(str, 1)},
            {"ground", hexColorNumber},
            {"road", hexColorNumber},
            {"pad", hexColorNumber},
            {"plaza", hexColorNumber},
            {"park", hexColorNumber},
            {"water", hexColorNumber},
            {"rim", hexColorNumber},
            {"trunk", hexColorNumber},
            {"leafA", hexColorNumber},
            {"leafB", hexColorNumber},
            {"centerLine", hexColorNumber},
            {"crosswalkColor", hexColorNumber},
            {"landmark", object({{"base", hexColorNumber}, {"a", hexColorNumber}, {"b", hexColorNumber},
                                 {"cone", hexColorNumber}},
                                {{"glass", oneOfEnum<LandmarkGlass>()}})},
            {"hemiMul", number},
            {"sunMul", number},
        },
        {{"heightScale", positiveNumber}});

    themeSpec = object(
        {}, {
                {"base", anyOf({oneOfEnum<PresetName>(), themePreset})},
                {"timeOfDay", oneOfEnum<TimeOfDay>()},
                {"cinematic", boolean},
                {"shadows", boolean},
                {"buildings", object({}, {{"facade", boolean},
                                          {"outline", boolean},
                                          {"massing", oneOfEnum<Massing>()},
                                          {"details", boolean},
                                          {"heightScale", positiveNumber}})},
                {"roads", object({}, {{"laneMarkings", boolean}, {"crosswalks", boolean}})},
                {"street", object({}, {{"props", boolean}, {"parked", boolean}, {"traffic", boolean}})},
                {"zoomOut", oneOfEnum<ZoomOutBehavior>()},
            });

    // labels.ts
    const Check labelsSpec = object({}, {{"enabled", boolean},
                                         {"style", oneOfEnum<LabelStyle>()},
                                         {"icons", oneOfEnum<HoloIconTile>()},
                                         {"content", oneOfEnum<LabelContentMode>()}});
    const Check labelInfo = object(
        {{"id", nonEmptyString}, {"kind", oneOfEnum<LabelKind>()}, {"name", str}, {"lngLat", lngLat}},
        {{"category", oneOfEnum<PoiCategory>()}, {"subtitle", str}});
    const Check labelContent = object({{"title", str}}, {{"subtitle", str}, {"icon", oneOfEnum<LabelIcon>()}});

    // entities.ts
    const Check modelSource = object({{"uri", nonEmptyString}});
    Fields animationFields;
    for (std::string_view name : EnumNames<AnimationName>::values) animationFields.emplace_back(std::string(name), str);
    const Check animationMap = object({}, animationFields);
    const Check characterSpec = object({{"id", nonEmptyString}}, {
                                                                     {"model", nullable(modelSource)},
                                                                     {"name", str},
                                                                     {"color", cssHexColor},
                                                                     {"position", lngLat},
                                                                     {"follow", oneOf({"location", "none"})},
                                                                     {"isPlayer", boolean},
                                                                     {"scale", positiveNumber},
                                                                     {"animations", animationMap},
                                                                     {"showNameTag", boolean},
                                                                 });
    const Check baseDrop = object(
        {{"id", nonEmptyString}, {"type", oneOfEnum<DropType>()}, {"coordinate", lngLat}},
        {{"model", modelSource}, {"rarity", oneOfEnum<Rarity>()}, {"value", number}, {"payload", jsonValue}});
    const Check dropSpec = [baseDrop](const Value* v, const std::string& p) -> Error {
      if (Error err = baseDrop(v, p)) return err;
      return (v->find("type")->asString() == "model" && v->find("model") == nullptr)
                 ? Error(p + ".model: required when type is \"model\"")
                 : Error();
    };
    const Check geofenceSpec =
        object({{"id", nonEmptyString}, {"center", lngLat}, {"radiusMeters", positiveNumber}});
    const Check buildingStyle = object({}, {
                                               {"color", cssHexColor},
                                               {"roof", oneOfEnum<RoofShape>()},
                                               {"facade", boolean},
                                               {"decorations", array(oneOfEnum<BuildingDecoration>())},
                                               {"massing", oneOfEnum<Massing>()},
                                               {"replaceModel", modelSource},
                                               {"state", str},
                                           });
    const Check locationFix =
        object({{"lng", range(-180, 180)}, {"lat", range(-90, 90)}, {"timestamp", number}},
               {{"accuracyMeters", nonNeg}, {"headingDeg", number}, {"speedMps", nonNeg}});
    const Check cameraSpec = object({}, {
                                            {"center", lngLat},
                                            {"distance", positiveNumber},
                                            {"zoom", number},
                                            {"pitch", range(0, 90)},
                                            {"bearing", number},
                                            {"follow", nullable(nonEmptyString)},
                                            {"animate", anyOf({boolean, object({{"durationMs", nonNeg}})})},
                                        });
    const Check mapUiSpec = object(
        {}, {{"locationPuck", boolean}, {"scaleBar", boolean}, {"zoomButtons", boolean}, {"attribution", boolean}});

    // messages.ts — commands
    const Check travelModes = array(oneOfEnum<TravelMode>(), 1);
    Fields requestChecks = {
        {"project", object({{"coordinate", lngLat}})},
        {"unproject", object({{"x", number}, {"y", number}})},
        {"snapToRoad", object({{"coordinate", lngLat}}, {{"maxDistanceMeters", nonNeg}})},
        {"route", object({{"from", lngLat}, {"to", lngLat}, {"modes", travelModes}})},
    };
    const Check subscriptionTopic = oneOfEnum<SubscriptionTopic>();
    const Check requestHeader =
        object({{"requestId", id}, {"method", oneOfEnum<RequestMethod>()}, {"params", object({})}});

    Fields commands = {
        {"init", object(
                     {
                         {"world", worldSource},
                         {"theme", themeSpec},
                         {"labels", labelsSpec},
                         {"ui", mapUiSpec},
                         {"locationSource", oneOfEnum<LocationSourceKind>()},
                     },
                     {{"camera", cameraSpec}})},
        {"setTheme", object({{"theme", themeSpec}})},
        {"setLabels", object({{"labels", labelsSpec}})},
        {"setLabelContent", object({{"entries", record(labelContent)}})},
        {"setUi", object({{"ui", mapUiSpec}})},
        {"setCamera", object({{"camera", cameraSpec}})},
        {"upsertCharacters", object({{"characters", array(characterSpec)}})},
        {"removeCharacters", object({{"ids", array(id)}})},
        {"setLocationSource", object({{"source", oneOfEnum<LocationSourceKind>()}})},
        {"pushLocation", object({{"fix", locationFix}})},
        {"travel", object({{"requestId", id}, {"characterId", id}, {"to", lngLat}, {"modes", travelModes}})},
        {"cancelTravel", object({{"characterId", id}})},
        {"setDropLayer", object({{"layerId", id}, {"drops", array(dropSpec)}, {"collectRadiusMeters", nonNeg}},
                                {{"collectorIds", array(id)}})},
        {"removeDropLayer", object({{"layerId", id}})},
        {"setGeofences", object({{"geofences", array(geofenceSpec)}})},
        {"setBuildingStyle", object({{"buildingId", id}, {"style", nullable(buildingStyle)}})},
        {"setOverlayAnchors", object({{"anchors", array(object({{"id", id}, {"coordinate", lngLat}}))}})},
        {"subscribe", object({{"topic", subscriptionTopic}, {"throttleMs", nonNeg}}, {{"id", id}})},
        {"unsubscribe", object({{"topic", subscriptionTopic}}, {{"id", id}})},
        {"request",
         [requestHeader, requestChecks](const Value* v, const std::string& p) -> Error {
           if (Error err = requestHeader(v, p)) return err;
           const std::string& method = v->find("method")->asString();
           for (const auto& [name, check] : requestChecks) {
             if (name == method) return check(v->find("params"), p + ".params");
           }
           return std::nullopt;  // unreachable: method validated by oneOf
         }},
    };
    engineCommand = discriminated("type", std::move(commands));

    // messages.ts — events
    const Fields travelRef = {{"requestId", id}, {"characterId", id}};
    const auto withTravelRef = [&travelRef](Fields extra) {
      Fields all = travelRef;
      for (auto& f : extra) all.push_back(std::move(f));
      return all;
    };
    const Check geofenceRef = object({{"geofenceId", id}, {"characterId", id}});
    const Check protocolError = object({{"code", str}, {"message", str}});
    const Check responseHeader = object({{"requestId", id}, {"ok", boolean}});
    const Check responseOk = object({{"result", jsonValue}});
    const Check responseError = object({{"error", protocolError}});

    Fields events = {
        {"ready", object({{"engine", object({{"name", str}, {"version", str}, {"kind", oneOfEnum<EngineKind>()}})}})},
        {"error", object({{"code", str}, {"message", str}, {"fatal", boolean}})},
        {"labelsIndex", object({{"labels", array(labelInfo)}})},
        {"map:press", object({{"coordinate", lngLat}})},
        {"building:press", object({{"buildingId", id}, {"coordinate", lngLat}})},
        {"drop:collect", object({{"layerId", id},
                                 {"dropId", id},
                                 {"characterId", id},
                                 {"coordinate", lngLat},
                                 {"collectId", id}})},
        {"travel:start",
         object(withTravelRef({{"legs", array(object({{"mode", oneOfEnum<TravelMode>()}, {"meters", nonNeg}}))}}))},
        {"travel:progress", object(withTravelRef({{"remainingMeters", nonNeg},
                                                  {"etaSeconds", nonNeg},
                                                  {"mode", oneOfEnum<TravelMode>()}}))},
        {"travel:arrive", object(travelRef)},
        {"travel:cancel", object(travelRef)},
        {"geofence:enter", geofenceRef},
        {"geofence:exit", geofenceRef},
        {"character:position",
         object({{"id", id}, {"coordinate", lngLat}, {"headingDeg", number}, {"speedMps", number}})},
        {"camera:change", object({{"camera", object({{"center", lngLat},
                                                     {"distance", number},
                                                     {"pitch", range(0, 90)},
                                                     {"bearing", number}})}})},
        {"overlay:positions",
         object({{"positions", array(object({{"id", id}, {"x", number}, {"y", number}, {"visible", boolean}}))}})},
        {"response",
         [responseHeader, responseOk, responseError](const Value* v, const std::string& p) -> Error {
           if (Error err = responseHeader(v, p)) return err;
           return v->find("ok")->asBool() ? responseOk(v, p) : responseError(v, p);
         }},
    };
    engineEvent = discriminated("type", std::move(events));
  }
};

const Schemas& all() {
  static const Schemas schemas;
  return schemas;
}

}  // namespace

const validate::Check& lngLat() { return all().lngLat; }
const validate::Check& worldData() { return all().worldData; }
const validate::Check& worldSource() { return all().worldSource; }
const validate::Check& themeSpec() { return all().themeSpec; }
const validate::Check& themePreset() { return all().themePreset; }
const validate::Check& engineCommand() { return all().engineCommand; }
const validate::Check& engineEvent() { return all().engineEvent; }

}  // namespace diorama::schemas
