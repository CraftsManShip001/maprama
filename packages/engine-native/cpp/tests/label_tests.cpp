// M2b labels: engine-web's label rules against the labels.json fixture (exported from engine-web's own
// src/labels/index.ts), the MapLibre projection port, and the session behaviour (labelsIndex, setLabels /
// setLabelContent, card measurement, label frames) through the fake MapAdapter. Emitted envelopes go to
// --emit (verify-emitted-events).
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "maprama/CameraMath.hpp"
#include "maprama/LabelIcons.hpp"
#include "maprama/LabelSystem.hpp"
#include "maprama/MapLook.hpp"
#include "maprama/ProceduralWorld.hpp"
#include "maprama/WorldStore.hpp"
#include "harness.hpp"
#include "map_harness.hpp"

namespace {

using maprama::json::Value;
using namespace maprama::test::maptest;
using maprama::test::Context;
namespace mp = maprama;
namespace cm = maprama::camera_math;

std::string str(const Value* v) { return v != nullptr && v->isString() ? v->asString() : std::string(); }
double num(const Value* v) { return v != nullptr && v->isNumber() ? v->asNumber() : std::nan(""); }
bool near(double a, double b, double tol = 1e-9) { return std::fabs(a - b) <= tol * std::max(1.0, std::fabs(b)); }

std::unique_ptr<mp::WorldStore> loadLabelWorld(const Value& worldCase) {
  auto store = mp::createWorldStore();
  if (const Value* procedural = worldCase.find("procedural")) {
    // A generated world, loaded the way `init {world: {kind: "procedural"}}` loads it (MapSession).
    const auto layout = mp::parseEnum<mp::ProceduralLayout>(procedural->find("layout")->asString());
    const mp::ProceduralWorld world = mp::buildProceduralWorld(*layout, procedural->find("seed")->asNumber());
    mp::Result<mp::WorldLoadReport> r = store->load(mp::proceduralWorldData(world));
    if (!r.ok()) throw std::runtime_error("procedural label world failed to load: " + r.error);
    return store;
  }
  const Value* inlineWorld = worldCase.find("world");
  mp::Result<mp::WorldLoadReport> r = inlineWorld != nullptr
                                          ? store->load(*inlineWorld)
                                          : store->loadJson(maprama::test::readFile(worldCase.find("inputPath")->asString()));
  if (!r.ok()) throw std::runtime_error("label fixture world failed to load: " + r.error);
  return store;
}

/// Numbers compared with a relative 1e-9 tolerance, everything else exactly; object members in any order.
bool nearJson(const Value& a, const Value& b) {
  if (a.type() != b.type()) return false;
  switch (a.type()) {
    case mp::json::Type::Number:
      return near(a.asNumber(), b.asNumber());
    case mp::json::Type::Array:
      if (a.items().size() != b.items().size()) return false;
      for (std::size_t i = 0; i < a.items().size(); ++i) {
        if (!nearJson(a.items()[i], b.items()[i])) return false;
      }
      return true;
    case mp::json::Type::Object:
      if (a.members().size() != b.members().size()) return false;
      for (const mp::json::Member& m : a.members()) {
        const Value* other = b.find(m.key);
        if (other == nullptr || !nearJson(m.value, *other)) return false;
      }
      return true;
    default:
      return mp::json::stringify(a) == mp::json::stringify(b);
  }
}

mp::LabelBox boxOf(const Value& v) {
  return mp::LabelBox{num(v.find("x")), num(v.find("y")), num(v.find("hw")), num(v.find("hh"))};
}

bool sameBox(const mp::LabelBox& a, const mp::LabelBox& b) {
  return near(a.x, b.x) && near(a.y, b.y) && near(a.hw, b.hw) && near(a.hh, b.hh);
}

mp::MapUiSpec uiSpecOf(const Value& v) {
  mp::MapUiSpec ui;
  if (const Value* z = v.find("zoomButtons")) ui.zoomButtons = z->asBool();
  if (const Value* s = v.find("scaleBar")) ui.scaleBar = s->asBool();
  if (const Value* a = v.find("attribution")) ui.attribution = a->asBool();
  return ui;
}

template <class E>
E enumOf(const Value* v) {
  return *mp::parseEnum<E>(v->asString());
}

}  // namespace

MAPRAMA_TEST(labels_index_matches_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "labels.json");
  bool sawSeongsu = false;
  for (const Value& wc : fixture.find("worlds")->items()) {
    const std::string name = wc.find("name")->asString();
    const auto store = loadLabelWorld(wc);
    const std::vector<mp::LabelEntry> entries = mp::buildLabelEntries(*store->world(), *store->projection());
    const auto& expected = wc.find("entries")->items();
    ctx.check(entries.size() == expected.size(), "[" + name + "] " + std::to_string(expected.size()) + " label entries (got " +
                                                     std::to_string(entries.size()) + ")");
    if (entries.size() != expected.size()) continue;
    std::size_t mismatches = 0;
    std::set<std::string> ids;
    for (std::size_t i = 0; i < entries.size(); ++i) {
      const mp::LabelEntry& e = entries[i];
      const Value& x = expected[i];
      ids.insert(e.id);
      bool ok = e.id == str(x.find("id")) && std::string(mp::enumName(e.kind)) == str(x.find("kind")) && e.name == str(x.find("name")) &&
                e.pri == static_cast<int>(num(x.find("pri"))) && std::string(mp::enumName(e.icon)) == str(x.find("icon")) &&
                near(e.x, num(x.find("x"))) && near(e.z, num(x.find("z"))) && near(e.lngLat.lng, num(x.find("lngLat")->find("lng"))) &&
                near(e.lngLat.lat, num(x.find("lngLat")->find("lat"))) && e.water == (x.find("water") != nullptr && x.find("water")->asBool());
      ok = ok && (e.subtitle ? *e.subtitle == str(x.find("subtitle")) : x.find("subtitle") == nullptr);
      ok = ok && (e.category ? std::string(mp::enumName(*e.category)) == str(x.find("category")) : x.find("category") == nullptr);
      ok = ok && (e.roadClass ? std::string(mp::enumName(*e.roadClass)) == str(x.find("roadClass")) : x.find("roadClass") == nullptr);
      ok = ok && (e.tx ? near(*e.tx, num(x.find("tx"))) && near(*e.tz, num(x.find("tz"))) : x.find("tx") == nullptr);
      ok = ok && nearJson(mp::labelInfoValue(e), wc.find("infos")->items()[i]);
      if (!ok && ++mismatches <= 3) ctx.check(false, "[" + name + "] entry " + std::to_string(i) + " (" + e.id + ") matches engine-web");
    }
    ctx.check(mismatches == 0, "[" + name + "] every entry and LabelInfo matches engine-web (" + std::to_string(mismatches) + " differ)");
    ctx.check(ids.size() == entries.size(), "[" + name + "] label ids are unique");
    const Value index = mp::labelsIndexValue(entries);
    const mp::protocol::ValidationResult valid =
        mp::protocol::validateEngineEvent(Value::object({{"type", "labelsIndex"}, {"labels", index}}));
    ctx.check(valid.ok, "[" + name + "] labelsIndex validates: " + valid.error);
    if (name.find("seongsu") != std::string::npos) {
      sawSeongsu = true;
      std::size_t pois = 0, districts = 0;
      for (const mp::LabelEntry& e : entries) {
        pois += e.kind == mp::LabelKind::Poi ? 1 : 0;
        districts += e.kind == mp::LabelKind::District ? 1 : 0;
      }
      ctx.check(pois == 55 && districts == 0, "[" + name + "] 55 POI labels, no districts (engine-web labels.test.ts)");
      std::cout << "    seongsu: " << entries.size() << " labels (" << pois << " POIs, " << entries.size() - pois << " road anchors)\n";
    }
  }
  ctx.check(sawSeongsu, "labels.json includes the Seongsu sample");
}

