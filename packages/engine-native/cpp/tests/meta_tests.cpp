// Protocol constants and enum string tables vs protocol-meta.json.
#include "maprama/Projection.hpp"
#include "maprama/protocol.hpp"
#include "maprama/types.hpp"
#include "harness.hpp"

namespace {

using maprama::json::Value;

template <class Container>
void expectList(maprama::test::Context& ctx, const Value& meta, const char* key, const Container& actual) {
  const Value* expected = meta.find(key);
  if (!ctx.check(expected != nullptr && expected->isArray(), std::string(key) + " present in protocol-meta.json")) {
    return;
  }
  std::string expectedText = maprama::json::stringify(*expected);
  Value actualValue = Value::array();
  for (std::string_view name : actual) actualValue.push(Value(name));
  std::string actualText = maprama::json::stringify(actualValue);
  ctx.check(expectedText == actualText, std::string(key) + ": C++ " + actualText + " != TS " + expectedText);
}

template <class E>
void expectEnum(maprama::test::Context& ctx, const Value& meta, const char* key) {
  expectList(ctx, meta, key, maprama::EnumNames<E>::values);
}

void expectNumber(maprama::test::Context& ctx, const Value& meta, const char* key, double actual) {
  const Value* expected = meta.find(key);
  ctx.check(expected != nullptr && expected->isNumber() && expected->asNumber() == actual,
            std::string(key) + " == " + maprama::json::numberToString(actual));
}

}  // namespace

MAPRAMA_TEST(meta_constants_match_protocol) {
  const Value meta = maprama::test::loadFixture(ctx, "protocol-meta.json");
  expectNumber(ctx, meta, "PROTOCOL_VERSION", maprama::protocol::kProtocolVersion);
  expectNumber(ctx, meta, "WORLD_DATA_VERSION", maprama::protocol::kWorldDataVersion);
  expectNumber(ctx, meta, "DEFAULT_UNIT_METERS", maprama::kDefaultUnitMeters);
  expectNumber(ctx, meta, "METERS_PER_DEGREE_LNG", maprama::kMetersPerDegreeLng);
  expectNumber(ctx, meta, "METERS_PER_DEGREE_LAT", maprama::kMetersPerDegreeLat);
  expectNumber(ctx, meta, "EARTH_RADIUS_METERS", maprama::kEarthRadiusMeters);

  expectList(ctx, meta, "ENGINE_COMMAND_TYPES", maprama::protocol::kEngineCommandTypes);
  expectList(ctx, meta, "ENGINE_EVENT_TYPES", maprama::protocol::kEngineEventTypes);
}

MAPRAMA_TEST(meta_enum_tables_match_protocol) {
  using namespace maprama;  // NOLINT
  const Value meta = test::loadFixture(ctx, "protocol-meta.json");
  expectEnum<EngineKind>(ctx, meta, "ENGINE_KINDS");
  expectEnum<RequestMethod>(ctx, meta, "REQUEST_METHODS");
  expectEnum<SubscriptionTopic>(ctx, meta, "SUBSCRIPTION_TOPICS");
  expectEnum<TravelMode>(ctx, meta, "TRAVEL_MODES");
  expectEnum<LocationSourceKind>(ctx, meta, "LOCATION_SOURCE_KINDS");
  expectEnum<DropType>(ctx, meta, "DROP_TYPES");
  expectEnum<Rarity>(ctx, meta, "RARITIES");
  expectEnum<RoofShape>(ctx, meta, "ROOF_SHAPES");
  expectEnum<BuildingDecoration>(ctx, meta, "BUILDING_DECORATIONS");
  expectEnum<AnimationName>(ctx, meta, "ANIMATION_NAMES");
  expectEnum<RoadClass>(ctx, meta, "ROAD_CLASSES");
  expectEnum<BuildingKind>(ctx, meta, "BUILDING_KINDS");
  expectEnum<PoiCategory>(ctx, meta, "POI_CATEGORIES");
  expectEnum<ProceduralLayout>(ctx, meta, "PROCEDURAL_LAYOUTS");
  expectEnum<PresetName>(ctx, meta, "PRESET_NAMES");
  expectEnum<TimeOfDay>(ctx, meta, "TIMES_OF_DAY");
  expectEnum<ShadingModel>(ctx, meta, "SHADING_MODELS");
  expectEnum<FacadeSet>(ctx, meta, "FACADE_SETS");
  expectEnum<LandmarkGlass>(ctx, meta, "LANDMARK_GLASS_STYLES");
  expectEnum<Massing>(ctx, meta, "MASSING_MODES");
  expectEnum<ZoomOutBehavior>(ctx, meta, "ZOOM_OUT_BEHAVIORS");
  expectEnum<LabelStyle>(ctx, meta, "LABEL_STYLES");
  expectEnum<HoloIconTile>(ctx, meta, "HOLO_ICON_TILES");
  expectEnum<LabelContentMode>(ctx, meta, "LABEL_CONTENT_MODES");
  expectEnum<LabelKind>(ctx, meta, "LABEL_KINDS");
  expectEnum<LabelIcon>(ctx, meta, "LABEL_ICONS");

  ctx.check(parseEnum<TravelMode>("subway") == TravelMode::Subway, "parseEnum<TravelMode>(\"subway\")");
  ctx.check(!parseEnum<TravelMode>("teleport").has_value(), "parseEnum rejects unknown names");
  ctx.check(enumName(ZoomOutBehavior::KeepGameView) == "keepGameView", "enumName(KeepGameView)");
}
