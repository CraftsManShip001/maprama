// Protocol constants and enum string tables vs protocol-meta.json.
#include "diorama/Projection.hpp"
#include "diorama/protocol.hpp"
#include "diorama/types.hpp"
#include "harness.hpp"

namespace {

using diorama::json::Value;

template <class Container>
void expectList(diorama::test::Context& ctx, const Value& meta, const char* key, const Container& actual) {
  const Value* expected = meta.find(key);
  if (!ctx.check(expected != nullptr && expected->isArray(), std::string(key) + " present in protocol-meta.json")) {
    return;
  }
  std::string expectedText = diorama::json::stringify(*expected);
  Value actualValue = Value::array();
  for (std::string_view name : actual) actualValue.push(Value(name));
  std::string actualText = diorama::json::stringify(actualValue);
  ctx.check(expectedText == actualText, std::string(key) + ": C++ " + actualText + " != TS " + expectedText);
}

template <class E>
void expectEnum(diorama::test::Context& ctx, const Value& meta, const char* key) {
  expectList(ctx, meta, key, diorama::EnumNames<E>::values);
}

void expectNumber(diorama::test::Context& ctx, const Value& meta, const char* key, double actual) {
  const Value* expected = meta.find(key);
  ctx.check(expected != nullptr && expected->isNumber() && expected->asNumber() == actual,
            std::string(key) + " == " + diorama::json::numberToString(actual));
}

}  // namespace

DIORAMA_TEST(meta_constants_match_protocol) {
  const Value meta = diorama::test::loadFixture(ctx, "protocol-meta.json");
  expectNumber(ctx, meta, "PROTOCOL_VERSION", diorama::protocol::kProtocolVersion);
  expectNumber(ctx, meta, "WORLD_DATA_VERSION", diorama::protocol::kWorldDataVersion);
  expectNumber(ctx, meta, "DEFAULT_UNIT_METERS", diorama::kDefaultUnitMeters);
  expectNumber(ctx, meta, "METERS_PER_DEGREE_LNG", diorama::kMetersPerDegreeLng);
  expectNumber(ctx, meta, "METERS_PER_DEGREE_LAT", diorama::kMetersPerDegreeLat);
  expectNumber(ctx, meta, "EARTH_RADIUS_METERS", diorama::kEarthRadiusMeters);

  expectList(ctx, meta, "ENGINE_COMMAND_TYPES", diorama::protocol::kEngineCommandTypes);
  expectList(ctx, meta, "ENGINE_EVENT_TYPES", diorama::protocol::kEngineEventTypes);
}

DIORAMA_TEST(meta_enum_tables_match_protocol) {
  using namespace diorama;  // NOLINT
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