MAPRAMA_TEST(label_content_and_rules_match_engine_web) {
  const Value fixture = maprama::test::loadFixture(ctx, "labels.json");
  const auto store = loadLabelWorld(fixture.find("worlds")->items().at(0));
  const std::vector<mp::LabelEntry> entries = mp::buildLabelEntries(*store->world(), *store->projection());
  std::map<std::string, const mp::LabelEntry*> byId;
  for (const mp::LabelEntry& e : entries) byId[e.id] = &e;

  // Content modes.
  const auto host = mp::parseLabelContentEntries(*fixture.find("content")->find("entries"));
  std::size_t contentBad = 0, contentCases = 0;
  for (const Value& c : fixture.find("content")->find("cases")->items()) {
    ++contentCases;
    const mp::LabelEntry* e = byId.at(c.find("id")->asString());
    const mp::ResolvedLabelContent r = mp::resolveLabelContent(*e, enumOf<mp::LabelContentMode>(c.find("mode")), host);
    const Value& x = *c.find("resolved");
    const bool ok = r.title == str(x.find("title")) && r.subtitle == str(x.find("subtitle")) &&
                    std::string(mp::enumName(r.icon)) == str(x.find("icon")) && r.showIcon == x.find("showIcon")->asBool() &&
                    r.showSubtitle == x.find("showSubtitle")->asBool() && r.custom == x.find("custom")->asBool();
    if (!ok && ++contentBad <= 3) ctx.check(false, "content " + c.find("mode")->asString() + " " + e->id + " matches engine-web");
  }
  ctx.check(contentBad == 0, std::to_string(contentCases) + " content-mode cases match resolveLabelContent");

  // HUD exclusions.
  std::size_t hudBad = 0;
  for (const Value& c : fixture.find("hud")->items()) {
    const Value& insets = *c.find("insets");
    const auto boxes = mp::hudExclusions(num(c.find("vw")), num(c.find("vh")), uiSpecOf(*c.find("ui")),
                                         insets.find("top") ? num(insets.find("top")) : 0.0,
                                         insets.find("bottom") ? num(insets.find("bottom")) : 0.0);
    const auto& want = c.find("boxes")->items();
    bool ok = boxes.size() == want.size();
    for (std::size_t i = 0; ok && i < boxes.size(); ++i) ok = sameBox(boxes[i], boxOf(want[i]));
    hudBad += ok ? 0 : 1;
  }
  ctx.check(hudBad == 0, "hudExclusions matches engine-web (" + std::to_string(hudBad) + " differ)");

  // Greedy holo placement.
  std::size_t holoBad = 0, holoShown = 0;
  for (const Value& set : fixture.find("holo")->items()) {
    std::vector<mp::HoloCandidate> candidates;
    for (const Value& c : set.find("candidates")->items()) {
      mp::HoloCandidate h;
      h.id = c.find("id")->asString();
      h.kind = enumOf<mp::LabelKind>(c.find("kind"));
      h.pri = static_cast<int>(num(c.find("pri")));
      h.dT = num(c.find("dT"));
      h.eligible = c.find("eligible")->asBool();
      h.topX = num(c.find("top")->find("x"));
      h.topY = num(c.find("top")->find("y"));
      h.onScreen = c.find("onScreen")->asBool();
      h.w = num(c.find("w"));
      h.h = num(c.find("h"));
      candidates.push_back(h);
    }
    std::vector<mp::LabelBox> exclusions;
    for (const Value& b : set.find("exclusions")->items()) exclusions.push_back(boxOf(b));
    const auto shown = mp::placeHolo(candidates, exclusions, static_cast<int>(num(set.find("maxRoads"))));
    const auto& want = set.find("shown")->items();
    bool ok = shown.size() == want.size();
    for (std::size_t i = 0; ok && i < shown.size(); ++i) {
      ok = shown[i].first == want[i].find("id")->asString() && sameBox(shown[i].second, boxOf(*want[i].find("box")));
    }
    holoBad += ok ? 0 : 1;
    holoShown += shown.size();
  }
  ctx.check(holoBad == 0, "placeHolo matches engine-web on " + std::to_string(fixture.find("holo")->items().size()) + " sets (" +
                              std::to_string(holoShown) + " cards shown, " + std::to_string(holoBad) + " sets differ)");

  std::size_t bad = 0;
  for (const Value& c : fixture.find("eligible")->items()) {
    const auto& v = c.items();
    bad += mp::holoEligible(enumOf<mp::LabelKind>(&v[0]), v[1].asNumber(), v[2].asNumber()) == v[3].asBool() ? 0 : 1;
  }
  ctx.check(bad == 0, "holoEligible matches engine-web");
  bad = 0;
  for (const Value& c : fixture.find("visible")->items()) {
    const auto& v = c.items();
    bad += mp::domLabelVisible(enumOf<mp::LabelStyle>(&v[0]), enumOf<mp::LabelKind>(&v[1]), static_cast<int>(v[2].asNumber()),
                               v[3].asNumber(), v[4].asNumber()) == v[5].asBool()
               ? 0
               : 1;
  }
  ctx.check(bad == 0, "domLabelVisible matches engine-web");
  bad = 0;
  for (const Value& c : fixture.find("clamp")->items()) {
    const auto& v = c.items();
    const double out = v[3].isNull() ? mp::clampLabelX(v[0].asNumber(), v[1].asNumber(), v[2].asNumber())
                                     : mp::clampLabelX(v[0].asNumber(), v[1].asNumber(), v[2].asNumber(), v[3].asNumber());
    bad += near(out, v[4].asNumber()) ? 0 : 1;
  }
  ctx.check(bad == 0, "clampLabelX matches engine-web (6 dp default margin)");
  bad = 0;
  for (const Value& c : fixture.find("rotated")->items()) {
    const mp::LabelBox b = mp::rotatedBox(num(c.find("x")), num(c.find("y")), num(c.find("w")), num(c.find("h")), num(c.find("angle")));
    bad += sameBox(b, boxOf(*c.find("box"))) ? 0 : 1;
  }
  ctx.check(bad == 0, "rotatedBox matches engine-web");
  bad = 0;
  for (const Value& c : fixture.find("upright")->items()) bad += near(mp::uprightAngle(c.items()[0].asNumber()), c.items()[1].asNumber()) ? 0 : 1;
  ctx.check(bad == 0, "uprightAngle matches engine-web");
  bad = 0;
  for (const Value& c : fixture.find("tiles")->items()) {
    const auto& v = c.items();
    const mp::HoloIconTile tile = v[0].isNull() ? mp::HoloIconTile::Auto : enumOf<mp::HoloIconTile>(&v[0]);
    const char* names[] = {"white", "black", "color"};
    bad += names[static_cast<int>(mp::iconTileFor(tile, v[1].asBool()))] == v[2].asString() ? 0 : 1;
  }
  ctx.check(bad == 0, "iconTileFor matches engine-web");

  const Value& heights = *fixture.find("holoHeight");
  for (const mp::LabelKind k : {mp::LabelKind::Road, mp::LabelKind::District, mp::LabelKind::Poi}) {
    ctx.check(near(mp::holoHeight(k), num(heights.find(mp::enumName(k)))), "HOLO_HEIGHT." + std::string(mp::enumName(k)));
  }
  ctx.check(mp::kHoloMaxRoads == static_cast<int>(num(fixture.find("holoMaxRoads"))), "HOLO_MAX_ROADS");
  ctx.check(mp::kLabelEdgeMargin == num(fixture.find("edgeMargin")), "LABEL_EDGE_MARGIN");

  // Generated tables (scripts/generate-label-icons.mjs) agree with the fixture too.
  for (const mp::json::Member& m : fixture.find("poiSubtitles")->members()) {
    ctx.check(mp::poiSubtitle(*mp::parseEnum<mp::PoiCategory>(m.key)) == m.value.asString(), "POI_SUBTITLES." + m.key);
  }
  for (const mp::json::Member& m : fixture.find("kindSubtitles")->members()) {
    ctx.check(mp::kindSubtitle(*mp::parseEnum<mp::LabelIcon>(m.key)) == m.value.asString(), "KIND_SUBTITLES." + m.key);
  }
  for (const mp::json::Member& m : fixture.find("iconColors")->members()) {
    ctx.check(mp::cssHex(mp::iconColor(*mp::parseEnum<mp::LabelIcon>(m.key))) == m.value.asString(), "ICON_COLORS." + m.key);
  }
  for (std::size_t i = 0; i < mp::EnumNames<mp::LabelIcon>::values.size(); ++i) {
    const auto icon = static_cast<mp::LabelIcon>(i);
    const mp::IconDrawing& d = mp::holoIcon(icon);
    std::size_t coords = 0;
    for (std::size_t s = 0; s < d.shapeCount; ++s) {
      std::size_t want = 0;
      for (const char* op = d.shapes[s].ops; *op != '\0'; ++op) want += *op == 'C' ? 6 : *op == 'Z' ? 0 : 2;
      coords += d.shapes[s].coordCount == want ? 0 : 1;
    }
    ctx.check(d.size == 20.0f && d.shapeCount > 0 && coords == 0, "holo icon " + std::string(mp::enumName(icon)) + " is a 20x20 vector drawing");
    ctx.check((mp::poiGlyph(icon) != nullptr) == (i < mp::EnumNames<mp::PoiCategory>::values.size()), "POI glyph only for POI categories");
  }
  ctx.check(mp::poiGlyph(mp::LabelIcon::Subway)->text != nullptr && std::string(mp::poiGlyph(mp::LabelIcon::Subway)->text) == "M",
            "subway badge glyph is the text M");
}

MAPRAMA_TEST(map_projector_is_the_maplibre_perspective) {
  const double W = 390, H = 500, lat = 37.5445, lng = 127.056;
  const auto pose = [&](double zoom, double pitch, double bearing) {
    mp::MapCameraPose p;
    p.center = mp::LngLat{lng, lat};
    p.zoom = zoom;
    p.pitch = pitch;
    p.bearing = bearing;
    return p;
  };
  const double mpp = cm::mapLibreMetersPerPixel(16, lat);
  const double degPerMeterLng = 1.0 / (111320.0 * std::cos(lat * 3.14159265358979323846 / 180.0));
  {
    const mp::MapProjector p(pose(16, 0, 0), W, H);
    const auto c = p.project(mp::LngLat{lng, lat});
    ctx.check(near(c.x, W / 2, 1e-9) && near(c.y, H / 2, 1e-9) && c.inFront, "centre projects to the view centre");
    const auto e = p.project(mp::LngLat{lng + 100 * mpp * degPerMeterLng, lat});
    ctx.near(e.x - W / 2, 100.0, 0.5, "100 px east (MapLibre ground scale) at pitch 0");
    const auto up = p.project(mp::LngLat{lng, lat}, 50.0);
    ctx.near(up.y, H / 2, 1e-6, "a point above the centre stays at the centre when looking straight down");
  }
  {
    const mp::MapProjector p(pose(16, 0, 90), W, H);
    const auto e = p.project(mp::LngLat{lng + 100 * mpp * degPerMeterLng, lat});
    ctx.near(e.x, W / 2, 0.01, "bearing 90: east is straight ahead (x)");
    ctx.near(e.y, H / 2 - 100, 0.5, "bearing 90: east is up");
  }
  {
    const double pitch = 60, D = 0.5 * H / std::tan(mp::kMapLibreFovRad / 2), s = std::sin(pitch * 3.14159265358979323846 / 180),
                 c = std::cos(pitch * 3.14159265358979323846 / 180);
    const mp::MapProjector p(pose(16, pitch, 0), W, H);
    // A ground point d px north of the centre: y = H/2 - D·d·cos p / (D + d·sin p) (foreshortened, above the centre).
    const double d = 120;
    const double latNorth = lat + d * mpp / 110574.0;  // ~1 px accuracy is enough for this check
    const auto n = p.project(mp::LngLat{lng, latNorth});
    const double mercatorPx = (std::log(std::tan(3.14159265358979323846 / 4 + latNorth * 3.14159265358979323846 / 360)) -
                               std::log(std::tan(3.14159265358979323846 / 4 + lat * 3.14159265358979323846 / 360))) *
                              180 / 3.14159265358979323846 / 360 * 512 * std::pow(2.0, 16);
    ctx.near(n.y, H / 2 - D * mercatorPx * c / (D + mercatorPx * s), 1e-6, "pitched ground point matches the pinhole model");
    ctx.check(n.y < H / 2 && H / 2 - n.y < mercatorPx, "pitched: north is above the centre and foreshortened");
    const auto top = p.project(mp::LngLat{lng, lat}, 100.0);
    ctx.check(top.y < H / 2 && top.inFront, "pitched: a point 100 m above the centre is drawn above it");
    ctx.check(p.project(mp::LngLat{lng, lat + 5.0}).inFront, "a point far ahead (toward the horizon) is in front");
    ctx.check(!p.project(mp::LngLat{lng, lat - 5.0}).inFront, "a point far behind the camera is not in front");
  }
  {
    // Consistency with CameraMath: at pitch 0 the protocol distance d frames 2·d·tan 20° meters over H.
    const double distance = 400;
    const double zoom = cm::distanceToMapLibreZoom(distance, lat, H);
    const mp::MapProjector p(pose(zoom, 0, 0), W, H);
    const double halfSpan = distance * std::tan(20.0 * 3.14159265358979323846 / 180);
    const auto edge = p.project(mp::LngLat{lng, lat + halfSpan / 110574.0});
    ctx.near(edge.y, 0.0, H * 0.01, "distance framing: d·tan 20° north of the target is at the top edge (1 %)");
  }
}

namespace {

/// Answers every pending `measureLabels` with deterministic sizes.
void answerMeasures(Harness& h, std::size_t& answered) {
  for (; answered < h.adapter->measures.size(); ++answered) {
    const auto& [token, items] = h.adapter->measures[answered];
    std::vector<mp::LabelSize> sizes;
    for (const mp::LabelCardContent& c : items) {
      const double chars = static_cast<double>(c.title.size() + (c.showSubtitle ? c.subtitle.size() / 2 : 0));
      sizes.push_back(mp::LabelSize{24 + 5.5 * chars, c.visual == mp::LabelVisual::Holo ? 36.0 : 18.0});
    }
    h.engine->onLabelsMeasured(token, sizes);
  }
}

std::size_t countEvents(const Harness& h, const std::string& type, std::size_t from = 0) { return h.sink->eventsOfType(type, from).size(); }

}  // namespace

MAPRAMA_TEST(labels_session_flow) {
  const Value fixture = maprama::test::loadFixture(ctx, "labels.json");
  const Value* seongsuCase = nullptr;
  for (const Value& wc : fixture.find("worlds")->items()) {
    if (wc.find("name")->asString().find("seongsu") != std::string::npos) seongsuCase = &wc;
  }
  if (!ctx.check(seongsuCase != nullptr, "labels.json has the Seongsu sample")) return;
  const auto& infos = seongsuCase->find("infos")->items();

  Harness h;
  std::size_t answered = 0;
  const Value station = seongsuValue(ctx).find("stations")->items().at(0);
  std::string subwayId;
  for (const Value& info : infos) {
    if (str(info.find("category")) == "subway") subwayId = info.find("id")->asString();
  }
  h.send(initMsg(dataWorld(ctx), std::nullopt, Value::object(), Value::object({{"zoomButtons", true}})));

  // labelsIndex: once per load, engine-web's payload.
  const auto index = h.sink->eventsOfType("labelsIndex");
  ctx.check(index.size() == 1, "init emits one labelsIndex");
  if (!index.empty()) {
    const auto& labels = index[0].find("labels")->items();
    bool same = labels.size() == infos.size();
    for (std::size_t i = 0; same && i < labels.size(); ++i) same = nearJson(labels[i], infos[i]);
    ctx.check(same, "labelsIndex = engine-web's Seongsu labels (" + std::to_string(infos.size()) + ")");
  }

  // Sizes are measured by the platform first; nothing is placed before.
  ctx.check(h.adapter->measures.size() == 1 && h.adapter->measures[0].second.size() > 0, "one measureLabels batch after the load");
  ctx.check(!h.adapter->labelFrames.empty() && h.adapter->labelFrames.back().cards.empty(), "no cards before the sizes are known");
  answerMeasures(h, answered);
  // The station view of the example app.
  const mp::LngLat stationLl = h.engine->worldStore().projection()->toLngLat(mp::WorldPoint{num(station.find("x")), num(station.find("z"))});
  h.send(setCameraMsg(Value::object({{"center", lngLat(stationLl.lng, stationLl.lat)}, {"distance", 300}, {"pitch", 50}, {"bearing", 0}})));
  const mp::LabelFrame holo = h.adapter->labelFrames.back();
  ctx.check(holo.visual == mp::LabelVisual::Holo && holo.tile == mp::LabelTile::White && !holo.night, "default: holo, white tiles by day");
  ctx.check(!holo.cards.empty() && holo.cards.size() <= 60, "holo cards placed (" + std::to_string(holo.cards.size()) + ")");
  std::size_t roads = 0;
  bool inside = true, a11y = true, subway = false;
  const auto exclusions = mp::nativeHudExclusions(390, 500, h.adapter->uis.back());
  std::vector<mp::LabelBox> boxes;
  for (const mp::LabelCard& c : holo.cards) {
    roads += c.content.kind == mp::LabelKind::Road ? 1 : 0;
    inside = inside && c.x - c.width / 2 >= 6 - 1e-9 && c.x + c.width / 2 <= 390 - 6 + 1e-9;
    a11y = a11y && c.content.accessibilityLabel.rfind(c.content.title + ", ", 0) == 0;
    subway = subway || c.id == subwayId;
    const mp::LabelBox box{c.x, c.y, c.width / 2 + 5, c.height / 2 + 4};
    for (const mp::LabelBox& b : boxes) inside = inside && !mp::overlaps(b, box);
    for (const mp::LabelBox& b : exclusions) inside = inside && !mp::overlaps(b, box);
    boxes.push_back(box);
    ctx.check(c.lineY >= c.y + c.height / 2 && c.lineX >= c.x - c.width / 2 && c.lineX <= c.x + c.width / 2,
              "[" + c.id + "] leader line ends under its card");
  }
  ctx.check(roads <= 5, "at most 5 road holo cards");
  ctx.check(inside, "holo cards stay 6 dp inside the edges, off the HUD zones and off each other");
  ctx.check(a11y, "every card has an accessibility label 'name, type'");
  ctx.check(subway, "the station's subway POI (" + subwayId + ") is labelled at the station view");

  // No change -> no new frame.
  const std::size_t framesBefore = h.adapter->labelFrames.size();
  h.engine->frame(0);
  ctx.check(h.adapter->labelFrames.size() == framesBefore, "unchanged placement is not re-sent");

  // setLabels: app style (new sizes measured), no labelsIndex.
  const std::size_t eventsBefore = h.sink->events.size();
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "app"}})}}));
  ctx.check(countEvents(h, "labelsIndex", eventsBefore) == 0, "setLabels does not re-emit labelsIndex (same world)");
  ctx.check(h.adapter->measures.size() == 2, "a new style measures its cards");
  answerMeasures(h, answered);
  const mp::LabelFrame app = h.adapter->labelFrames.back();
  bool rotated = false;
  for (const mp::LabelCard& c : app.cards) rotated = rotated || (c.content.kind == mp::LabelKind::Road && c.angle != 0);
  ctx.check(app.visual == mp::LabelVisual::App && !app.cards.empty(), "app style cards placed (" + std::to_string(app.cards.size()) + ")");
  ctx.check(rotated, "app-style road labels follow the road direction");

  // textOnly: no icons, no subtitles; the accessibility label keeps the type.
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "holo"}, {"content", "textOnly"}})}}));
  answerMeasures(h, answered);
  const mp::LabelFrame text = h.adapter->labelFrames.back();
  bool plain = !text.cards.empty();
  for (const mp::LabelCard& c : text.cards) plain = plain && !c.content.showIcon && !c.content.showSubtitle && c.content.accessibilityLabel.find(", ") != std::string::npos;
  ctx.check(plain, "textOnly cards: no icon, no subtitle, accessibility label still 'name, type'");

  // Custom content by id (entries replace each other).
  h.send(Value::object({{"type", "setLabelContent"},
                        {"entries", Value::object({{subwayId, Value::object({{"title", "성수 ★"}, {"subtitle", "custom"}})}})}}));
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"content", "custom"}})}}));
  answerMeasures(h, answered);
  bool custom = false;
  for (const mp::LabelCard& c : h.adapter->labelFrames.back().cards) {
    if (c.id == subwayId) custom = c.content.title == "성수 ★" && c.content.custom && c.content.subtitle == "custom" && c.content.accessibilityLabel == "성수 ★, custom";
  }
  ctx.check(custom, "custom content applied to the subway label");

  // 3D styles map to the closest view style (warned once).
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "ground"}})}}));
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "ground"}})}}));
  ctx.check(h.sink->countLogs("label style \"ground\" is drawn as \"app\"", mp::LogLevel::Warn) == 1, "ground style warned once");
  ctx.check(h.adapter->labelFrames.back().visual == mp::LabelVisual::App, "ground labels drawn as app labels");
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "sign"}})}}));
  ctx.check(h.adapter->labelFrames.back().visual == mp::LabelVisual::Sticker, "sign labels drawn as sticker labels");

  // Night: auto tiles turn black.
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object()}}));
  h.send(Value::object({{"type", "setTheme"}, {"theme", Value::object({{"timeOfDay", "night"}})}}));
  answerMeasures(h, answered);
  ctx.check(h.adapter->labelFrames.back().night && h.adapter->labelFrames.back().tile == mp::LabelTile::Black, "night: black icon tiles");

  // Disabled: nothing shown.
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"enabled", false}})}}));
  ctx.check(h.adapter->labelFrames.back().cards.empty(), "labels: {enabled: false} hides every card");

  // Detach / attach: unanswered measurements are requested again.
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "clean"}})}}));
  const std::size_t measuresBefore = h.adapter->measures.size();
  h.engine->detachMapAdapter();
  h.engine->attachMapAdapter(h.adapter);
  ctx.check(h.adapter->measures.size() == measuresBefore + 1, "re-attach re-requests the unmeasured cards");
  answered = h.adapter->measures.size() - 1;
  answerMeasures(h, answered);
  ctx.check(h.adapter->labelFrames.back().visual == mp::LabelVisual::Clean && !h.adapter->labelFrames.back().cards.empty(),
            "clean labels placed after re-attach");

  // A second load re-emits labelsIndex.
  const std::size_t before2 = h.sink->events.size();
  h.send(initMsg(dataWorld(ctx)));
  ctx.check(countEvents(h, "labelsIndex", before2) == 1, "every world load emits labelsIndex");
  ctx.check(h.sink->errors() == 0, "no error logs");
  appendEmitted(ctx, *h.sink);
}

// ---------------------------------------------------------------------------------------------------------
// Procedural worlds, name tags and the zoom-out rules
// ---------------------------------------------------------------------------------------------------------

MAPRAMA_TEST(procedural_world_labels_match_engine_web) {
  // labels_index_matches_engine_web compares every entry of the generated worlds; here the session path:
  // `init {world: {kind: "procedural"}}` emits the same labelsIndex and places holo cards.
  const Value fixture = maprama::test::loadFixture(ctx, "labels.json");
  std::size_t cases = 0;
  for (const Value& wc : fixture.find("worlds")->items()) {
    const Value* procedural = wc.find("procedural");
    if (procedural == nullptr) continue;
    ++cases;
    const std::string name = wc.find("name")->asString();
    const auto& infos = wc.find("infos")->items();
    std::size_t districts = 0, pois = 0;
    for (const Value& info : infos) {
      districts += str(info.find("kind")) == "district" ? 1 : 0;
      pois += str(info.find("kind")) == "poi" ? 1 : 0;
    }
    ctx.check(districts > 0 && pois > 0, "[" + name + "] engine-web labels districts and POIs (" + std::to_string(districts) + ", " +
                                             std::to_string(pois) + ")");
    Harness h;
    std::size_t answered = 0;
    h.send(initMsg(Value::object({{"kind", "procedural"}, {"layout", procedural->find("layout")->asString()}, {"seed", procedural->find("seed")->asNumber()}})));
    const auto index = h.sink->eventsOfType("labelsIndex");
    bool same = index.size() == 1 && index[0].find("labels")->items().size() == infos.size();
    for (std::size_t i = 0; same && i < infos.size(); ++i) same = nearJson(index[0].find("labels")->items()[i], infos[i]);
    ctx.check(same, "[" + name + "] init emits engine-web's labelsIndex (" + std::to_string(infos.size()) + " labels)");
    answerMeasures(h, answered);
    // Over the first district (the default framing targets the generator's start, which may have no label nearby).
    for (const Value& info : infos) {
      if (str(info.find("kind")) != "district") continue;
      const Value* ll = info.find("lngLat");
      h.send(setCameraMsg(Value::object({{"center", lngLat(num(ll->find("lng")), num(ll->find("lat")))},
                                         {"distance", 60 * h.engine->worldStore().world()->unitMeters},
                                         {"pitch", 45}})));
      break;
    }
    answerMeasures(h, answered);
    bool district = false;
    if (!h.adapter->labelFrames.empty()) {
      for (const mp::LabelCard& c : h.adapter->labelFrames.back().cards) district = district || c.content.kind == mp::LabelKind::District;
    }
    ctx.check(district, "[" + name + "] a district holo card placed over the district (" +
                            std::to_string(h.adapter->labelFrames.empty() ? 0 : h.adapter->labelFrames.back().cards.size()) + " cards)");
    ctx.check(h.sink->errors() == 0, "[" + name + "] no error logs");
    appendEmitted(ctx, *h.sink);
  }
  ctx.check(cases == 3, "labels.json has the generated town / grid worlds");
}

MAPRAMA_TEST(name_tag_anchor_and_zoom_out_factor_match_engine_web) {
  // engine-web characters.test.ts `nameTagAnchor` cases.
  const auto same = [](const mp::NameTagOffset& a, double dx, double dy, double dz) {
    return near(a.dx, dx, 1e-9) && near(a.dy, dy, 1e-9) && near(a.dz, dz, 1e-9);
  };
  constexpr double kPi = 3.14159265358979323846;
  ctx.check(same(mp::nameTagAnchor(mp::TravelMode::Walk, 1.2), 0, 2.3, 0), "walk: 2.3 above the root");
  ctx.check(same(mp::nameTagAnchor(mp::TravelMode::Bike, 1.2), 0, 2.3, 0), "bike: 2.3 above the root");
  ctx.check(same(mp::nameTagAnchor(mp::TravelMode::Car, 1.2), 0, 2.0, 0), "car: just above the roof (2.0)");
  ctx.check(same(mp::nameTagAnchor(mp::TravelMode::Walk, 0, 2), 0, 4.6, 0), "scaled by the character scale");
  ctx.check(same(mp::nameTagAnchor(mp::TravelMode::Subway, 0), 0, 1.25, -2.2), "subway facing +z: over the middle car behind");
  ctx.check(same(mp::nameTagAnchor(mp::TravelMode::Subway, kPi / 2), -2.2, 1.25, 0), "subway facing +x");
  ctx.check(same(mp::nameTagAnchor(mp::TravelMode::Subway, 0, 1, 0), 0, 2.3, 0), "subway before the train popped in: on the character");
  ctx.check(same(mp::nameTagAnchor(mp::TravelMode::Plane, 0), 0, 1.69 * 0.9 + 0.3, 0), "plane: just above the tail fin");
  ctx.check(same(mp::nameTagAnchor(mp::TravelMode::Plane, 0, 1, 0.5), 0, 2.3, 0), "plane below 0.55 pop-in: on the character");
  // engine-web zoom-out.ts `zoomOutTarget`: smooth01(clamp((d - 55) / 55, 0, 1)), 0 for "none".
  ctx.check(mp::zoomOutFactor(mp::ZoomOutBehavior::None, 200) == 0.0, "zoomOut none: 0");
  ctx.check(mp::zoomOutFactor(mp::ZoomOutBehavior::KeepGameView, 55) == 0.0, "0 at 55 units");
  ctx.check(near(mp::zoomOutFactor(mp::ZoomOutBehavior::KeepGameView, 82.5), 0.5), "0.5 halfway (82.5 units)");
  ctx.check(mp::zoomOutFactor(mp::ZoomOutBehavior::MapColors, 110) == 1.0 && mp::zoomOutFactor(mp::ZoomOutBehavior::MapColors, 400) == 1.0,
            "1 from 110 units");
  const double x = 15.0 / 55.0;
  ctx.check(near(mp::zoomOutFactor(mp::ZoomOutBehavior::KeepGameView, 70), x * x * (3 - 2 * x)), "smoothstep in between");
}

namespace {

const mp::LabelCard* findCard(const mp::LabelFrame& frame, const std::string& id) {
  for (const mp::LabelCard& c : frame.cards) {
    if (c.id == id) return &c;
  }
  return nullptr;
}

}  // namespace

MAPRAMA_TEST(name_tags_session_flow) {
  Harness h;
  std::size_t answered = 0;
  h.send(initMsg(dataWorld(ctx)));
  answerMeasures(h, answered);
  const mp::WorldData& world = *h.engine->worldStore().world();
  const mp::Projection& proj = *h.engine->worldStore().projection();
  const double unit = world.unitMeters;
  const mp::WorldPoint base = world.plaza ? *world.plaza : mp::WorldPoint{0, 0};
  const mp::LngLat at = proj.toLngLat(base);
  const mp::LngLat npcAt = proj.toLngLat(mp::WorldPoint{base.x + 4, base.z});
  const auto camera = [&](double units) {
    h.send(setCameraMsg(Value::object({{"center", lngLat(at.lng, at.lat)}, {"distance", units * unit}, {"pitch", 45}, {"bearing", 0}})));
  };
  camera(40);
  h.send(Value::object({{"type", "upsertCharacters"},
                        {"characters", Value::array({Value::object({{"id", "me"},
                                                                   {"isPlayer", true},
                                                                   {"name", "Traveller"},
                                                                   {"color", "#E0457B"},
                                                                   {"showNameTag", true},
                                                                   {"position", lngLat(at.lng, at.lat)}}),
                                                     Value::object({{"id", "npc"}, {"showNameTag", true}, {"position", lngLat(npcAt.lng, npcAt.lat)}}),
                                                     Value::object({{"id", "quiet"}, {"name", "No tag"}, {"position", lngLat(npcAt.lng, npcAt.lat)}})})}}));
  h.run(48);
  ctx.check(h.sink->countLogs("showNameTag", mp::LogLevel::Warn) == 0, "showNameTag is no longer warn-logged");
  answerMeasures(h, answered);
  h.run(32);
  const mp::LabelFrame frame = h.adapter->labelFrames.back();
  const mp::LabelCard* me = findCard(frame, "tag:me");
  const mp::LabelCard* npc = findCard(frame, "tag:npc");
  if (!ctx.check(me != nullptr && npc != nullptr, "tags of both showNameTag characters placed")) return;
  ctx.check(findCard(frame, "tag:quiet") == nullptr, "no tag without showNameTag");
  ctx.check(me->content.visual == mp::LabelVisual::NameTag && me->content.title == "Traveller" && me->content.player &&
                me->content.color == 0xE0457Bu && me->content.accessibilityLabel == "Traveller",
            "the player's tag: its name, filled with its colour");
  ctx.check(npc->content.title == "npc" && !npc->content.player, "a tag without a name shows the id (white NPC tag)");
  // The character stands at the view centre: the tag hangs above it (anchor 2.3 units up, CSS translate(-50%, -100%)).
  ctx.check(near(me->x, 195, 1e-6) && me->y + me->height / 2 < 250 && me->y + me->height / 2 > 150,
            "the player's tag sits just above the character (bottom at y " + std::to_string(me->y + me->height / 2) + ")");
  ctx.check(&frame.cards.back() == npc || &frame.cards.back() == me, "tags come after the labels (drawn on top)");

  // Tags are character features: shown with labels off, and they follow the character every tick.
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"enabled", false}})}}));
  h.run(32);
  ctx.check(h.adapter->labelFrames.back().cards.size() == 2, "labels off: only the two name tags remain");
  const double meY = findCard(h.adapter->labelFrames.back(), "tag:me")->y;
  // Every game tick re-places only the tags (the label layout is reused); the cost is logged every 5 s.
  h.run(5200);
  ctx.check(h.sink->countLogs("name-tag only", mp::LogLevel::Info) >= 1, "label placement cost logged with name-tag-only passes");

  // engine-web `updateTags`: hidden 95+ world units from the camera …
  camera(90);
  ctx.check(findCard(h.adapter->labelFrames.back(), "tag:me") != nullptr, "90 units away (zoomOut none): shown");
  camera(100);
  ctx.check(findCard(h.adapter->labelFrames.back(), "tag:me") == nullptr, "100 units away: hidden");
  // … and from a 0.6 zoom-out factor on (keepGameView: 0.7 at 90 units).
  h.send(Value::object({{"type", "setTheme"}, {"theme", Value::object({{"zoomOut", "keepGameView"}})}}));
  camera(90);
  ctx.check(findCard(h.adapter->labelFrames.back(), "tag:me") == nullptr, "keepGameView at 90 units (factor 0.7): hidden");
  camera(60);
  answerMeasures(h, answered);
  ctx.check(findCard(h.adapter->labelFrames.back(), "tag:me") != nullptr, "keepGameView at 60 units (factor 0.02): shown");
  camera(40);
  ctx.check(near(findCard(h.adapter->labelFrames.back(), "tag:me")->y, meY, 1e-6), "back at 40 units: the same place");

  // showNameTag: false / removal clear the tags.
  h.send(Value::object({{"type", "upsertCharacters"}, {"characters", Value::array({Value::object({{"id", "npc"}, {"showNameTag", false}})})}}));
  h.run(32);
  ctx.check(findCard(h.adapter->labelFrames.back(), "tag:npc") == nullptr && findCard(h.adapter->labelFrames.back(), "tag:me") != nullptr,
            "showNameTag: false removes that tag only");
  h.send(Value::object({{"type", "removeCharacters"}, {"ids", Value::array({"me", "npc", "quiet"})}}));
  h.run(64);
  ctx.check(h.adapter->labelFrames.back().cards.empty(), "removing the characters clears the tags");
  ctx.check(h.sink->errors() == 0, "no error logs");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(zoom_out_rules_for_district_labels) {
  // engine-web dom-styles.ts: app-style district labels show from a 0.2 zoom-out factor (else beyond 42 units) and
  // their opacity is min(1, 0.45 + zoomOut). A generated town has districts.
  Harness h;
  std::size_t answered = 0;
  h.send(initMsg(Value::object({{"kind", "procedural"}, {"layout", "town"}, {"seed", 42}}), std::nullopt,
                 Value::object({{"zoomOut", "keepGameView"}})));
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"style", "app"}})}}));
  answerMeasures(h, answered);
  const double unit = h.engine->worldStore().world()->unitMeters;
  // Over the first district of the labelsIndex (the default framing targets the generator's start).
  Value center;
  const std::vector<Value> index = h.sink->eventsOfType("labelsIndex");  // kept alive while iterating
  if (!ctx.check(!index.empty(), "init emits labelsIndex")) return;
  for (const Value& info : index.at(0).find("labels")->items()) {
    if (str(info.find("kind")) == "district") {
      center = *info.find("lngLat");
      break;
    }
  }
  if (!ctx.check(center.isObject(), "the generated town has a district label")) return;
  const auto districtOpacity = [&](double units) -> std::optional<double> {
    h.send(setCameraMsg(Value::object({{"center", center}, {"distance", units * unit}, {"pitch", 0}})));
    answerMeasures(h, answered);
    for (const mp::LabelCard& c : h.adapter->labelFrames.back().cards) {
      if (c.content.kind == mp::LabelKind::District) return c.opacity;
    }
    return std::nullopt;
  };
  const std::optional<double> close = districtOpacity(30);
  ctx.check(!close.has_value(), "30 units, factor 0: no district label (dist ≤ 42)");
  const std::optional<double> mid = districtOpacity(70);
  ctx.check(mid.has_value() && near(*mid, 0.45 + mp::zoomOutFactor(mp::ZoomOutBehavior::KeepGameView, 70), 1e-9),
            "70 units: district opacity 0.45 + zoomOut (" + std::to_string(mid.value_or(-1)) + ")");
  const std::optional<double> far = districtOpacity(120);
  ctx.check(far.has_value() && *far == 1.0, "120 units (factor 1): district labels fully opaque");
  h.send(Value::object({{"type", "setTheme"}, {"theme", Value::object()}}));
  const std::optional<double> none = districtOpacity(120);
  ctx.check(none.has_value() && *none == 0.45, "zoomOut none: district labels stay at 0.45");
  ctx.check(h.sink->errors() == 0, "no error logs");
  appendEmitted(ctx, *h.sink);
}

MAPRAMA_TEST(custom_content_for_every_label_keeps_the_cards) {
  // The example's label content function (react-native `evaluateLabelContent`) sends one entry per label of
  // `labelsIndex` and then `content: "custom"`. Every card's content key changes at once: the cards must come
  // back as soon as the new sizes are measured (Maestro 09 showed an empty map here).
  Harness h;
  std::size_t answered = 0;
  h.send(initMsg(dataWorld(ctx)));
  answerMeasures(h, answered);
  const std::vector<Value> index = h.sink->eventsOfType("labelsIndex");
  if (!ctx.check(!index.empty(), "init emits labelsIndex")) return;
  const auto& labels = index.at(0).find("labels")->items();
  const mp::WorldData& world = *h.engine->worldStore().world();
  const mp::Projection& proj = *h.engine->worldStore().projection();
  const mp::WorldPoint station{world.stations.empty() ? mp::WorldPoint{0, 0} : mp::WorldPoint{world.stations[0].x, world.stations[0].z}};
  const mp::LngLat at = proj.toLngLat(station);
  h.send(setCameraMsg(Value::object({{"center", lngLat(at.lng, at.lat)}, {"distance", 300}, {"pitch", 50}, {"bearing", 0}})));
  answerMeasures(h, answered);
  const std::size_t before = h.adapter->labelFrames.back().cards.size();
  ctx.check(before > 0, "holo cards placed before the content switch (" + std::to_string(before) + ")");

  std::string subwayId;
  Value entries = Value::object();
  for (const Value& info : labels) {
    const std::string id = info.find("id")->asString();
    const std::string name = info.find("name")->asString();
    Value entry = Value::object({{"title", name + " \xe2\x98\x85"}});
    if (str(info.find("kind")) == "poi") {
      const bool subway = str(info.find("category")) == "subway";
      entry.set("subtitle", subway ? std::string("\xec\xa7\x80\xed\x95\x98\xec\xb2\xa0 \xc2\xb7 custom") : std::string("custom"));
      if (subway) subwayId = id;
    }
    entries.set(id, std::move(entry));
  }
  // react-native's order (MapramaView props effect): `setLabels` with the new mode first, then the entries the
  // content function produced (CommandBatcher flush).
  h.send(Value::object({{"type", "setLabels"}, {"labels", Value::object({{"content", "custom"}})}}));
  answerMeasures(h, answered);
  h.send(Value::object({{"type", "setLabelContent"}, {"entries", entries}}));
  answerMeasures(h, answered);
  const mp::LabelFrame frame = h.adapter->labelFrames.back();
  ctx.check(!frame.cards.empty(), "cards are placed again after every label got custom content (" +
                                      std::to_string(frame.cards.size()) + " cards, was " + std::to_string(before) + ")");
  bool custom = false, allCustom = !frame.cards.empty();
  for (const mp::LabelCard& c : frame.cards) {
    allCustom = allCustom && c.content.custom;
    if (c.id == subwayId) custom = c.content.title.find("\xe2\x98\x85") != std::string::npos && c.content.custom;
  }
  ctx.check(allCustom, "every placed card uses the host content");
  // Frames reach the platform from two threads (camera reports vs commands / game ticks): each one must carry a
  // newer sequence so a posted, older frame cannot wipe the cards (Maestro 09 showed exactly that).
  std::uint64_t last = 0;
  bool increasing = !h.adapter->labelFrames.empty();
  for (const mp::LabelFrame& f : h.adapter->labelFrames) {
    increasing = increasing && f.sequence > last;
    last = f.sequence;
  }
  ctx.check(increasing, "every label frame carries a newer sequence (" + std::to_string(h.adapter->labelFrames.size()) + " frames)");
  ctx.check(subwayId.empty() || custom, "the station's subway card shows the custom title");
  ctx.check(h.sink->errors() == 0, "no error logs");
  appendEmitted(ctx, *h.sink);
}
